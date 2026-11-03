import { beforeAll, afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  organizations,
  projects,
  stacks,
  policySets,
  policySetStacks,
  policySetProjects,
  policySetProjectExclusions,
  policySetTagSelectors,
  stackRecords,
  stackAgentJobs,
  agents,
  agentPools,
} from "../../src/db/schema";
import { stackPolicyExecutionError } from "../../src/lib/stack-policy-gate";
import { runStackDeploymentJob } from "../../src/lib/stack-worker";
import { claimStackAgentJob } from "../../src/lib/stack-agent-jobs";
import type { DurableJob } from "../../src/lib/durable-jobs";
const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`,
  psId = `ps-${suffix}`,
  projectId = `prj-${suffix}`;
const stack = { id: `st-${suffix}`, orgId, projectId };
beforeAll(async () => {
  await db.insert(organizations).values({ id: orgId, name: orgId });
  await db.insert(projects).values({ id: projectId, orgId, name: "test" });
  await db.insert(stacks).values({ ...stack, name: "test" });
  await db.insert(policySets).values({ id: psId, orgId, name: "blocking", kind: "tfpolicy" });
});
afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
});
test("only applicable policy scope blocks; exclusions are honored", async () => {
  expect(await stackPolicyExecutionError(stack)).toBeNull();
  await db.insert(policySetStacks).values({ id: `link-${suffix}`, policySetId: psId, stackId: stack.id });
  expect(await stackPolicyExecutionError(stack)).toContain("tfpolicy runtime is not supported");
  await db.delete(policySetStacks).where(eq(policySetStacks.policySetId, psId));
  await db.insert(policySetProjects).values({ id: `prjlink-${suffix}`, policySetId: psId, projectId });
  expect(await stackPolicyExecutionError(stack)).toContain(psId);
  await db.delete(policySetProjects).where(eq(policySetProjects.policySetId, psId));
  await db.update(policySets).set({ global: true }).where(eq(policySets.id, psId));
  expect(await stackPolicyExecutionError(stack)).toContain(psId);
  await db.insert(policySetProjectExclusions).values({ id: `pex-${suffix}`, policySetId: psId, projectId });
  expect(await stackPolicyExecutionError(stack)).toBeNull();
  await db.delete(policySetProjectExclusions).where(eq(policySetProjectExclusions.policySetId, psId));
  await db
    .insert(policySetStacks)
    .values({ id: `sex-${suffix}`, policySetId: psId, stackId: stack.id, isExclude: true });
  expect(await stackPolicyExecutionError(stack)).toBeNull();
  await db.delete(policySetStacks).where(eq(policySetStacks.policySetId, psId));
  await db.update(policySets).set({ global: false }).where(eq(policySets.id, psId));
  await db.insert(policySetTagSelectors).values({ id: `tag-${suffix}`, policySetId: psId, key: "env", value: "test" });
  expect(await stackPolicyExecutionError(stack)).toContain(psId);
  await db.update(policySets).set({ tagMatchLogic: null }).where(eq(policySets.id, psId));
  expect(await stackPolicyExecutionError(stack)).toBeNull();
  // Disabling tag selection does not disable independent explicit/global scope.
  await db.update(policySets).set({ global: true }).where(eq(policySets.id, psId));
  expect(await stackPolicyExecutionError(stack)).toContain(psId);
  await db.update(policySets).set({ global: false, tagMatchLogic: "any" }).where(eq(policySets.id, psId));
  expect(await stackPolicyExecutionError(stack)).toContain(psId);
  await db.delete(policySetTagSelectors).where(eq(policySetTagSelectors.policySetId, psId));
});
const context = { signal: new AbortController().signal, heartbeat: async () => true, canceled: async () => false };
function job(runId: string): DurableJob {
  return {
    id: `job-${runId}`,
    kind: "stack-deployment",
    dedupeKey: null,
    status: "running",
    payload: { runId },
    payloadSchemaVersion: 1,
    attempts: 1,
    runAfter: 0,
    lockedBy: "test",
    lockToken: "test",
    leaseExpiresAt: Date.now() + 30000,
    heartbeatAt: 0,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}
async function records(name: string) {
  const configurationId = `config-${name}-${suffix}`,
    groupId = `group-${name}-${suffix}`,
    runId = `run-${name}-${suffix}`,
    stepId = `step-${name}-${suffix}`;
  await db.insert(stackRecords).values([
    {
      id: configurationId,
      stackId: stack.id,
      recordType: "stack-configurations",
      status: "completed",
      payload: { components: [] },
    },
    { id: groupId, stackId: stack.id, parentId: configurationId, recordType: "stack-deployment-groups" },
    {
      id: runId,
      stackId: stack.id,
      parentId: groupId,
      recordType: "stack-deployment-runs",
      status: "planning",
      payload: { configurationId },
    },
    {
      id: stepId,
      stackId: stack.id,
      parentId: runId,
      recordType: "stack-deployment-steps",
      status: "queued",
      payload: { phase: "apply" },
    },
  ]);
  return { runId, stepId };
}
test("hosted worker fails closed before even empty configurations can succeed", async () => {
  await db.update(policySets).set({ global: true }).where(eq(policySets.id, psId));
  const { runId, stepId } = await records("hosted");
  await runStackDeploymentJob(job(runId), context);
  const run = await db.query.stackRecords.findFirst({ where: eq(stackRecords.id, runId) });
  expect(run?.status).toBe("failed");
  expect(run?.payload["error"]).toContain("tfpolicy runtime");
  expect((await db.query.stackRecords.findFirst({ where: eq(stackRecords.id, stepId) }))?.status).toBe("failed");
});
test("agent cannot claim a queued apply after policy scope is introduced", async () => {
  const poolId = `pool-${suffix}`,
    agentId = `agent-${suffix}`;
  await db.insert(agentPools).values({ id: poolId, orgId, name: "test" });
  await db.insert(agents).values({
    id: agentId,
    agentPoolId: poolId,
    name: "test",
    status: "idle",
  });
  const { runId, stepId } = await records("agent");
  await db.insert(stackAgentJobs).values({
    id: `aj-${suffix}`,
    stackId: stack.id,
    deploymentRunId: runId,
    stepId,
    agentPoolId: poolId,
    phase: "apply",
  });
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  expect(agent).toBeDefined();
  expect(await claimStackAgentJob(agent!)).toBeUndefined();
  const claimed = await db.query.stackAgentJobs.findFirst({ where: eq(stackAgentJobs.id, `aj-${suffix}`) });
  expect(claimed?.status).toBe("errored");
  expect(claimed?.errorMessage).toContain("tfpolicy runtime");
  await runStackDeploymentJob(job(runId), context);
  expect((await db.query.stackRecords.findFirst({ where: eq(stackRecords.id, runId) }))?.status).toBe("failed");
});
