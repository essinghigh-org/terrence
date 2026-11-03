import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  organizations,
  workspaces,
  runs,
  policySets,
  policySetWorkspaces,
  policySetExclusions,
  agentPools,
  agents,
  agentJobs,
  logs,
} from "../../src/db/schema";
import { workspacePolicyExecutionError } from "../../src/lib/workspace-policy-gate";
import { claimAgentJob } from "../../src/lib/agent-jobs";
import { executeApply } from "../../src/worker";

const orgIds: string[] = [];
afterEach(async () => {
  for (const id of orgIds.splice(0)) await db.delete(organizations).where(eq(organizations.id, id));
});
async function fixture() {
  const id = crypto.randomUUID();
  orgIds.push(id);
  await db.insert(organizations).values({ id, name: id });
  await db.insert(workspaces).values({ id, orgId: id, name: id });
  await db.insert(runs).values({ id, workspaceId: id, status: "apply_queued", createdAt: Date.now() });
  // The plan has already succeeded. A new policy now applies to this workspace.
  await db.insert(policySets).values({ id, orgId: id, name: "new policy", kind: "tfpolicy" });
  await db.insert(policySetWorkspaces).values({ id, policySetId: id, workspaceId: id });
  return id;
}

test("apply guard resolves current scope and honors exclusions", async () => {
  const id = await fixture();
  expect(await workspacePolicyExecutionError(db, { id, orgId: id })).toContain("tfpolicy runtime is not supported");
  await db.insert(policySetExclusions).values({ id, policySetId: id, workspaceId: id });
  expect(await workspacePolicyExecutionError(db, { id, orgId: id })).toBeNull();
});

test("hosted apply blocks a tfpolicy set attached after plan before preparing apply artifacts", async () => {
  const id = await fixture();
  await executeApply(id);
  expect((await db.query.runs.findFirst({ where: eq(runs.id, id) }))?.status).toBe("errored");
  const output = await db.query.logs.findMany({ where: eq(logs.runId, id) });
  expect(output.some((row) => row.outputText.includes("tfpolicy runtime is not supported"))).toBe(true);
  expect((await db.query.workspaces.findFirst({ where: eq(workspaces.id, id) }))?.locked).toBe(false);
});

test("agent apply claim blocks a tfpolicy set attached after plan before handoff", async () => {
  const id = await fixture();
  await db.insert(agentPools).values({ id, orgId: id, name: id, organizationScoped: true });
  await db.insert(agents).values({ id, agentPoolId: id, name: id, status: "idle", lastPingAt: Date.now() });
  await db.insert(agentJobs).values({ id, runId: id, agentPoolId: id, phase: "apply", status: "queued" });
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
  expect(agent).toBeDefined();
  expect(await claimAgentJob(agent!)).toBeUndefined();
  expect(await db.query.agentJobs.findFirst({ where: eq(agentJobs.id, id) })).toMatchObject({
    status: "errored",
    errorMessage: expect.stringContaining("tfpolicy runtime is not supported"),
  });
  expect((await db.query.runs.findFirst({ where: eq(runs.id, id) }))?.status).toBe("errored");
  expect((await db.query.workspaces.findFirst({ where: eq(workspaces.id, id) }))?.locked).toBe(false);
});
