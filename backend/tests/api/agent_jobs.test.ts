import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function runAgentProtocolScript(script: string): Promise<Record<string, unknown>> {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-agent-jobs-"));
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        DATABASE_URL: `file:${join(testDir, "terrence.db")}`,
        STORAGE_DIR: join(testDir, "storage"),
        TEST_DIR: testDir,
        NODE_ENV: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr || stdout);
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

test("dispatches agent runs through authenticated atomic claim, logs, and completion", async () => {
  const result = await runAgentProtocolScript(`
    const { createHash } = await import("node:crypto");
    const { join } = await import("path");
    const { mkdir, writeFile } = await import("fs/promises");
    const { and, asc, eq } = await import("drizzle-orm");
    const { app } = await import("./src/app.ts");
    const { db } = await import("./src/db/index.ts");
    const {
      agentJobs,
      agentPoolTokens,
      agentPools,
      agents,
      apiTokens,
      configurationVersions,
      logs,
      organizationMemberships,
      organizations,
      projects,
      runs,
      stateVersions,
      users,
      workspaces,
    } = await import("./src/db/schema.ts");
    const { pollWorkerQueue } = await import("./src/worker.ts");
    const { decodeStatePayload } = await import("./src/lib/validation.ts");
    const { hashAuthenticationToken } = await import("./src/lib/token-service.ts");

    const poolToken = "agent-primary-token";
    const otherPoolToken = "agent-other-token";
    const userToken = "user-token";
    const archivePath = join(process.env.TEST_DIR, "configuration.tar.gz");
    const archiveDirectory = join(process.env.TEST_DIR, "configuration");
    await mkdir(archiveDirectory, { recursive: true });
    await writeFile(join(archiveDirectory, "main.tf"), "terraform {}");
    const archiveProcess = Bun.spawn(["tar", "-czf", archivePath, "-C", archiveDirectory, "."], { stdout: "pipe", stderr: "pipe" });
    if (await archiveProcess.exited !== 0) throw new Error("could not create configuration archive");

    await db.insert(users).values({ id: "user", username: "user", passwordHash: "unused" });
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(organizationMemberships).values({
      id: "membership",
      orgId: "org",
      userId: "user",
      role: "owner",
    });
    await db.insert(apiTokens).values({ id: "user-token-id", token: hashAuthenticationToken(userToken), userId: "user" });
    await db.insert(projects).values({ id: "project", orgId: "org", name: "project" });
    await db.insert(agentPools).values([
      { id: "pool", orgId: "org", name: "pool", organizationScoped: true },
      { id: "other-pool", orgId: "org", name: "other", organizationScoped: true },
      { id: "restricted-pool", orgId: "org", name: "restricted", organizationScoped: false },
    ]);
    await db.insert(agentPoolTokens).values([
      {
        id: "pool-token",
        agentPoolId: "pool",
        token: createHash("sha256").update(poolToken).digest("hex"),
      },
      {
        id: "other-pool-token",
        agentPoolId: "other-pool",
        token: createHash("sha256").update(otherPoolToken).digest("hex"),
      },
    ]);
    await db.insert(agents).values([
      { id: "agent-a", agentPoolId: "pool", name: "agent-a", status: "idle" },
      { id: "agent-b", agentPoolId: "pool", name: "agent-b", status: "idle" },
    ]);
    await db.insert(workspaces).values([
      {
        id: "workspace",
        orgId: "org",
        projectId: "project",
        name: "workspace",
        executionMode: "agent",
        agentPoolId: "pool",
      },
      {
        id: "restricted-workspace",
        orgId: "org",
        projectId: "project",
        name: "restricted",
        executionMode: "agent",
        agentPoolId: "restricted-pool",
      },
    ]);
    await db.insert(configurationVersions).values({
      id: "cv",
      workspaceId: "workspace",
      status: "uploaded",
      archivePath,
    });
    await db.insert(stateVersions).values({
      id: "state-3",
      workspaceId: "workspace",
      serial: 3,
      statePayload: JSON.stringify({ version: 4, serial: 3 }),
      jsonState: JSON.stringify({ version: 4, serial: 3 }),
      status: "finalized",
    });
    await db.insert(runs).values([
      {
        id: "run",
        workspaceId: "workspace",
        configurationVersionId: "cv",
        status: "pending",
        autoApply: true,
        variables: [{ key: "region", value: "eu-west-2" }],
        createdAt: 1,
      },
      {
        id: "restricted-run",
        workspaceId: "restricted-workspace",
        status: "pending",
        createdAt: 2,
      },
    ]);

    const request = (agentId, path, {
      method = "POST",
      body,
      token = poolToken,
      fencingToken,
    } = {}) => app.handle(new Request("http://terrence.test/api/v2/agents/" + agentId + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(fencingToken === undefined ? {} : { "tfc-agent-fencing-token": String(fencingToken) }),
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

    const dispatched = await pollWorkerQueue();
    const queuedRun = await db.query.runs.findFirst({ where: eq(runs.id, "run") });
    const restrictedRun = await db.query.runs.findFirst({ where: eq(runs.id, "restricted-run") });
    const queuedJobs = await db.query.agentJobs.findMany({
      where: eq(agentJobs.runId, "run"),
      orderBy: [asc(agentJobs.createdAt)],
    });

    const missingAuth = await app.handle(new Request(
      "http://terrence.test/api/v2/agents/agent-a/jobs/poll",
      { method: "POST" },
    ));
    const crossPoolAuth = await request("agent-a", "/jobs/poll", { token: otherPoolToken });

    const claims = await Promise.all([
      request("agent-a", "/jobs/poll"),
      request("agent-b", "/jobs/poll"),
    ]);
    const claimStatuses = claims.map(response => response.status);
    const winnerIndex = claimStatuses.findIndex(status => status === 200);
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winnerAgentId = winnerIndex === 0 ? "agent-a" : "agent-b";
    const loserAgentId = loserIndex === 0 ? "agent-a" : "agent-b";
    const claimData = (await claims[winnerIndex].json()).data;
    const fencingToken = claimData.attributes["fencing-token"];
    const jobId = claimData.id;

    const configurationResponse = await request(
      winnerAgentId,
      "/jobs/" + jobId + "/configuration",
      { method: "GET", fencingToken },
    );
    const configurationBody = await configurationResponse.text();
    const stateResponse = await request(
      winnerAgentId,
      "/jobs/" + jobId + "/state",
      { method: "GET", fencingToken },
    );
    const inputStateBody = await stateResponse.text();

    const logResponse = await request(winnerAgentId, "/jobs/" + jobId + "/logs", {
      fencingToken,
      body: {
        data: {
          type: "agent-job-logs",
          attributes: { "output-text": "Plan: 2 to import, 0 to add, 0 to change, 0 to destroy." },
        },
      },
    });
    const wrongAgentCompletion = await request(loserAgentId, "/jobs/" + jobId + "/complete", {
      fencingToken,
      body: {
        data: {
          type: "agent-jobs",
          attributes: { status: "completed" },
        },
      },
    });
    const invalidPlanJsonCompletion = await request(winnerAgentId, "/jobs/" + jobId + "/complete", {
      fencingToken,
      body: {
        data: {
          type: "agent-jobs",
          attributes: { status: "completed", "plan-json": [] },
        },
      },
    });
    const structuredPlanJson = {
      format_version: "1.2",
      resource_changes: [{
        address: "terraform_data.imported_one",
        mode: "managed",
        change: { actions: ["no-op"], importing: { id: "existing-one" } },
      }, {
        address: "terraform_data.imported_two",
        mode: "managed",
        change: { actions: ["no-op"], importing: { id: "existing-two" } },
      }],
    };
    const planCompletion = await request(winnerAgentId, "/jobs/" + jobId + "/complete", {
      fencingToken,
      body: {
        data: {
          type: "agent-jobs",
          attributes: {
            status: "completed",
            "plan-json": structuredPlanJson,
            result: { "plan-handle": "saved-plan" },
          },
        },
      },
    });
    const afterPlan = await db.query.runs.findFirst({ where: eq(runs.id, "run") });
    const jobsAfterPlan = await db.query.agentJobs.findMany({
      where: eq(agentJobs.runId, "run"),
      orderBy: [asc(agentJobs.createdAt)],
    });

    const applyClaim = await request(loserAgentId, "/jobs/poll");
    const applyData = (await applyClaim.json()).data;
    const applyFencingToken = applyData.attributes["fencing-token"];
    const applyLog = await request(loserAgentId, "/jobs/" + applyData.id + "/logs", {
      fencingToken: applyFencingToken,
      body: {
        data: {
          type: "agent-job-logs",
          attributes: { "output-text": "Apply complete! Resources: 2 imported, 0 added, 0 changed, 0 destroyed." },
        },
      },
    });
    const appliedState = JSON.stringify({ version: 4, serial: 4, lineage: "agent-lineage" });
    const invalidApplyPlanJsonCompletion = await request(loserAgentId, "/jobs/" + applyData.id + "/complete", {
      fencingToken: applyFencingToken,
      body: {
        data: {
          type: "agent-jobs",
          attributes: { status: "completed", "plan-json": structuredPlanJson },
        },
      },
    });
    const applyCompletion = await request(loserAgentId, "/jobs/" + applyData.id + "/complete", {
      fencingToken: applyFencingToken,
      body: {
        data: {
          type: "agent-jobs",
          attributes: {
            status: "completed",
            "resource-additions": 0,
            "resource-changes": 0,
            "resource-destructions": 0,
            "resource-imports": 2,
            state: appliedState,
            "json-state-outputs": JSON.stringify({ outputs: {} }),
          },
        },
      },
    });
    const replayedCompletion = await request(loserAgentId, "/jobs/" + applyData.id + "/complete", {
      fencingToken: applyFencingToken,
      body: { data: { type: "agent-jobs", attributes: { status: "completed" } } },
    });
    const emptyPoll = await request(loserAgentId, "/jobs/poll");
    await db.insert(runs).values({
      id: "manual-run",
      workspaceId: "workspace",
      configurationVersionId: "cv",
      agentPoolId: "pool",
      status: "planned",
      createdAt: 3,
    });
    const manualApply = await app.handle(new Request(
      "http://terrence.test/api/v2/runs/manual-run/actions/apply",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + userToken },
      },
    ));
    const manualRun = await db.query.runs.findFirst({ where: eq(runs.id, "manual-run") });
    const manualJob = await db.query.agentJobs.findFirst({
      where: and(eq(agentJobs.runId, "manual-run"), eq(agentJobs.phase, "apply")),
    });
    await db.insert(runs).values({
      id: "errored-run",
      workspaceId: "workspace",
      agentPoolId: "pool",
      status: "planning",
      logToken: "errored-log-token",
      createdAt: 4,
    });
    await db.insert(agentJobs).values({
      id: "errored-job",
      runId: "errored-run",
      agentPoolId: "pool",
      agentId: "agent-a",
      phase: "plan",
      status: "claimed",
      createdAt: 4,
    });
    const oversizedErrorCompletion = await request("agent-a", "/jobs/errored-job/complete", {
      fencingToken: 0,
      body: {
        data: {
          type: "agent-jobs",
          attributes: { status: "errored", "error-message": "x".repeat(16_385) },
        },
      },
    });
    const erroredCompletion = await request("agent-a", "/jobs/errored-job/complete", {
      fencingToken: 0,
      body: {
        data: {
          type: "agent-jobs",
          attributes: { status: "errored", "error-message": "Provider authentication failed" },
        },
      },
    });
    const erroredRun = await db.query.runs.findFirst({ where: eq(runs.id, "errored-run") });
    const errorLogResponse = await app.handle(new Request(
      "http://terrence.test/api/v2/runs/errored-run/plan/log/errored-log-token",
    ));
    const errorLogText = await errorLogResponse.text();

    const [
      finalRun,
      finalState,
      finalLogs,
      finalAgents,
      runResponse,
      planResponse,
      applyResponse,
      planJsonResponse,
    ] = await Promise.all([
      db.query.runs.findFirst({ where: eq(runs.id, "run") }),
      db.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, "workspace"),
        orderBy: [asc(stateVersions.serial)],
        offset: 1,
      }),
      db.query.logs.findMany({ where: eq(logs.runId, "run"), orderBy: [asc(logs.createdAt)] }),
      db.query.agents.findMany({ where: eq(agents.agentPoolId, "pool"), orderBy: [asc(agents.id)] }),
      app.handle(new Request("http://terrence.test/api/v2/runs/run", {
        headers: { Authorization: "Bearer " + userToken },
      })),
      app.handle(new Request("http://terrence.test/api/v2/plans/plan-run", {
        headers: { Authorization: "Bearer " + userToken },
      })),
      app.handle(new Request("http://terrence.test/api/v2/applies/apply-run", {
        headers: { Authorization: "Bearer " + userToken },
      })),
      app.handle(new Request("http://terrence.test/api/v2/plans/plan-run/json-output", {
        headers: { Authorization: "Bearer " + userToken },
      })),
    ]);
    const runResource = (await runResponse.json()).data;
    const planResource = (await planResponse.json()).data;
    const applyResource = (await applyResponse.json()).data;
    const persistedPlanJson = await planJsonResponse.json();

    console.log(JSON.stringify({
      dispatched,
      queuedStatus: queuedRun?.status,
      restrictedStatus: restrictedRun?.status,
      queuedJobCount: queuedJobs.length,
      queuedJobStatus: queuedJobs[0]?.status,
      missingAuth: missingAuth.status,
      crossPoolAuth: crossPoolAuth.status,
      claimStatuses: claimStatuses.sort((a, b) => a - b),
      claimPhase: claimData.attributes.phase,
      claimRunId: claimData.relationships.run.data.id,
      claimVariables: claimData.attributes.run.variables,
      configurationStatus: configurationResponse.status,
      configurationBody: configurationResponse.status === 200 ? "served" : configurationBody,
      stateStatus: stateResponse.status,
      inputStateBody,
      logStatus: logResponse.status,
      wrongAgentCompletion: wrongAgentCompletion.status,
      invalidPlanJsonCompletion: invalidPlanJsonCompletion.status,
      planCompletion: planCompletion.status,
      afterPlanStatus: afterPlan?.status,
      afterPlanTimestamps: afterPlan?.statusTimestamps,
      jobsAfterPlan: jobsAfterPlan.map(job => [job.phase, job.status]),
      applyClaimStatus: applyClaim.status,
      applyPhase: applyData.attributes.phase,
      applyPlanResult: applyData.attributes["plan-result"],
      applyLogStatus: applyLog.status,
      invalidApplyPlanJsonCompletion: invalidApplyPlanJsonCompletion.status,
      applyCompletion: applyCompletion.status,
      replayedCompletion: replayedCompletion.status,
      emptyPoll: emptyPoll.status,
      manualApply: manualApply.status,
      manualRunStatus: manualRun?.status,
      manualJobStatus: manualJob?.status,
      oversizedErrorCompletion: oversizedErrorCompletion.status,
      erroredCompletion: erroredCompletion.status,
      erroredRunStatus: erroredRun?.status,
      errorLogStatus: errorLogResponse.status,
      errorLogText,
      finalRunStatus: finalRun?.status,
      finalRunAgentId: finalRun?.agentId,
      finalRunPoolId: finalRun?.agentPoolId,
      finalRunPlanImports: finalRun?.planResourceImports,
      finalRunApplyImports: finalRun?.applyResourceImports,
      finalStateSerial: finalState?.serial,
      finalStatePayload: finalState?.statePayload === null || finalState?.statePayload === undefined
        ? finalState?.statePayload
        : decodeStatePayload(finalState.statePayload),
      finalLogs: finalLogs.map(log => [log.phase, log.outputText]),
      finalAgentStatuses: finalAgents.map(agent => [agent.id, agent.status]),
      runRelationshipAgent: runResource.relationships.agent.data.id,
      runRelationshipPool: runResource.relationships["agent-pool"].data.id,
      runHasChanges: runResource.attributes["has-changes"],
      runResourceImports: runResource.attributes["resource-imports"],
      planResourceImports: planResource.attributes["resource-imports"],
      applyResourceImports: applyResource.attributes["resource-imports"],
      planJsonStatus: planJsonResponse.status,
      persistedPlanJson,
    }));
    process.exit(0);
  `);

  expect(result).toMatchObject({
    dispatched: expect.arrayContaining(["run", "restricted-run"]),
    queuedStatus: "plan_queued",
    restrictedStatus: "unreachable",
    queuedJobCount: 1,
    queuedJobStatus: "queued",
    missingAuth: 401,
    crossPoolAuth: 401,
    claimStatuses: [200, 204],
    claimPhase: "plan",
    claimRunId: "run",
    claimVariables: [{ key: "region", value: "eu-west-2" }],
    configurationStatus: 200,
    configurationBody: "served",
    stateStatus: 200,
    inputStateBody: JSON.stringify({ version: 4, serial: 3 }),
    logStatus: 201,
    wrongAgentCompletion: 409,
    invalidPlanJsonCompletion: 422,
    planCompletion: 200,
    afterPlanStatus: "apply_queued",
    afterPlanTimestamps: {
      "planned-at": expect.any(String),
      "apply-queued-at": expect.any(String),
    },
    jobsAfterPlan: [["plan", "completed"], ["apply", "queued"]],
    applyClaimStatus: 200,
    applyPhase: "apply",
    applyPlanResult: { "plan-handle": "saved-plan" },
    applyLogStatus: 201,
    invalidApplyPlanJsonCompletion: 422,
    applyCompletion: 200,
    replayedCompletion: 409,
    emptyPoll: 204,
    manualApply: 202,
    manualRunStatus: "apply_queued",
    manualJobStatus: "queued",
    oversizedErrorCompletion: 422,
    erroredCompletion: 200,
    erroredRunStatus: "errored",
    errorLogStatus: 200,
    errorLogText: "[agent error] Provider authentication failed",
    finalRunStatus: "applied",
    finalRunPoolId: "pool",
    finalRunPlanImports: 2,
    finalRunApplyImports: 2,
    finalStateSerial: 4,
    finalStatePayload: JSON.stringify({ version: 4, serial: 4, lineage: "agent-lineage" }),
    finalLogs: [
      ["plan", "Plan: 2 to import, 0 to add, 0 to change, 0 to destroy."],
      ["apply", "Apply complete! Resources: 2 imported, 0 added, 0 changed, 0 destroyed."],
    ],
    finalAgentStatuses: [["agent-a", "idle"], ["agent-b", "idle"]],
    runRelationshipPool: "pool",
    runHasChanges: true,
    runResourceImports: 2,
    planResourceImports: 2,
    applyResourceImports: 2,
    planJsonStatus: 200,
    persistedPlanJson: {
      format_version: "1.2",
      resource_changes: [{
        address: "terraform_data.imported_one",
        mode: "managed",
        change: { actions: ["no-op"], importing: { id: "existing-one" } },
      }, {
        address: "terraform_data.imported_two",
        mode: "managed",
        change: { actions: ["no-op"], importing: { id: "existing-two" } },
      }],
    },
  });
  expect(["agent-a", "agent-b"]).toContain(result.finalRunAgentId as string);
  expect(result.runRelationshipAgent).toBe(result.finalRunAgentId);
}, 30_000);

