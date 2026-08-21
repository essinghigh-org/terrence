import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { eq, like } from "drizzle-orm";
import { db } from "../../src/db";
import {
  organizations,
  projects,
  variableSetProjects,
  variableSets,
  variableSetVariables,
  variableSetWorkspaces,
  workspaceVariables,
  workspaces,
} from "../../src/db/schema";
import { executionVariables } from "../../src/worker";

// VAR-005: executable variable precedence matrix.
//
// the reference format resolution order (lowest -> highest precedence):
//   1. non-priority variable set variables
//   2. workspace variables
//   3. priority variable set variables
//
// `terraform` and `env` category variables share a key namespace separately
// (the effective map is keyed by `category:key`), so a `terraform` var and an
// `env` var with the same name do not collide. This suite pins every tier
// transition plus same-key-different-category isolation directly against the
// exported `executionVariables` resolver used by the run worker.

const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const orgId = `org-precedence-${suffix}`;
const wsId = `ws-precedence-${suffix}`;
const projectId = `proj-precedence-${suffix}`;

const asMap = (vars: Awaited<ReturnType<typeof executionVariables>>) => {
  const m = new Map<string, string>();
  for (const v of vars) m.set(`${v.category}:${v.key}`, `${v.value}#priority=${v.priority}`);
  return m;
};

// Defensive teardown: every fixture row for this suite carries the shared
// suffix, so deleting by suffix clears any rows left behind by a test that
// failed before its inline cleanup ran. Runs after each test (including
// failures) and again at suite end.
const teardownSuiteRows = async (): Promise<void> => {
  await db.delete(variableSetVariables).where(like(variableSetVariables.id, `%${suffix}%`));
  await db.delete(variableSetWorkspaces).where(like(variableSetWorkspaces.id, `%${suffix}%`));
  await db.delete(variableSetProjects).where(like(variableSetProjects.id, `%${suffix}%`));
  await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, wsId));
  await db.delete(variableSets).where(like(variableSets.id, `%${suffix}%`));
};

