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
import { effectiveWorkspaceVariables } from "../../src/lib/effective-variables";
import { agentEnvironment } from "../../src/lib/agent-api";

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

  it("lexically earliest non-priority set wins ties within the same tier", async () => {
    // Equal-scope variable sets follow the reference format's deterministic
    // lexical precedence: the earliest set name wins, with id as a tie-breaker.
    const lowerIdSet = `vs-lower-${suffix}`;
    const higherIdSet = `vs-higher-${suffix}`;
    await db.insert(variableSets).values({ id: lowerIdSet, orgId, name: "aaa-earlier-name", global: false, priority: false });
    await db.insert(variableSets).values({ id: higherIdSet, orgId, name: "zzz-later-name", global: false, priority: false });
    await db.insert(variableSetWorkspaces).values([
      { id: `link-lower-${suffix}`, variableSetId: lowerIdSet, workspaceId: wsId },
      { id: `link-higher-${suffix}`, variableSetId: higherIdSet, workspaceId: wsId },
    ]);
    // Higher id (vsv-zzz) is on the set with the lexically LATER name.
    await db.insert(variableSetVariables).values({ id: `vsv-zzz-${suffix}`, variableSetId: higherIdSet, key: "tier", value: "later-name-loses", category: "terraform" });
    await db.insert(variableSetVariables).values({ id: `vsv-aaa-${suffix}`, variableSetId: lowerIdSet, key: "tier", value: "earlier-name-wins", category: "terraform" });

    const m = asMap(await executionVariables(wsId, orgId, null));
    // The lexically earlier set wins regardless of insertion/id order.
    expect(m.get("terraform:tier")).toBe("earlier-name-wins#priority=false");

  });

  it("renaming a set moves its rank: the winner follows the live name (issue #704)", async () => {
    const winner = `vs-rename-w-${suffix}`;
    const loser = `vs-rename-l-${suffix}`;
    await db.insert(variableSets).values([
      { id: winner, orgId, name: "aaa-keeps-winning", global: false, priority: false },
      { id: loser, orgId, name: "zzz-initially-loses", global: false, priority: false },
    ]);
    await db.insert(variableSetWorkspaces).values([
      { id: `link-rename-w-${suffix}`, variableSetId: winner, workspaceId: wsId },
      { id: `link-rename-l-${suffix}`, variableSetId: loser, workspaceId: wsId },
    ]);
    await db.insert(variableSetVariables).values([
      { id: `vsv-rename-w-${suffix}`, variableSetId: winner, key: "renamed", value: "from-aaa", category: "terraform" },
      { id: `vsv-rename-l-${suffix}`, variableSetId: loser, key: "renamed", value: "from-zzz", category: "terraform" },
    ]);

    const before = asMap(await executionVariables(wsId, orgId, null));
    expect(before.get("terraform:renamed")).toBe("from-aaa#priority=false");

    // Rename the loser ahead of the winner: ranking follows the live name.
    await db.update(variableSets).set({ name: "000-now-earlier" }).where(eq(variableSets.id, loser));
    const after = asMap(await executionVariables(wsId, orgId, null));
    expect(after.get("terraform:renamed")).toBe("from-zzz#priority=false");

    // The display view names the same winning set.
    const displayed = await effectiveWorkspaceVariables(wsId, orgId, null);
    const entry = displayed.find((row) => row.variable.key === "renamed");
    if (entry?.source !== "varset") throw new Error("expected renamed to come from a set");
    expect(entry.setName).toBe("000-now-earlier");
    expect(entry.variable.value).toBe("from-zzz");

  });

  it("project move swaps which project-linked sets apply (issue #704)", async () => {
    const projectB = `proj-b-${suffix}`;
    await db.insert(projects).values({ id: projectB, orgId, name: `precedence-projb-${suffix}` });
    try {
      const setA = `vs-move-a-${suffix}`;
      const setB = `vs-move-b-${suffix}`;
      await db.insert(variableSets).values([
        { id: setA, orgId, name: "move-set-a", global: false, priority: false },
        { id: setB, orgId, name: "move-set-b", global: false, priority: false },
      ]);
      await db.insert(variableSetProjects).values([
        { id: `link-move-a-${suffix}`, variableSetId: setA, projectId },
        { id: `link-move-b-${suffix}`, variableSetId: setB, projectId: projectB },
      ]);
      await db.insert(variableSetVariables).values([
        { id: `vsv-move-a-${suffix}`, variableSetId: setA, key: "moved", value: "from-project-a", category: "terraform" },
        { id: `vsv-move-b-${suffix}`, variableSetId: setB, key: "moved", value: "from-project-b", category: "terraform" },
      ]);

      const inA = asMap(await executionVariables(wsId, orgId, projectId));
      expect(inA.get("terraform:moved")).toBe("from-project-a#priority=false");
      const inB = asMap(await executionVariables(wsId, orgId, projectB));
      expect(inB.get("terraform:moved")).toBe("from-project-b#priority=false");

      // Moving the workspace row flips the live resolution: callers pass
      // workspace.projectId on every plan/apply (worker plan/apply paths).
      await db.update(workspaces).set({ projectId: projectB }).where(eq(workspaces.id, wsId));
      const moved = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
      expect(moved?.projectId).toBe(projectB);
      const afterMove = asMap(await executionVariables(wsId, orgId, moved?.projectId ?? null));
      expect(afterMove.get("terraform:moved")).toBe("from-project-b#priority=false");
    } finally {
      await db.update(workspaces).set({ projectId: null }).where(eq(workspaces.id, wsId));
      await db.delete(projects).where(eq(projects.id, projectB));
    }

  });

  it("a set attached through workspace and project paths wins once, not twice (issue #704)", async () => {
    const set = `vs-dupe-${suffix}`;
    await db.insert(variableSets).values({ id: set, orgId, name: "dupe-attached", global: false, priority: false });
    await db.insert(variableSetWorkspaces).values({ id: `link-dupe-ws-${suffix}`, variableSetId: set, workspaceId: wsId });
    await db.insert(variableSetProjects).values({ id: `link-dupe-proj-${suffix}`, variableSetId: set, projectId });
    await db.insert(variableSetVariables).values({ id: `vsv-dupe-${suffix}`, variableSetId: set, key: "dupekey", value: "once", category: "terraform" });

    const executed = await executionVariables(wsId, orgId, projectId);
    expect(executed.filter((entry) => entry.key === "dupekey")).toHaveLength(1);
    expect(asMap(executed).get("terraform:dupekey")).toBe("once#priority=false");

    const displayed = await effectiveWorkspaceVariables(wsId, orgId, projectId);
    expect(displayed.filter((row) => row.variable.key === "dupekey")).toHaveLength(1);

  });

  it("code-point comparison orders case and non-ASCII deterministically (issue #704)", async () => {
    const { compareCodePoints } = await import("../../src/lib/variable-set-precedence");
    // Uppercase sorts before lowercase in code points; supplementary-plane
    // characters sort after the BMP (UTF-16 comparison would disagree).
    expect(compareCodePoints("B", "a")).toBeLessThan(0);
    expect(compareCodePoints("a", "B")).toBeGreaterThan(0);
    expect(compareCodePoints("z", "𝌆")).toBeLessThan(0);
    expect(compareCodePoints("é", "Ω")).toBeLessThan(0);
    expect(compareCodePoints("same", "same")).toBe(0);

  });

  it("display order follows code points across letter case (issue #704)", async () => {
    // localeCompare collates "apple" before "Banana"; code points put "B"
    // (0x42) first. The display list must match execution byte order.
    await db.insert(workspaceVariables).values([
      { id: `wv-case-a-${suffix}`, workspaceId: wsId, key: "apple", value: "lower", category: "terraform" },
      { id: `wv-case-b-${suffix}`, workspaceId: wsId, key: "Banana", value: "upper", category: "terraform" },
    ]);
    const displayed = await effectiveWorkspaceVariables(wsId, orgId, null);
    expect(displayed.map((row) => row.variable.key)).toEqual(["Banana", "apple"]);

  });

  it("one set cannot hold the same key twice, so row-id ties cannot occur (issue #704)", async () => {
    // The UNIQUE(variable_set_id, key) invariant is what makes the row-id
    // tie-break unreachable for winner selection; pin it so a future
    // migration dropping the constraint visibly breaks this contract.
    const set = `vs-unique-${suffix}`;
    await db.insert(variableSets).values({ id: set, orgId, name: "unique-guard", global: false, priority: false });
    await db.insert(variableSetVariables).values({ id: `vsv-unique-1-${suffix}`, variableSetId: set, key: "only", value: "first", category: "terraform" });
    let rejected: unknown = null;
    try {
      await db.insert(variableSetVariables).values({ id: `vsv-unique-2-${suffix}`, variableSetId: set, key: "only", value: "second", category: "terraform" });
    } catch (error: unknown) {
      rejected = error;
    }
    expect(rejected).not.toBeNull();

  });

  it("agent execution resolves the same winners regardless of sensitivity (issue #691)", async () => {
    const set = `vs-agent-${suffix}`;
    await db.insert(variableSets).values({ id: set, orgId, name: "agent-priority", global: false, priority: true });
    await db.insert(variableSetWorkspaces).values({ id: `link-agent-${suffix}`, variableSetId: set, workspaceId: wsId });
    await db.insert(variableSetVariables).values({ id: `vsv-agent-${suffix}`, variableSetId: set, key: "fixed", value: "priority", category: "terraform" });
    await db.insert(workspaceVariables).values({ id: `wv-agent-${suffix}`, workspaceId: wsId, key: "region", value: "workspace", category: "terraform" });

    for (const sensitive of [false, true]) {
      const env = await agentEnvironment(wsId, orgId, null, [
        { key: "region", value: "run", sensitive },
        { key: "fixed", value: "run", sensitive },
        { key: "RUN_ENV", value: "run-env", category: "env", sensitive },
      ]);
      // Run beats workspace, priority beats run, env travels verbatim —
      // identically whether the run values are sensitive or not.
      expect(env["TF_VAR_region"]).toBe("run");
      expect(env["TF_VAR_fixed"]).toBe("priority");
      expect(env["RUN_ENV"]).toBe("run-env");
      expect(env["TF_VAR_RUN_ENV"]).toBeUndefined();
    }

  });
});