test("requeues a claimed job when its agent heartbeat expires", async () => {
  const result = await runAgentProtocolScript(`
    const { eq } = await import("drizzle-orm");
    const { db } = await import("./src/db/index.ts");
    const {
      agentJobs,
      agentPools,
      agents,
      organizations,
      runs,
      workspaces,
    } = await import("./src/db/schema.ts");
    const { claimAgentJob } = await import("./src/lib/agent-jobs.ts");
    const { pollWorkerQueue } = await import("./src/worker.ts");

    process.env.AGENT_HEARTBEAT_TIMEOUT_MS = "1000";
    const now = Date.now();
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({
      id: "pool",
      orgId: "org",
      name: "pool",
      organizationScoped: true,
    });
    await db.insert(workspaces).values({
      id: "workspace",
      orgId: "org",
      name: "workspace",
      executionMode: "agent",
      agentPoolId: "pool",
    });
    await db.insert(agents).values([
      {
        id: "stale-agent",
        agentPoolId: "pool",
        name: "stale",
        status: "busy",
        lastPingAt: now - 2000,
      },
      {
        id: "replacement-agent",
        agentPoolId: "pool",
        name: "replacement",
        status: "idle",
        lastPingAt: now,
      },
    ]);
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      agentPoolId: "pool",
      agentId: "stale-agent",
      status: "planning",
      createdAt: now,
    });
    await db.insert(agentJobs).values({
      id: "job",
      runId: "run",
      agentPoolId: "pool",
      agentId: "stale-agent",
      phase: "plan",
      status: "claimed",
      claimedAt: now - 2000,
      createdAt: now - 2000,
    });

    await pollWorkerQueue();
    const [staleAgent, recoveredJob, recoveredRun, replacementAgent] = await Promise.all([
      db.query.agents.findFirst({ where: eq(agents.id, "stale-agent") }),
      db.query.agentJobs.findFirst({ where: eq(agentJobs.id, "job") }),
      db.query.runs.findFirst({ where: eq(runs.id, "run") }),
      db.query.agents.findFirst({ where: eq(agents.id, "replacement-agent") }),
    ]);
    const claimed = await claimAgentJob(replacementAgent);
    const [reclaimedJob, reclaimedRun] = await Promise.all([
      db.query.agentJobs.findFirst({ where: eq(agentJobs.id, "job") }),
      db.query.runs.findFirst({ where: eq(runs.id, "run") }),
    ]);

    console.log(JSON.stringify({
      staleStatus: staleAgent?.status,
      recoveredJob: [
        recoveredJob?.status,
        recoveredJob?.agentId,
        recoveredJob?.claimedAt,
      ],
      recoveredRun: [recoveredRun?.status, recoveredRun?.agentId],
      claimedJobId: claimed?.job.id,
      reclaimedJob: [reclaimedJob?.status, reclaimedJob?.agentId],
      reclaimedRun: [reclaimedRun?.status, reclaimedRun?.agentId],
    }));
    process.exit(0);
  `);

  expect(result).toEqual({
    staleStatus: "unknown",
    recoveredJob: ["queued", null, null],
    recoveredRun: ["plan_queued", null],
    claimedJobId: "job",
    reclaimedJob: ["claimed", "replacement-agent"],
    reclaimedRun: ["planning", "replacement-agent"],
  });
}, 30_000);

