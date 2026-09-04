import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { app } from "../../src/app";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { agents, agentPoolTokens, agentPools, durableJobs, organizations, stackAgentJobs, stackRecords, stackStateLocks, stacks } from "../../src/db/schema";
import { claimStackAgentJob, completeStackAgentJob, heartbeatStackAgentJob } from "../../src/lib/stack-agent-jobs";
import { removeStackState, runStackDeploymentJob, saveStackState } from "../../src/lib/stack-worker";
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
  const previousRuns = process.env["SIMULATED_RUNS"];
  const previousChanges = process.env["SIMULATED_STACK_PLAN_CHANGES"];
  const previousDeferred = process.env["SIMULATED_STACK_DEFERRED"];

  beforeAll(async () => {
    const archiveValue = await archive();
    archiveDirectory = archiveValue.directory;
    archivePath = archiveValue.path;
    process.env["SIMULATED_RUNS"] = "true";
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(stacks).values({ id: stackId, orgId, projectId: null, executionMode: "remote", name: "stack-worker", createdAt: Date.now(), updatedAt: Date.now() });
  });

  afterAll(async () => {
    if (previousRuns === undefined) delete process.env["SIMULATED_RUNS"];
    else process.env["SIMULATED_RUNS"] = previousRuns;
    if (previousChanges === undefined) delete process.env["SIMULATED_STACK_PLAN_CHANGES"];
    else process.env["SIMULATED_STACK_PLAN_CHANGES"] = previousChanges;
    if (previousDeferred === undefined) delete process.env["SIMULATED_STACK_DEFERRED"];
    else process.env["SIMULATED_STACK_DEFERRED"] = previousDeferred;
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
    process.env["SIMULATED_STACK_PLAN_CHANGES"] = "false";
    process.env["SIMULATED_STACK_DEFERRED"] = "true";
    await runStackDeploymentJob(job(runId), context);
    await db.update(stackRecords).set({ status: "approved" }).where(eq(stackRecords.id, runId));
    await runStackDeploymentJob(job(runId), context);
    expect((await db.query.stackStateLocks.findFirst({ where: eq(stackStateLocks.runId, runId) }))?.runId).toBe(runId);
    process.env["SIMULATED_STACK_DEFERRED"] = "false";
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

  test("renews long-running Stack claims and recovers dead claims", async () => {
    const poolId = `stack-pool-${crypto.randomUUID()}`;
    const agentId = `stack-agent-${crypto.randomUUID()}`;
    const replacementAgentId = `stack-agent-${crypto.randomUUID()}`;
    const configurationId = `stack-config-${crypto.randomUUID()}`;
    const groupId = `stack-group-${crypto.randomUUID()}`;
    const runId = `stack-run-${crypto.randomUUID()}`;
    const stepId = `stack-step-${crypto.randomUUID()}`;
    const recordIds = [configurationId, groupId, runId, stepId];
    await db.insert(agentPools).values({ id: poolId, orgId, name: poolId, organizationScoped: true, createdAt: Date.now() });
    await db.insert(agents).values([
      { id: agentId, agentPoolId: poolId, name: agentId, iacBinaries: ["terraform"], createdAt: Date.now() },
      { id: replacementAgentId, agentPoolId: poolId, name: replacementAgentId, iacBinaries: ["terraform"], createdAt: Date.now() },
    ]);
    await db.update(stacks).set({ executionMode: "agent", agentPoolId: poolId }).where(eq(stacks.id, stackId));
    await db.insert(stackRecords).values([
      { id: configurationId, stackId, parentId: null, recordType: "stack-configurations", name: null, status: "completed", payload: { archivePath, components: [{ name: "a", directory: "a", source: null, dependsOn: [] }] }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: groupId, stackId, parentId: configurationId, recordType: "stack-deployment-groups", name: "heartbeat", status: "pending", payload: {}, createdAt: Date.now(), updatedAt: Date.now() },
      { id: runId, stackId, parentId: groupId, recordType: "stack-deployment-runs", name: "heartbeat", status: "planning", payload: { configurationId, componentIndex: 0, cycle: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: stepId, stackId, parentId: runId, recordType: "stack-deployment-steps", name: "a", status: "queued", payload: { phase: "plan", "operation-type": "plan", componentIndex: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    await runStackDeploymentJob(job(runId), context);
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    const replacement = await db.query.agents.findFirst({ where: eq(agents.id, replacementAgentId) });
    if (agent === undefined || replacement === undefined) throw new Error("Stack test agents were not created");
    const claimed = await claimStackAgentJob(agent);
    if (claimed === undefined) throw new Error("Stack test job was not claimed");
    const heartbeatToken = `agent-stack-heartbeat-${crypto.randomUUID()}`;
    await db.insert(agentPoolTokens).values({
      id: `stack-heartbeat-token-row-${crypto.randomUUID()}`,
      agentPoolId: poolId,
      token: createHash("sha256").update(heartbeatToken).digest("hex"),
      createdAt: Date.now(),
    });
    const staleClaimedAt = Date.now() - (16 * 60_000);
    await db.update(stackAgentJobs).set({ claimedAt: staleClaimedAt }).where(eq(stackAgentJobs.id, claimed.job.id));
    const statusResponse = await app.handle(new Request("http://localhost/api/agent/status", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${heartbeatToken}`,
        "tfc-agent-id": agentId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "busy" }),
    }));
    expect(statusResponse.status).toBe(200);
    const statusRenewed = await db.query.stackAgentJobs.findFirst({ where: eq(stackAgentJobs.id, claimed.job.id) });
    expect(statusRenewed?.claimedAt).toBeGreaterThan(staleClaimedAt);

    const directHeartbeatAt = statusRenewed?.claimedAt ?? staleClaimedAt;
    await db.update(stackAgentJobs).set({ claimedAt: directHeartbeatAt }).where(eq(stackAgentJobs.id, claimed.job.id));
    expect(await heartbeatStackAgentJob(agentId, claimed.job.id)).toBe(true);
    const renewed = await db.query.stackAgentJobs.findFirst({ where: eq(stackAgentJobs.id, claimed.job.id) });
    expect(renewed?.claimedAt).toBeGreaterThanOrEqual(directHeartbeatAt);
    expect(await claimStackAgentJob(replacement)).toBeUndefined();

    await db.update(stackAgentJobs).set({ claimedAt: Date.now() - (16 * 60_000) }).where(eq(stackAgentJobs.id, claimed.job.id));
    const recovered = await claimStackAgentJob(replacement);
    expect(recovered?.job.id).toBe(claimed.job.id);
    expect(recovered?.job.agentId).toBe(replacementAgentId);

    await db.delete(stackAgentJobs).where(eq(stackAgentJobs.id, claimed.job.id));
    await db.delete(stackRecords).where(inArray(stackRecords.id, recordIds));
    await db.delete(agents).where(inArray(agents.id, [agentId, replacementAgentId]));
    await db.delete(agentPools).where(eq(agentPools.id, poolId));
    await db.update(stacks).set({ executionMode: "remote", agentPoolId: null }).where(eq(stacks.id, stackId));
  });

  test("keeps an immutable description for each state generation", async () => {
    const deployment = `history-${crypto.randomUUID()}`;
    const firstRunId = `stack-run-${crypto.randomUUID()}`;
    const secondRunId = `stack-run-${crypto.randomUUID()}`;
    let workingPath = "";
    let snapshotDirectory = "";
    const state = (serial: number): string => JSON.stringify({ version: 4, terraform_version: "1.9.0", serial, lineage: "stack-history-lineage", outputs: {}, resources: [] });
    const snapshotPathOf = (record: { payload: Record<string, unknown> }): string => {
      const value = record.payload["descriptionPath"];
      if (typeof value !== "string") throw new Error("Stack state record has no description path");
      return value;
    };
    await db.insert(stackRecords).values([
      { id: firstRunId, stackId, parentId: null, recordType: "stack-deployment-runs", name: deployment, status: "succeeded", payload: {}, createdAt: Date.now(), updatedAt: Date.now() },
      { id: secondRunId, stackId, parentId: null, recordType: "stack-deployment-runs", name: deployment, status: "succeeded", payload: {}, createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    try {
      workingPath = await saveStackState(stackId, deployment, firstRunId, state(1));
      const firstRecord = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.parentId, firstRunId), eq(stackRecords.recordType, "stack-states")) });
      if (firstRecord === undefined) throw new Error("First Stack state record was not created");
      const firstSnapshotPath = snapshotPathOf(firstRecord);
      snapshotDirectory = dirname(firstSnapshotPath);
      expect(firstSnapshotPath).not.toBe(workingPath);
      expect(JSON.parse(await Bun.file(firstSnapshotPath).text()).serial).toBe(1);

      const secondWorkingPath = await saveStackState(stackId, deployment, secondRunId, state(2));
      const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-states"), eq(stackRecords.name, deployment)) });
      const secondRecord = records.find((record) => record.parentId === secondRunId);
      if (secondRecord === undefined) throw new Error("Second Stack state record was not created");
      const secondSnapshotPath = snapshotPathOf(secondRecord);
      expect(secondWorkingPath).toBe(workingPath);
      expect(secondSnapshotPath).not.toBe(firstSnapshotPath);
      expect(JSON.parse(await Bun.file(firstSnapshotPath).text()).serial).toBe(1);
      expect(JSON.parse(await Bun.file(secondSnapshotPath).text()).serial).toBe(2);
      expect(JSON.parse(await Bun.file(secondWorkingPath).text()).serial).toBe(2);
      expect(records.find((record) => record.parentId === firstRunId)?.status).toBe("superseded");
      expect(records.find((record) => record.parentId === firstRunId)?.payload["is-current"]).toBe(false);
      expect(secondRecord.status).toBe("current");
      expect(secondRecord.payload["is-current"]).toBe(true);

      await removeStackState(stackId, deployment, secondRunId);
      const afterRemoval = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-states"), eq(stackRecords.name, deployment)) });
      expect(afterRemoval.find((record) => record.parentId === firstRunId)?.status).toBe("superseded");
      expect(afterRemoval.find((record) => record.parentId === secondRunId)?.status).toBe("destroyed");
      expect(JSON.parse(await Bun.file(firstSnapshotPath).text()).serial).toBe(1);
      expect(JSON.parse(await Bun.file(secondSnapshotPath).text()).serial).toBe(2);
      expect(await Bun.file(secondWorkingPath).exists()).toBe(false);
    } finally {
      await db.delete(stackRecords).where(and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-states"), eq(stackRecords.name, deployment)));
      await db.delete(stackRecords).where(inArray(stackRecords.id, [firstRunId, secondRunId]));
      if (snapshotDirectory !== "") await rm(snapshotDirectory, { recursive: true, force: true });
      if (workingPath !== "") await rm(workingPath, { force: true });
    }
  });

  test("rejects a stale fencing token before creating a state snapshot", async () => {
    const deployment = `fenced-${crypto.randomUUID()}`;
    const oldRunId = `stack-run-${crypto.randomUUID()}`;
    const newRunId = `stack-run-${crypto.randomUUID()}`;
    const lockId = `stack-lock-${crypto.randomUUID()}`;
    await db.insert(stackRecords).values({ id: oldRunId, stackId, parentId: null, recordType: "stack-deployment-runs", name: deployment, status: "applying", payload: {}, createdAt: Date.now(), updatedAt: Date.now() });
    await db.insert(stackStateLocks).values({ id: lockId, stackId, deployment, runId: oldRunId, fencingToken: 1, acquiredAt: Date.now(), leaseExpiresAt: Date.now() + 60_000, releasedAt: null, updatedAt: Date.now() });
    try {
      await db.update(stackStateLocks).set({ runId: newRunId, fencingToken: 2, updatedAt: Date.now() }).where(eq(stackStateLocks.id, lockId));
      let rejection: unknown;
      try {
        await saveStackState(stackId, deployment, oldRunId, JSON.stringify({ serial: 1 }), 1);
      } catch (error: unknown) {
        rejection = error;
      }
      expect(String(rejection)).toContain("ownership");
      expect(await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-states"), eq(stackRecords.name, deployment)) })).toHaveLength(0);
    } finally {
      await db.delete(stackStateLocks).where(eq(stackStateLocks.id, lockId));
      await db.delete(stackRecords).where(eq(stackRecords.id, oldRunId));
    }
  });

  test("recovers an agent apply when only a historical state exists", async () => {
    const deployment = `recovery-${crypto.randomUUID()}`;
    const poolId = `stack-pool-${crypto.randomUUID()}`;
    const configurationId = `stack-config-${crypto.randomUUID()}`;
    const groupId = `stack-group-${crypto.randomUUID()}`;
    const runId = `stack-run-${crypto.randomUUID()}`;
    const stepId = `stack-step-${crypto.randomUUID()}`;
    const component = { name: "a", directory: "a", source: null, dependsOn: [] };
    let snapshotPath = "";
    const originalStack = await db.query.stacks.findFirst({ where: eq(stacks.id, stackId), columns: { executionMode: true, agentPoolId: true } });
    if (originalStack === undefined) throw new Error("Stack test fixture was not created");
    await db.insert(agentPools).values({ id: poolId, orgId, name: poolId, organizationScoped: true, createdAt: Date.now() });
    await db.update(stacks).set({ executionMode: "agent", agentPoolId: poolId }).where(eq(stacks.id, stackId));
    await db.insert(stackRecords).values([
      { id: configurationId, stackId, parentId: null, recordType: "stack-configurations", name: null, status: "completed", payload: { components: [component] }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: groupId, stackId, parentId: configurationId, recordType: "stack-deployment-groups", name: deployment, status: "succeeded", payload: {}, createdAt: Date.now(), updatedAt: Date.now() },
      { id: runId, stackId, parentId: groupId, recordType: "stack-deployment-runs", name: deployment, status: "applying", payload: { configurationId, components: [component], componentIndex: 0, cycle: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: stepId, stackId, parentId: runId, recordType: "stack-deployment-steps", name: "a", status: "completed", payload: { phase: "apply", "operation-type": "apply", state: JSON.stringify({ version: 4, serial: 7, lineage: "recovered-lineage", outputs: {}, resources: [] }) }, createdAt: Date.now(), updatedAt: Date.now() },
      { id: `sst-historical-${crypto.randomUUID()}`, stackId, parentId: null, recordType: "stack-states", name: deployment, status: "superseded", payload: { generation: 1, "is-current": false, descriptionPath: join(tmpdir(), "historical-stack-state.tfstate"), components: [] }, createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    try {
      await runStackDeploymentJob(job(runId), context);
      const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-states"), eq(stackRecords.name, deployment)) });
      const recovered = records.find((record) => record.status === "current");
      if (recovered === undefined) throw new Error("Recovered Stack state was not published");
      const path = recovered.payload["descriptionPath"];
      if (typeof path !== "string") throw new Error("Recovered Stack state has no description path");
      snapshotPath = path;
      expect(records).toHaveLength(2);
      expect(recovered.payload["generation"]).toBe(2);
      expect(JSON.parse(await Bun.file(path).text()).serial).toBe(7);
      expect(records.find((record) => record.payload["generation"] === 1)?.status).toBe("superseded");
    } finally {
      await db.delete(stackAgentJobs).where(eq(stackAgentJobs.deploymentRunId, runId));
      await db.delete(durableJobs).where(eq(durableJobs.dedupeKey, `stack-run:${runId}`));
      await db.delete(stackStateLocks).where(and(eq(stackStateLocks.stackId, stackId), eq(stackStateLocks.deployment, deployment)));
      const generatedRecords = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.parentId, runId)) });
      const recordIds = [configurationId, groupId, runId, stepId, ...generatedRecords.map((record) => record.id)];
      await db.delete(stackRecords).where(and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-states"), eq(stackRecords.name, deployment)));
      if (recordIds.length > 0) await db.delete(stackRecords).where(inArray(stackRecords.id, recordIds));
      await db.delete(agentPools).where(eq(agentPools.id, poolId));
      await db.update(stacks).set({ executionMode: originalStack.executionMode, agentPoolId: originalStack.agentPoolId }).where(eq(stacks.id, stackId));
      if (snapshotPath !== "") {
        const directory = dirname(snapshotPath);
        await rm(directory, { recursive: true, force: true });
        await rm(join(dirname(directory), `${basename(directory)}.tfstate`), { force: true });
      }
    }
  });
});
