import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db";
import { agents, agentPools, organizations, stackAgentJobs, stackRecords, stackStateLocks, stacks } from "../../src/db/schema";
import { claimStackAgentJob, completeStackAgentJob } from "../../src/lib/stack-agent-jobs";
import { runStackDeploymentJob } from "../../src/lib/stack-worker";
import type { DurableJob } from "../../src/lib/durable-jobs";

const context = { heartbeat: async (): Promise<boolean> => true, canceled: async (): Promise<boolean> => false };

async function archive(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "terrence-stack-test-"));
  await mkdir(join(directory, "a"), { recursive: true });
  await mkdir(join(directory, "b"), { recursive: true });
  await writeFile(join(directory, "a", "main.tf"), "terraform {}\n");
  await writeFile(join(directory, "b", "main.tf"), "terraform {}\n");
  const path = join(directory, "stack.tar.gz");
  const tar = Bun.spawn(["tar", "-czf", path, "-C", directory, "a", "b"], { stdout: "pipe", stderr: "pipe" });
  expect(await tar.exited).toBe(0);
  return { directory, path };
}

function job(runId: string, id = crypto.randomUUID()): DurableJob {
  return { id, kind: "stack-deployment", dedupeKey: null, status: "running", payload: { runId }, attempts: 1, runAfter: Date.now(), lockedBy: "test", lockToken: "test", leaseExpiresAt: Date.now() + 30_000, heartbeatAt: Date.now(), lastError: null, createdAt: Date.now(), updatedAt: Date.now() };
}