test("releases only the recovered run-owned workspace lock", async () => {
  const result = await runAgentProtocolScript(`
    const { and, eq } = await import("drizzle-orm");
    const { db } = await import("./src/db/index.ts");
    const { agentJobs, agentPools, agents, organizations, runs, workspaces } = await import("./src/db/schema.ts");
    const { claimAgentJob, recoverStaleAgentJobs } = await import("./src/lib/agent-jobs.ts");

    process.env.AGENT_HEARTBEAT_TIMEOUT_MS = "1000";
    const now = Date.now();
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "pool", orgId: "org", name: "pool", organizationScoped: true });
    await db.insert(workspaces).values([
      {
        id: "workspace",
        orgId: "org",
        name: "workspace",
        executionMode: "agent",
        agentPoolId: "pool",
        locked: true,
        lockedReason: "Run run is applying",
        lockOwnerType: "agent-run",
        lockOwnerId: "run",
      },
      {
        id: "manual-workspace",
        orgId: "org",
        name: "manual-workspace",
        executionMode: "agent",
        agentPoolId: "pool",
        locked: true,
        lockedReason: "Operator lock",
        lockOwnerType: "manual",
        lockOwnerId: "operator",
      },
    ]);
    await db.insert(agents).values([
      { id: "stale-agent", agentPoolId: "pool", name: "stale", status: "busy", lastPingAt: now - 2000 },
      { id: "replacement-agent", agentPoolId: "pool", name: "replacement", status: "idle", lastPingAt: now },
    ]);
    await db.insert(runs).values([
      { id: "run", workspaceId: "workspace", agentPoolId: "pool", agentId: "stale-agent", status: "applying", createdAt: now - 3000 },
      { id: "manual-run", workspaceId: "manual-workspace", agentPoolId: "pool", agentId: "stale-agent", status: "applying", createdAt: now - 2000 },
    ]);
    await db.insert(agentJobs).values([
      { id: "job", runId: "run", agentPoolId: "pool", agentId: "stale-agent", phase: "apply", status: "claimed", claimedAt: now - 3000, createdAt: now - 3000 },
      { id: "manual-job", runId: "manual-run", agentPoolId: "pool", agentId: "stale-agent", phase: "apply", status: "claimed", claimedAt: now - 2000, createdAt: now - 2000 },
    ]);

    const recovered = await recoverStaleAgentJobs(now);
    const [recoveredJob, recoveredRun, recoveredWorkspace, manualWorkspace] = await Promise.all([
      db.query.agentJobs.findFirst({ where: eq(agentJobs.id, "job") }),
      db.query.runs.findFirst({ where: eq(runs.id, "run") }),
      db.query.workspaces.findFirst({ where: eq(workspaces.id, "workspace") }),
      db.query.workspaces.findFirst({ where: eq(workspaces.id, "manual-workspace") }),
    ]);
    const replacement = await db.query.agents.findFirst({ where: eq(agents.id, "replacement-agent") });
    const reclaimed = await claimAgentJob(replacement);
    const [reclaimedJob, reclaimedRun, reclaimedWorkspace] = await Promise.all([
      db.query.agentJobs.findFirst({ where: eq(agentJobs.id, "job") }),
      db.query.runs.findFirst({ where: eq(runs.id, "run") }),
      db.query.workspaces.findFirst({ where: eq(workspaces.id, "workspace") }),
    ]);
    console.log(JSON.stringify({
      recovered: recovered.sort(),
      recoveredJob: [recoveredJob?.status, recoveredJob?.agentId],
      recoveredRun: [recoveredRun?.status, recoveredRun?.agentId],
      recoveredWorkspace: [recoveredWorkspace?.locked, recoveredWorkspace?.lockOwnerType, recoveredWorkspace?.lockOwnerId],
      manualWorkspace: [manualWorkspace?.locked, manualWorkspace?.lockOwnerType, manualWorkspace?.lockOwnerId],
      reclaimedJobId: reclaimed?.job.id,
      reclaimedJob: [reclaimedJob?.status, reclaimedJob?.agentId],
      reclaimedRun: [reclaimedRun?.status, reclaimedRun?.agentId],
      reclaimedWorkspace: [reclaimedWorkspace?.locked, reclaimedWorkspace?.lockOwnerType, reclaimedWorkspace?.lockOwnerId],
    }));
    process.exit(0);
  `);

  expect(result).toEqual({
    recovered: ["job", "manual-job"],
    recoveredJob: ["queued", null],
    recoveredRun: ["apply_queued", null],
    recoveredWorkspace: [false, null, null],
    manualWorkspace: [true, "manual", "operator"],
    reclaimedJobId: "job",
    reclaimedJob: ["claimed", "replacement-agent"],
    reclaimedRun: ["applying", "replacement-agent"],
    reclaimedWorkspace: [true, "agent-run", "run"],
  });
}, 30_000);

