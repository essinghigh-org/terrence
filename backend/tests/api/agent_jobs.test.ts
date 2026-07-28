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