describe("Stack deployment worker", () => {
  const orgId = `stack-worker-org-${crypto.randomUUID()}`;
  const stackId = `stack-worker-stack-${crypto.randomUUID()}`;
  let archiveDirectory = "";
  let archivePath = "";
  const previousRuns = process.env.SIMULATED_RUNS;
  const previousChanges = process.env.SIMULATED_STACK_PLAN_CHANGES;
  const previousDeferred = process.env.SIMULATED_STACK_DEFERRED;

  beforeAll(async () => {
    const archiveValue = await archive();
    archiveDirectory = archiveValue.directory;
    archivePath = archiveValue.path;
    process.env.SIMULATED_RUNS = "true";
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(stacks).values({ id: stackId, orgId, projectId: null, executionMode: "remote", name: "stack-worker", createdAt: Date.now(), updatedAt: Date.now() });
  });

  afterAll(async () => {
    if (previousRuns === undefined) delete process.env.SIMULATED_RUNS;
    else process.env.SIMULATED_RUNS = previousRuns;
    if (previousChanges === undefined) delete process.env.SIMULATED_STACK_PLAN_CHANGES;
    else process.env.SIMULATED_STACK_PLAN_CHANGES = previousChanges;
    if (previousDeferred === undefined) delete process.env.SIMULATED_STACK_DEFERRED;
    else process.env.SIMULATED_STACK_DEFERRED = previousDeferred;
    await db.delete(stacks).where(eq(stacks.id, stackId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    if (archiveDirectory !== "") await rm(archiveDirectory, { recursive: true, force: true });
  });

  test("orders components and reaches an empty-plan terminal state", async () => {
    const configurationId = `stack-config-${crypto.randomUUID()}`;
    const groupId = `stack-group-${crypto.randomUUID()}`;
    const runId = `stack-run-${crypto.randomUUID()}`;
    await db.insert(stackRecords).values([
      { id: configurationId, stackId, parentId: null, recordType: "stack-configurations", name: null, status: "completed", payload: { archivePath, components: [{ name: "a", directory: "a", source: null, dependsOn: [] }, { name: "b", directory: "b", source: null, dependsOn: ["a"] }] }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: groupId, stackId, parentId: configurationId, recordType: "stack-deployment-groups", name: "default", status: "pending", payload: {}, createdAt: Date.now(), updatedAt: Date.now() },
      { id: runId, stackId, parentId: groupId, recordType: "stack-deployment-runs", name: "default", status: "planning", payload: { configurationId, componentIndex: 0, cycle: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: `stack-step-${crypto.randomUUID()}`, stackId, parentId: runId, recordType: "stack-deployment-steps", name: "a", status: "queued", payload: { phase: "plan", "operation-type": "plan", componentIndex: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    await runStackDeploymentJob(job(runId), context);
    await runStackDeploymentJob(job(runId), context);
    await runStackDeploymentJob(job(runId), context);
    await runStackDeploymentJob(job(runId), context);
    const steps = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, runId), eq(stackRecords.recordType, "stack-deployment-steps")) });
    const completedNames = steps.filter((step) => step.status === "completed").map((step) => step.name);
    const run = await db.query.stackRecords.findFirst({ where: eq(stackRecords.id, runId) });
    expect(completedNames).toEqual(["a", "b"]);
    expect(run?.status).toBe("succeeded");
    expect(await db.query.stackStateLocks.findFirst({ where: eq(stackStateLocks.runId, runId) })).toBeUndefined();
  });

  test("keeps the state lock through apply and convergence", async () => {
    const configurationId = `stack-config-${crypto.randomUUID()}`;
    const groupId = `stack-group-${crypto.randomUUID()}`;
    const runId = `stack-run-${crypto.randomUUID()}`;
    const stepId = `stack-step-${crypto.randomUUID()}`;
    await db.insert(stackRecords).values([
      { id: configurationId, stackId, parentId: null, recordType: "stack-configurations", name: null, status: "completed", payload: { archivePath, components: [{ name: "a", directory: "a", source: null, dependsOn: [] }] }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: groupId, stackId, parentId: configurationId, recordType: "stack-deployment-groups", name: "locked", status: "pending", payload: {}, createdAt: Date.now(), updatedAt: Date.now() },
      { id: runId, stackId, parentId: groupId, recordType: "stack-deployment-runs", name: "locked", status: "planning", payload: { configurationId, componentIndex: 0, cycle: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: stepId, stackId, parentId: runId, recordType: "stack-deployment-steps", name: "a", status: "queued", payload: { phase: "plan", "operation-type": "plan", componentIndex: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    process.env.SIMULATED_STACK_PLAN_CHANGES = "false";
    process.env.SIMULATED_STACK_DEFERRED = "true";
    await runStackDeploymentJob(job(runId), context);
    await db.update(stackRecords).set({ status: "approved" }).where(eq(stackRecords.id, runId));
    await runStackDeploymentJob(job(runId), context);
    expect((await db.query.stackStateLocks.findFirst({ where: eq(stackStateLocks.runId, runId) }))?.runId).toBe(runId);
    process.env.SIMULATED_STACK_DEFERRED = "false";
    await runStackDeploymentJob(job(runId), context);
    await runStackDeploymentJob(job(runId), context);
    const run = await db.query.stackRecords.findFirst({ where: eq(stackRecords.id, runId) });
    expect(run?.status).toBe("succeeded");
    expect((await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-states"), eq(stackRecords.parentId, runId)) })).length).toBe(1);
    expect(await db.query.stackStateLocks.findFirst({ where: eq(stackStateLocks.runId, runId) })).toBeUndefined();
  });

  test("routes an agent Stack step through the durable agent queue", async () => {
    const poolId = `stack-pool-${crypto.randomUUID()}`;
    const agentId = `stack-agent-${crypto.randomUUID()}`;
    const configurationId = `stack-config-${crypto.randomUUID()}`;
    const groupId = `stack-group-${crypto.randomUUID()}`;
    const runId = `stack-run-${crypto.randomUUID()}`;
    const stepId = `stack-step-${crypto.randomUUID()}`;
    await db.insert(agentPools).values({ id: poolId, orgId, name: poolId, organizationScoped: true, createdAt: Date.now() });
    await db.insert(agents).values({ id: agentId, agentPoolId: poolId, name: agentId, iacBinaries: ["terraform"], createdAt: Date.now() });
    await db.update(stacks).set({ executionMode: "agent", agentPoolId: poolId }).where(eq(stacks.id, stackId));
    await db.insert(stackRecords).values([
      { id: configurationId, stackId, parentId: null, recordType: "stack-configurations", name: null, status: "completed", payload: { archivePath, components: [{ name: "a", directory: "a", source: null, dependsOn: [] }] }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: groupId, stackId, parentId: configurationId, recordType: "stack-deployment-groups", name: "agent", status: "pending", payload: {}, createdAt: Date.now(), updatedAt: Date.now() },
      { id: runId, stackId, parentId: groupId, recordType: "stack-deployment-runs", name: "agent", status: "planning", payload: { configurationId, componentIndex: 0, cycle: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: stepId, stackId, parentId: runId, recordType: "stack-deployment-steps", name: "a", status: "queued", payload: { phase: "plan", "operation-type": "plan", componentIndex: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    await runStackDeploymentJob(job(runId), context);
    const claimed = await claimStackAgentJob((await db.query.agents.findFirst({ where: eq(agents.id, agentId) }))!);
    expect(claimed?.job.phase).toBe("plan");
    await completeStackAgentJob(agentId, claimed!.job.id, { status: "completed", errorMessage: null, result: { hasChanges: false } });
    expect((await db.query.stackAgentJobs.findFirst({ where: eq(stackAgentJobs.id, claimed!.job.id) }))?.status).toBe("completed");
    await db.update(stacks).set({ executionMode: "remote", agentPoolId: null }).where(eq(stacks.id, stackId));
  });
});