test("evaluates agent-enabled Sentinel policies in the claimed plan job", async () => {
  const result = await runAgentProtocolScript(`
    const { createHash } = await import("node:crypto");
    const { asc, eq } = await import("drizzle-orm");
    const { app } = await import("./src/app.ts");
    const { db } = await import("./src/db/index.ts");
    const {
      agentJobs,
      agentPoolTokens,
      agentPools,
      agents,
      organizations,
      policies,
      policyChecks,
      policySetParameters,
      policySets,
      policySetWorkspaces,
      runs,
      workspaces,
    } = await import("./src/db/schema.ts");

    const token = "agent-policy-token";
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({
      id: "pool",
      orgId: "org",
      name: "pool",
      organizationScoped: true,
    });
    await db.insert(agentPoolTokens).values({
      id: "token",
      agentPoolId: "pool",
      token: createHash("sha256").update(token).digest("hex"),
    });
    await db.insert(agents).values({
      id: "agent",
      agentPoolId: "pool",
      name: "agent",
      status: "idle",
    });
    await db.insert(workspaces).values({
      id: "workspace",
      orgId: "org",
      name: "workspace",
      executionMode: "agent",
      agentPoolId: "pool",
    });
    await db.insert(policySets).values([
      {
        id: "agent-set",
        orgId: "org",
        name: "agent policies",
        kind: "sentinel",
        agentEnabled: true,
        policyToolVersion: "0.40.0",
        overridable: true,
      },
      {
        id: "platform-set",
        orgId: "org",
        name: "platform policies",
        kind: "sentinel",
        agentEnabled: false,
      },
    ]);
    await db.insert(policySetWorkspaces).values([
      {
        id: "agent-link",
        policySetId: "agent-set",
        workspaceId: "workspace",
      },
      {
        id: "platform-link",
        policySetId: "platform-set",
        workspaceId: "workspace",
      },
    ]);
    await db.insert(policies).values([
      {
        id: "hard-policy",
        policySetId: "agent-set",
        name: "hard policy",
        enforcementLevel: "hard-mandatory",
        source: "main = rule { false }",
        createdAt: 1,
      },
      {
        id: "soft-policy",
        policySetId: "agent-set",
        name: "soft policy",
        enforcementLevel: "soft-mandatory",
        source: "main = rule { true }",
        createdAt: 2,
      },
      {
        id: "platform-policy",
        policySetId: "platform-set",
        name: "platform policy",
        enforcementLevel: "hard-mandatory",
        source: "main = rule { false }",
        createdAt: 3,
      },
    ]);
    await db.insert(policySetParameters).values({
      id: "parameter",
      policySetId: "agent-set",
      key: "environment",
      value: "production",
      sensitive: true,
      hcl: false,
    });
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      agentPoolId: "pool",
      status: "plan_queued",
      autoApply: true,
      createdAt: 1,
    });
    await db.insert(agentJobs).values({
      id: "job",
      runId: "run",
      agentPoolId: "pool",
      phase: "plan",
      status: "queued",
      createdAt: 1,
    });

    const request = (path, body, fencingToken) => app.handle(new Request(
      "http://terrence.test/api/v2/agents/agent" + path,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          ...(fencingToken === undefined ? {} : { "tfc-agent-fencing-token": String(fencingToken) }),
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ));
    const claimResponse = await request("/jobs/poll");
    const claim = (await claimResponse.json()).data;
    const fencingToken = claim.attributes["fencing-token"];
    const policyEvaluation = claim.attributes["policy-evaluation"];
    const claimedRun = await db.query.runs.findFirst({ where: eq(runs.id, "run") });

    const completionResponse = await request("/jobs/job/complete", {
      data: {
        type: "agent-jobs",
        attributes: {
          status: "completed",
          "resource-additions": 1,
          "resource-changes": 0,
          "resource-destructions": 0,
          result: {
            "plan-handle": "saved-plan",
            "policy-checks": [{
              "policy-id": "hard-policy",
              status: "failed",
              result: { passed: false, reason: "denied by agent" },
            }, {
              "policy-id": "soft-policy",
              status: "passed",
              result: { passed: true },
            }],
          },
        },
      },
    }, fencingToken);
    const [completedRun, completedJobs, checks, completedAgent] = await Promise.all([
      db.query.runs.findFirst({ where: eq(runs.id, "run") }),
      db.query.agentJobs.findMany({
        where: eq(agentJobs.runId, "run"),
        orderBy: [asc(agentJobs.createdAt)],
      }),
      db.query.policyChecks.findMany({
        where: eq(policyChecks.runId, "run"),
        orderBy: [asc(policyChecks.policyId)],
      }),
      db.query.agents.findFirst({ where: eq(agents.id, "agent") }),
    ]);

    console.log(JSON.stringify({
      claimStatus: claimResponse.status,
      claimedRun: [claimedRun?.status, claimedRun?.agentId],
      policySetIds: policyEvaluation["policy-sets"].map(policySet => policySet.id),
      policyToolVersion: policyEvaluation["policy-sets"][0]["policy-tool-version"],
      policyIds: policyEvaluation["policy-sets"][0].policies.map(policy => policy.id),
      policyLevels: policyEvaluation["policy-sets"][0].policies.map(
        policy => policy["enforcement-level"],
      ),
      parameters: policyEvaluation["policy-sets"][0].parameters,
      containsCostData: JSON.stringify(policyEvaluation).includes("cost-estimate"),
      completionStatus: completionResponse.status,
      completedRunStatus: completedRun?.status,
      statusKeys: Object.keys(completedRun?.statusTimestamps ?? {}),
      completedJobs: completedJobs.map(job => [job.phase, job.status]),
      checks: checks.map(check => [check.policyId, check.status, check.result]),
      completedAgentStatus: completedAgent?.status,
    }));
    process.exit(0);
  `);

  expect(result).toEqual({
    claimStatus: 200,
    claimedRun: ["planning", "agent"],
    policySetIds: ["agent-set"],
    policyToolVersion: "0.40.0",
    policyIds: ["hard-policy", "soft-policy"],
    policyLevels: ["mandatory", "mandatory"],
    parameters: [{
      key: "environment",
      value: "production",
      sensitive: true,
      hcl: false,
    }],
    containsCostData: false,
    completionStatus: 200,
    completedRunStatus: "policy_soft_failed",
    statusKeys: [
      "planning-at",
      "planned-at",
      "policy-checking-at",
      "policy-override-at",
      "policy-soft-failed-at",
    ],
    completedJobs: [["plan", "completed"]],
    checks: [
      ["hard-policy", "soft_failed", { passed: false, reason: "denied by agent" }],
      ["soft-policy", "passed", { passed: true }],
    ],
    completedAgentStatus: "idle",
  });
}, 30_000);

