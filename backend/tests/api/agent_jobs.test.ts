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
    const { writeFile } = await import("fs/promises");
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

    const poolToken = "agent-primary-token";
    const otherPoolToken = "agent-other-token";
    const userToken = "user-token";
    const archivePath = join(process.env.TEST_DIR, "configuration.tar.gz");
    await writeFile(archivePath, "agent configuration archive");

    await db.insert(users).values({ id: "user", username: "user", passwordHash: "unused" });
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(organizationMemberships).values({
      id: "membership",
      orgId: "org",
      userId: "user",
      role: "owner",
    });
    await db.insert(apiTokens).values({ id: "user-token-id", token: userToken, userId: "user" });
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
    } = {}) => app.handle(new Request("http://terrence.test/api/v2/agents/" + agentId + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
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
    const jobId = claimData.id;

    const configurationResponse = await request(
      winnerAgentId,
      "/jobs/" + jobId + "/configuration",
      { method: "GET" },
    );
    const configurationBody = await configurationResponse.text();
    const stateResponse = await request(
      winnerAgentId,
      "/jobs/" + jobId + "/state",
      { method: "GET" },
    );
    const inputStateBody = await stateResponse.text();

    const logResponse = await request(winnerAgentId, "/jobs/" + jobId + "/logs", {
      body: {
        data: {
          type: "agent-job-logs",
          attributes: { "output-text": "Plan: 2 to add, 1 to change, 0 to destroy." },
        },
      },
    });
    const wrongAgentCompletion = await request(loserAgentId, "/jobs/" + jobId + "/complete", {
      body: {
        data: {
          type: "agent-jobs",
          attributes: { status: "completed" },
        },
      },
    });
    const planCompletion = await request(winnerAgentId, "/jobs/" + jobId + "/complete", {
      body: {
        data: {
          type: "agent-jobs",
          attributes: {
            status: "completed",
            "resource-additions": 2,
            "resource-changes": 1,
            "resource-destructions": 0,
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
    const applyLog = await request(loserAgentId, "/jobs/" + applyData.id + "/logs", {
      body: {
        data: {
          type: "agent-job-logs",
          attributes: { "output-text": "Apply complete! Resources: 2 added, 1 changed, 0 destroyed." },
        },
      },
    });
    const appliedState = JSON.stringify({ version: 4, serial: 4, lineage: "agent-lineage" });
    const applyCompletion = await request(loserAgentId, "/jobs/" + applyData.id + "/complete", {
      body: {
        data: {
          type: "agent-jobs",
          attributes: {
            status: "completed",
            "resource-additions": 2,
            "resource-changes": 1,
            "resource-destructions": 0,
            state: appliedState,
            "json-state-outputs": JSON.stringify({ outputs: {} }),
          },
        },
      },
    });
    const replayedCompletion = await request(loserAgentId, "/jobs/" + applyData.id + "/complete", {
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

    const [finalRun, finalState, finalLogs, finalAgents, runResponse] = await Promise.all([
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
    ]);
    const runResource = (await runResponse.json()).data;

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
      configurationBody,
      stateStatus: stateResponse.status,
      inputStateBody,
      logStatus: logResponse.status,
      wrongAgentCompletion: wrongAgentCompletion.status,
      planCompletion: planCompletion.status,
      afterPlanStatus: afterPlan?.status,
      jobsAfterPlan: jobsAfterPlan.map(job => [job.phase, job.status]),
      applyClaimStatus: applyClaim.status,
      applyPhase: applyData.attributes.phase,
      applyPlanResult: applyData.attributes["plan-result"],
      applyLogStatus: applyLog.status,
      applyCompletion: applyCompletion.status,
      replayedCompletion: replayedCompletion.status,
      emptyPoll: emptyPoll.status,
      manualApply: manualApply.status,
      manualRunStatus: manualRun?.status,
      manualJobStatus: manualJob?.status,
      finalRunStatus: finalRun?.status,
      finalRunAgentId: finalRun?.agentId,
      finalRunPoolId: finalRun?.agentPoolId,
      finalStateSerial: finalState?.serial,
      finalStatePayload: finalState?.statePayload,
      finalLogs: finalLogs.map(log => [log.phase, log.outputText]),
      finalAgentStatuses: finalAgents.map(agent => [agent.id, agent.status]),
      runRelationshipAgent: runResource.relationships.agent.data.id,
      runRelationshipPool: runResource.relationships["agent-pool"].data.id,
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
    configurationBody: "agent configuration archive",
    stateStatus: 200,
    inputStateBody: JSON.stringify({ version: 4, serial: 3 }),
    logStatus: 201,
    wrongAgentCompletion: 409,
    planCompletion: 200,
    afterPlanStatus: "apply_queued",
    jobsAfterPlan: [["plan", "completed"], ["apply", "queued"]],
    applyClaimStatus: 200,
    applyPhase: "apply",
    applyPlanResult: { "plan-handle": "saved-plan" },
    applyLogStatus: 201,
    applyCompletion: 200,
    replayedCompletion: 409,
    emptyPoll: 204,
    manualApply: 200,
    manualRunStatus: "apply_queued",
    manualJobStatus: "queued",
    finalRunStatus: "applied",
    finalRunPoolId: "pool",
    finalStateSerial: 4,
    finalStatePayload: JSON.stringify({ version: 4, serial: 4, lineage: "agent-lineage" }),
    finalLogs: [
      ["plan", "Plan: 2 to add, 1 to change, 0 to destroy."],
      ["apply", "Apply complete! Resources: 2 added, 1 changed, 0 destroyed."],
    ],
    finalAgentStatuses: [["agent-a", "idle"], ["agent-b", "idle"]],
    runRelationshipPool: "pool",
  });
  expect(["agent-a", "agent-b"]).toContain(result["finalRunAgentId"] as string);
  expect(result["runRelationshipAgent"]).toBe(result["finalRunAgentId"]);
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

    const request = (path, body) => app.handle(new Request(
      "http://terrence.test/api/v2/agents/agent" + path,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ));
    const claimResponse = await request("/jobs/poll");
    const claim = (await claimResponse.json()).data;
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
    });
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
