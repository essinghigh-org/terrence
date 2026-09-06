import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  organizations,
  variableSets,
  variableSetVariables,
  variableSetWorkspaces,
  workspaces,
  workspaceVariables,
} from "../../src/db/schema";
import { agentEnvironment } from "../../src/lib/agent-api";
import { executionVariables } from "../../src/worker";
import { compareVariableSets } from "../../src/lib/variable-set-precedence";
import { effectiveWorkspaceVariables } from "../../src/lib/effective-variables";

// Issue #627: same-rank ties, workspace-vs-set, and priority precedence must
// resolve deterministically, and inherited winners must name their set.
describe("effectiveWorkspaceVariables precedence", (): void => {
  const suffix = crypto.randomUUID();
  const orgId = "prec-org-" + suffix;
  const workspaceId = "prec-ws-" + suffix;
  const alphaId = "prec-alpha-" + suffix;
  const betaId = "prec-beta-" + suffix;
  const prioId = "prec-prio-" + suffix;

  afterAll(async (): Promise<void> => {
    await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspaceId));
    await db.delete(variableSetVariables).where(eq(variableSetVariables.variableSetId, alphaId));
    await db.delete(variableSetVariables).where(eq(variableSetVariables.variableSetId, betaId));
    await db.delete(variableSetVariables).where(eq(variableSetVariables.variableSetId, prioId));
    await db.delete(variableSetWorkspaces).where(eq(variableSetWorkspaces.workspaceId, workspaceId));
    await db.delete(variableSets).where(eq(variableSets.orgId, orgId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("resolves winners and names the winning set", async (): Promise<void> => {
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId });
    await db.insert(variableSets).values([
      { id: alphaId, orgId, name: "alpha" },
      { id: betaId, orgId, name: "beta" },
      { id: prioId, orgId, name: "zzz-priority", priority: true },
    ]);
    for (const setId of [alphaId, betaId, prioId]) {
      await db.insert(variableSetWorkspaces).values({ id: "link-" + setId, variableSetId: setId, workspaceId });
    }
    // Same key in both same-rank sets: the alphabetically-first set wins.
    await db.insert(variableSetVariables).values([
      { id: "var-alpha-dup", variableSetId: alphaId, key: "DUP", value: "from-alpha" },
      { id: "var-beta-dup", variableSetId: betaId, key: "DUP", value: "from-beta" },
      { id: "var-alpha-only", variableSetId: alphaId, key: "ALPHA_ONLY", value: "a" },
      { id: "var-prio-ws", variableSetId: prioId, key: "WS_BEATEN", value: "from-priority" },
    ]);
    // Workspace beats non-priority sets but loses to priority sets.
    await db.insert(workspaceVariables).values([
      { id: "ws-dup", workspaceId, key: "DUP", value: "from-workspace" },
      { id: "ws-beaten", workspaceId, key: "WS_BEATEN", value: "from-workspace" },
      { id: "ws-only", workspaceId, key: "WS_ONLY", value: "w" },
    ]);

    const effective = await effectiveWorkspaceVariables(workspaceId, orgId, null);
    const byKey = new Map(effective.map((entry) => [entry.variable.key, entry]));

    const dup = byKey.get("DUP");
    expect(dup?.source).toBe("workspace");
    const beaten = byKey.get("WS_BEATEN");
    expect(beaten?.source).toBe("varset");
    if (beaten?.source !== "varset") throw new Error("expected WS_BEATEN to come from a set");
    expect(beaten.setName).toBe("zzz-priority");
    expect(beaten.variable.value).toBe("from-priority");
    expect(byKey.get("ALPHA_ONLY")?.source).toBe("varset");
    expect(byKey.get("WS_ONLY")?.source).toBe("workspace");

    // Without the workspace row, the same-rank tie names its winner.
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, "ws-dup"));
    const noWorkspace = await effectiveWorkspaceVariables(workspaceId, orgId, null);
    const tie = new Map(noWorkspace.map((entry) => [entry.variable.key, entry])).get("DUP");
    expect(tie?.source).toBe("varset");
    if (tie?.source !== "varset") throw new Error("expected DUP to come from a set");
    expect(tie.setName).toBe("alpha");
    expect(tie.variable.value).toBe("from-alpha");
    // Priority global wins even over priority workspace scope, for both views.
    await db.update(variableSets).set({ global: true, priority: true }).where(eq(variableSets.id, betaId));
    const displayed = await effectiveWorkspaceVariables(workspaceId, orgId, null);
    const executed = await executionVariables(workspaceId, orgId, null);
    expect(displayed.find((entry) => entry.variable.key === "DUP")?.variable.value).toBe("from-beta");
    expect(executed.find((entry) => entry.key === "DUP")?.value).toBe("from-beta");
    const agent = await agentEnvironment(workspaceId, orgId, null, [
      { key: "DUP", value: "run", sensitive: true },
      { key: "RUN_ONLY", value: "run", sensitive: true },
      { key: "RUN_ENV", value: "environment", category: "env" },
    ]);
    expect(agent["TF_VAR_DUP"]).toBe("from-beta");
    expect(agent["TF_VAR_RUN_ONLY"]).toBe("run");
    expect(agent["RUN_ENV"]).toBe("environment");
  });
});


test("variable set ordering covers scope, ownership, priority and Unicode ties", () => {
  const sets = [
    { id: "g", global: true, parentProjectId: null },
    { id: "op", global: false, parentProjectId: null },
    { id: "ow", global: false, parentProjectId: null },
    { id: "pp", global: false, parentProjectId: "project" },
    { id: "pw", global: false, parentProjectId: "project" },
  ].map((set) => ({ ...set, name: set.id, priority: false }));
  const workspaceLinks = new Set(["ow", "pw"]);
  const projectLinks = new Set(["op", "pp"]);
  const compare = (left: typeof sets[number], right: typeof sets[number]) => compareVariableSets(left, right, workspaceLinks, projectLinks);
  expect([...sets].reverse().sort(compare).map((set) => set.id)).toEqual(["g", "op", "ow", "pp", "pw"]);
  expect(sets.map((set) => ({ ...set, priority: true })).sort(compare).map((set) => set.id)).toEqual(["pw", "pp", "ow", "op", "g"]);
  const names = ["a", "A", "_", "é", "\uE000", "😀"];
  expect(names.map((name) => ({ id: name, name, priority: false, global: true, parentProjectId: null })).sort(compare).map((set) => set.name))
    .toEqual(["😀", "\uE000", "é", "a", "_", "A"]);
});