test("routes agent jobs by declared iac-binaries capability", async () => {
  const result = await runAgentProtocolScript(`
    const { createHash } = await import("node:crypto");
    const { asc, eq } = await import("drizzle-orm");
    const { app } = await import("./src/app.ts");
    const { db } = await import("./src/db/index.ts");
    const {
      agentJobs,
      agentPoolTokens,
      agentPools,
      agents,
      organizations,
      runs,
      workspaces,
    } = await import("./src/db/schema.ts");
    const { pollWorkerQueue } = await import("./src/worker.ts");

    const poolToken = "agent-capability-token";
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({
      id: "pool",
      orgId: "org",
      name: "pool",
      organizationScoped: true,
    });
    await db.insert(agentPoolTokens).values({
      id: "pool-token",
      agentPoolId: "pool",
      token: createHash("sha256").update(poolToken).digest("hex"),
    });
    await db.insert(agents).values([
      {
        id: "tf-agent",
        agentPoolId: "pool",
        name: "tf-agent",
        status: "idle",
        iacBinaries: ["terraform"],
      },
      {
        id: "tf-agent-2",
        agentPoolId: "pool",
        name: "tf-agent-2",
        status: "idle",
        iacBinaries: ["terraform"],
      },
      {
        id: "tofu-agent",
        agentPoolId: "pool",
        name: "tofu-agent",
        status: "idle",
        iacBinaries: ["tofu"],
      },
    ]);
    await db.insert(workspaces).values([
      {
        id: "tf-workspace",
        orgId: "org",
        name: "tf-workspace",
        executionMode: "agent",
        agentPoolId: "pool",
        iacBinary: "terraform",
      },
      {
        id: "tofu-workspace",
        orgId: "org",
        name: "tofu-workspace",
        executionMode: "agent",
        agentPoolId: "pool",
        iacBinary: "tofu",
      },
    ]);
    await db.insert(runs).values([
      {
        id: "tf-run",
        workspaceId: "tf-workspace",
        agentPoolId: "pool",
        status: "pending",
        createdAt: 1,
      },
      {
        id: "tofu-run",
        workspaceId: "tofu-workspace",
        agentPoolId: "pool",
        status: "pending",
        createdAt: 2,
      },
    ]);

    await pollWorkerQueue();
    const jobs = await db.query.agentJobs.findMany({ orderBy: [asc(agentJobs.createdAt)] });

    const poll = (agentId) => app.handle(new Request(
      "http://terrence.test/api/v2/agents/" + agentId + "/jobs/poll",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + poolToken },
      },
    ));

    // The terraform-only agent can only see the terraform job.
    const tfClaim = await poll("tf-agent");
    const tfClaimData = tfClaim.status === 200 ? (await tfClaim.json()).data : null;
    // An agent re-polling while holding a claimed job resumes its in-flight
    // job (protocol contract), so the tofu job's invisibility is proven with
    // a second terraform-only agent: it must get 204.
    const tfResumePoll = await poll("tf-agent");
    const tfResumeData = tfResumePoll.status === 200 ? (await tfResumePoll.json()).data : null;
    const tfAgent2Poll = await poll("tf-agent-2");

    // The tofu-capable agent claims the tofu job.
    const tofuClaim = await poll("tofu-agent");
    const tofuClaimData = (await tofuClaim.json()).data;

    const [tfRun, tofuRun, claimedTfJob, claimedTofuJob] = await Promise.all([
      db.query.runs.findFirst({ where: eq(runs.id, "tf-run") }),
      db.query.runs.findFirst({ where: eq(runs.id, "tofu-run") }),
      db.query.agentJobs.findFirst({ where: eq(agentJobs.id, tfClaimData?.id ?? "") }),
      db.query.agentJobs.findFirst({ where: eq(agentJobs.id, tofuClaimData?.id ?? "") }),
    ]);

    console.log(JSON.stringify({
      queuedJobBinaries: jobs.map((job) => [job.runId, job.iacBinary]).sort((a, b) => a[0].localeCompare(b[0])),
      tfClaimStatus: tfClaim.status,
      tfClaimRunId: tfClaimData?.relationships?.run?.data?.id ?? null,
      tfResumePoll: tfResumePoll.status,
      tfResumeRunId: tfResumeData?.relationships?.run?.data?.id ?? null,
      tfAgent2Poll: tfAgent2Poll.status,
      tofuClaimStatus: tofuClaim.status,
      tofuClaimRunId: tofuClaimData?.relationships?.run?.data?.id ?? null,
      claimedTfBy: claimedTfJob?.agentId,
      claimedTofuBy: claimedTofuJob?.agentId,
      tfRunStatus: tfRun?.status,
      tofuRunStatus: tofuRun?.status,
    }));
    process.exit(0);
  `);

  expect(result).toEqual({
    queuedJobBinaries: [
      ["tf-run", "terraform"],
      ["tofu-run", "tofu"],
    ],
    tfClaimStatus: 200,
    tfClaimRunId: "tf-run",
    tfResumePoll: 200,
    tfResumeRunId: "tf-run",
    tfAgent2Poll: 204,
    tofuClaimStatus: 200,
    tofuClaimRunId: "tofu-run",
    claimedTfBy: "tf-agent",
    claimedTofuBy: "tofu-agent",
    tfRunStatus: "planning",
    tofuRunStatus: "planning",
  });
}, 30_000);