describe("variable precedence matrix (VAR-005)", () => {
  beforeAll(async () => {
    await db.insert(organizations).values({ id: orgId, name: `precedence-${suffix}` });
    await db.insert(projects).values({ id: projectId, orgId, name: `precedence-proj-${suffix}` });
    await db.insert(workspaces).values({ id: wsId, name: `precedence-${suffix}`, orgId });
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  // Defensive teardown: every fixture row for this suite carries the shared
  // suffix, so deleting by suffix clears any rows left behind by a test that
  // failed before its inline cleanup ran. Runs after each test (including
  // failures).
  afterEach(async () => {
    await teardownSuiteRows();
  });

  it("workspace variable overrides a non-priority variable set (tier 1 -> 2)", async () => {
    const set = `vs-np-${suffix}`;
    const wsVar = `wv-np-${suffix}`;
    await db.insert(variableSets).values({ id: set, orgId, name: "non-priority", global: false, priority: false });
    await db.insert(variableSetWorkspaces).values({ id: `link-${suffix}`, variableSetId: set, workspaceId: wsId });
    await db.insert(variableSetVariables).values({ id: `vsv-np-${suffix}`, variableSetId: set, key: "region", value: "set-value", category: "terraform" });
    await db.insert(workspaceVariables).values({ id: wsVar, workspaceId: wsId, key: "region", value: "workspace-value", category: "terraform" });

    const m = asMap(await executionVariables(wsId, orgId, null));
    expect(m.get("terraform:region")).toBe("workspace-value#priority=false");

  });

  it("priority variable set overrides a workspace variable (tier 2 -> 3)", async () => {
    const set = `vs-pri-${suffix}`;
    const wsVar = `wv-pri-${suffix}`;
    await db.insert(variableSets).values({ id: set, orgId, name: "priority", global: false, priority: true });
    await db.insert(variableSetWorkspaces).values({ id: `link-pri-${suffix}`, variableSetId: set, workspaceId: wsId });
    await db.insert(variableSetVariables).values({ id: `vsv-pri-${suffix}`, variableSetId: set, key: "region", value: "priority-value", category: "terraform" });
    await db.insert(workspaceVariables).values({ id: wsVar, workspaceId: wsId, key: "region", value: "workspace-value", category: "terraform" });

    const m = asMap(await executionVariables(wsId, orgId, null));
    expect(m.get("terraform:region")).toBe("priority-value#priority=true");

  });

  it("full tier chain: non-priority < workspace < priority for the same key", async () => {
    const np = `vs-chain-np-${suffix}`;
    const pri = `vs-chain-pri-${suffix}`;
    const wsVar = `wv-chain-${suffix}`;
    await db.insert(variableSets).values([
      { id: np, orgId, name: "chain-np", global: false, priority: false },
      { id: pri, orgId, name: "chain-pri", global: false, priority: true },
    ]);
    await db.insert(variableSetWorkspaces).values([
      { id: `link-chain-np-${suffix}`, variableSetId: np, workspaceId: wsId },
      { id: `link-chain-pri-${suffix}`, variableSetId: pri, workspaceId: wsId },
    ]);
    await db.insert(variableSetVariables).values([
      { id: `vsv-chain-np-${suffix}`, variableSetId: np, key: "env", value: "from-non-priority", category: "terraform" },
      { id: `vsv-chain-pri-${suffix}`, variableSetId: pri, key: "env", value: "from-priority", category: "terraform" },
    ]);
    await db.insert(workspaceVariables).values({ id: wsVar, workspaceId: wsId, key: "env", value: "from-workspace", category: "terraform" });

    const m = asMap(await executionVariables(wsId, orgId, null));
    expect(m.get("terraform:env")).toBe("from-priority#priority=true");

  });

  it("global variable set applies without an explicit workspace link", async () => {
    const set = `vs-global-${suffix}`;
    await db.insert(variableSets).values({ id: set, orgId, name: "global-set", global: true, priority: false });
    await db.insert(variableSetVariables).values({ id: `vsv-global-${suffix}`, variableSetId: set, key: "shared", value: "global-value", category: "terraform" });

    const m = asMap(await executionVariables(wsId, orgId, null));
    expect(m.get("terraform:shared")).toBe("global-value#priority=false");

  });

  it("project-linked variable set applies through projectId", async () => {
    const set = `vs-proj-${suffix}`;
    await db.insert(variableSets).values({ id: set, orgId, name: "project-set", global: false, priority: false });
    await db.insert(variableSetProjects).values({ id: `link-proj-${suffix}`, variableSetId: set, projectId });
    await db.insert(variableSetVariables).values({ id: `vsv-proj-${suffix}`, variableSetId: set, key: "fromProject", value: "project-value", category: "terraform" });

    const m = asMap(await executionVariables(wsId, orgId, projectId));
    expect(m.get("terraform:fromProject")).toBe("project-value#priority=false");

    // Same set is invisible when the workspace has no project.
    const withoutProject = asMap(await executionVariables(wsId, orgId, null));
    expect(withoutProject.get("terraform:fromProject")).toBeUndefined();

  });

  it("terraform and env vars with the same key resolve independently", async () => {
    const wsVarTf = `wv-tf-${suffix}`;
    const wsVarEnv = `wv-env-${suffix}`;
    await db.insert(workspaceVariables).values([
      { id: wsVarTf, workspaceId: wsId, key: "dupe", value: "terraform-value", category: "terraform" },
      { id: wsVarEnv, workspaceId: wsId, key: "dupe", value: "env-value", category: "env" },
    ]);

    const m = asMap(await executionVariables(wsId, orgId, null));
    expect(m.get("terraform:dupe")).toBe("terraform-value#priority=false");
    expect(m.get("env:dupe")).toBe("env-value#priority=false");

  });

  it("later-inserted non-priority set wins ties within the same tier", async () => {
    // The resolver iterates variableSetVariables ordered by id ascending and
    // last-write-wins, so the set with the HIGHEST variableSetVariables id
    // wins. To prove the resolution follows id/insertion order and NOT
    // lexical set name, the winning set (higher id) carries a lexically LATER
    // name while the losing set (lower id) carries a lexically EARLIER name. A
    // name-ordered resolver would pick the opposite result.
    const lowerIdSet = `vs-lower-${suffix}`;
    const higherIdSet = `vs-higher-${suffix}`;
    await db.insert(variableSets).values({ id: lowerIdSet, orgId, name: "aaa-earlier-name", global: false, priority: false });
    await db.insert(variableSets).values({ id: higherIdSet, orgId, name: "zzz-later-name", global: false, priority: false });
    await db.insert(variableSetWorkspaces).values([
      { id: `link-lower-${suffix}`, variableSetId: lowerIdSet, workspaceId: wsId },
      { id: `link-higher-${suffix}`, variableSetId: higherIdSet, workspaceId: wsId },
    ]);
    // Higher id (vsv-zzz) on the set with the lexically LATER name.
    await db.insert(variableSetVariables).values({ id: `vsv-zzz-${suffix}`, variableSetId: higherIdSet, key: "tier", value: "higher-id-wins", category: "terraform" });
    await db.insert(variableSetVariables).values({ id: `vsv-aaa-${suffix}`, variableSetId: lowerIdSet, key: "tier", value: "lower-id-loses", category: "terraform" });

    const m = asMap(await executionVariables(wsId, orgId, null));
    // vsv-zzz (higher id, later name) overwrites vsv-aaa (lower id, earlier name).
    expect(m.get("terraform:tier")).toBe("higher-id-wins#priority=false");

  });
});