test("stale agent recovery advances the fencing token", async () => {
  const result = await runAgentProtocolScript(`
    const { db } = await import("./src/db/index.ts");
    const { eq } = await import("drizzle-orm");
    const { organizations, agentPools, agents, workspaces, runs, agentJobs } = await import("./src/db/schema.ts");
    const { recoverStaleAgentJobs, findClaimedAgentJob } = await import("./src/lib/agent-jobs.ts");
    const now = Date.now();
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "pool", orgId: "org", name: "pool", organizationScoped: true });
    await db.insert(agents).values({ id: "agent", agentPoolId: "pool", name: "agent", status: "exited", lastPingAt: now - (2 * 60_000) });
    await db.insert(workspaces).values({ id: "workspace", orgId: "org", name: "workspace", executionMode: "agent", agentPoolId: "pool" });
    await db.insert(runs).values({ id: "run", workspaceId: "workspace", agentPoolId: "pool", status: "planning", createdAt: now });
    await db.insert(agentJobs).values({
      id: "job",
      runId: "run",
      agentPoolId: "pool",
      agentId: "agent",
      phase: "plan",
      status: "claimed",
      claimedAt: now - (2 * 60_000),
      fencingToken: 7,
      createdAt: now,
    });
    const recovered = await recoverStaleAgentJobs(now);
    const row = await db.query.agentJobs.findFirst({ where: eq(agentJobs.id, "job") });
    const staleLookup = await findClaimedAgentJob("agent", "job", 7);
    const recoveredRun = await db.query.runs.findFirst({ where: eq(runs.id, "run") });
    console.log(JSON.stringify({ recovered, status: row?.status, fencingToken: row?.fencingToken, runStatus: recoveredRun?.status, staleLookup: staleLookup === undefined }));
  `);
  expect(result).toEqual({
    recovered: ["job"],
    status: "queued",
    fencingToken: 8,
    runStatus: "plan_queued",
    staleLookup: true,
  });
}, 30_000);