import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runAgentProtocolScript(script: string): Promise<Record<string, unknown>> {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-agent-recovery-race-"));
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        DATABASE_URL: "file:" + join(testDir, "terrence.db"),
        STORAGE_DIR: join(testDir, "storage"),
        NODE_ENV: "test",
        AGENT_HEARTBEAT_TIMEOUT_MS: "1000",
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

test("stale-agent recovery never exposes a claimable job before its run is queued (#929)", async () => {
  const result = await runAgentProtocolScript(`
    const { eq } = await import("drizzle-orm");
    const { db } = await import("./src/db/index.ts");
    const { agentJobs, agentPools, agents, organizations, runs, workspaces } =
      await import("./src/db/schema.ts");
    const {
      claimAgentJob,
      recoverStaleAgentJobs,
    } = await import("./src/lib/agent-jobs.ts");

    const now = Date.now();
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "pool", orgId: "org", name: "pool", organizationScoped: true });

    async function exercise(phase) {
      const suffix = phase;
      const staleAgentId = "stale-" + suffix;
      const replacementAgentId = "replacement-" + suffix;
      const workspaceId = "workspace-" + suffix;
      const runId = "run-" + suffix;
      const jobId = "job-" + suffix;
      await db.insert(agents).values([
        { id: staleAgentId, agentPoolId: "pool", name: staleAgentId, status: "exited", lastPingAt: now - 5000 },
        { id: replacementAgentId, agentPoolId: "pool", name: replacementAgentId, status: "idle", lastPingAt: now },
      ]);
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId: "org",
        name: workspaceId,
        executionMode: "agent",
        agentPoolId: "pool",
        ...(phase === "apply"
          ? {
              locked: true,
              lockedReason: "Run " + runId + " is applying",
              lockOwnerType: "agent-run",
              lockOwnerId: runId,
            }
          : {}),
      });
      await db.insert(runs).values({
        id: runId,
        workspaceId,
        agentPoolId: "pool",
        agentId: staleAgentId,
        status: phase === "plan" ? "planning" : "applying",
        createdAt: now,
      });
      await db.insert(agentJobs).values({
        id: jobId,
        runId,
        agentPoolId: "pool",
        agentId: staleAgentId,
        phase,
        status: "claimed",
        fencingToken: 3,
        claimedAt: now - 5000,
        createdAt: now,
      });

      let enteredResolve;
      let releaseResolve;
      const entered = new Promise((resolve) => { enteredResolve = resolve; });
      const release = new Promise((resolve) => { releaseResolve = resolve; });
      const recoveryPromise = recoverStaleAgentJobs(now, async (facts) => {
        if (facts.jobId !== jobId) return;
        enteredResolve();
        await release;
      });
      await entered;

      // Probe from a separate DB connection. SQLite's normal Terrence
      // bootstrap performs migration housekeeping and therefore needs a write
      // lock, so use a raw read-only connection there. PostgreSQL can execute
      // the real replacement claim path from a second process.
      const sqliteProbe = process.env.DATABASE_URL?.startsWith("file:") === true;
      const probeSource = sqliteProbe
        ? [
            'const { Database } = await import("bun:sqlite");',
            'const databaseUrl = process.env.DATABASE_URL;',
            'const path = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;',
            'const database = new Database(path, { readonly: true });',
            "const jobId = " + JSON.stringify(jobId) + ";",
            "const runId = " + JSON.stringify(runId) + ";",
            "const queuedStatus = " + JSON.stringify(phase === "plan" ? "plan_queued" : "apply_queued") + ";",
            'const job = database.query("SELECT status FROM agent_jobs WHERE id = ?").get(jobId);',
            'const run = database.query("SELECT status FROM runs WHERE id = ?").get(runId);',
            'const claimed = job?.status === "queued" && run?.status === queuedStatus ? jobId : null;',
            'process.stdout.write(JSON.stringify({ claimed, jobStatus: job?.status ?? null, runStatus: run?.status ?? null }));',
          ].join("\\n")
        : [
            'const { eq } = await import("drizzle-orm");',
            'const { db } = await import("./src/db/index.ts");',
            'const { agents } = await import("./src/db/schema.ts");',
            'const { claimAgentJob } = await import("./src/lib/agent-jobs.ts");',
            "const replacementAgentId = " + JSON.stringify(replacementAgentId) + ";",
            "const phase = " + JSON.stringify(phase) + ";",
            'const replacement = await db.query.agents.findFirst({ where: eq(agents.id, replacementAgentId) });',
            'const claimed = await claimAgentJob(replacement, [phase]);',
            'process.stdout.write(JSON.stringify({ claimed: claimed?.job.id ?? null }));',
          ].join("\\n");
      const probe = Bun.spawn([Bun.which("bun"), "-e", probeSource], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [probeExit, probeStdout, probeStderr] = await Promise.all([
        probe.exited,
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
      ]);
      if (probeExit !== 0) throw new Error(probeStderr || probeStdout);
      const duringClaimed = JSON.parse(probeStdout).claimed;

      releaseResolve();
      const recovered = await recoveryPromise;

      const replacement = await db.query.agents.findFirst({ where: eq(agents.id, replacementAgentId) });
      const after = await claimAgentJob(replacement, [phase]);
      const finalJob = await db.query.agentJobs.findFirst({ where: eq(agentJobs.id, jobId) });
      const finalRun = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
      const finalWorkspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
      return {
        duringClaimed,
        recovered,
        afterClaimed: after?.job.id ?? null,
        finalJobStatus: finalJob?.status,
        finalRunStatus: finalRun?.status,
        finalLocked: finalWorkspace?.locked ?? false,
        finalFencingToken: finalJob?.fencingToken,
      };
    }

    const plan = await exercise("plan");
    const apply = await exercise("apply");

    // Simulate an interrupted legacy recovery: the run already reached queued
    // but the stale job is still claimed. The next sweep must repair it.
    await db.insert(agents).values([
      { id: "stale-interrupted", agentPoolId: "pool", name: "stale-interrupted", status: "exited", lastPingAt: now - 5000 },
      { id: "replacement-interrupted", agentPoolId: "pool", name: "replacement-interrupted", status: "idle", lastPingAt: now },
    ]);
    await db.insert(workspaces).values({
      id: "workspace-interrupted",
      orgId: "org",
      name: "workspace-interrupted",
      executionMode: "agent",
      agentPoolId: "pool",
    });
    await db.insert(runs).values({
      id: "run-interrupted",
      workspaceId: "workspace-interrupted",
      agentPoolId: "pool",
      agentId: "stale-interrupted",
      status: "plan_queued",
      createdAt: now,
    });
    await db.insert(agentJobs).values({
      id: "job-interrupted",
      runId: "run-interrupted",
      agentPoolId: "pool",
      agentId: "stale-interrupted",
      phase: "plan",
      status: "claimed",
      fencingToken: 9,
      claimedAt: now - 5000,
      createdAt: now,
    });
    const repaired = await recoverStaleAgentJobs(now);
    const replacementInterrupted = await db.query.agents.findFirst({
      where: eq(agents.id, "replacement-interrupted"),
    });
    const repairedClaim = await claimAgentJob(replacementInterrupted, ["plan"]);
    const repairedJob = await db.query.agentJobs.findFirst({ where: eq(agentJobs.id, "job-interrupted") });

    console.log(JSON.stringify({
      plan,
      apply,
      interrupted: {
        recovered: repaired,
        claimed: repairedClaim?.job.id ?? null,
        status: repairedJob?.status,
        fencingToken: repairedJob?.fencingToken,
      },
    }));
  `);

  const plan = result["plan"] as Record<string, unknown>;
  const apply = result["apply"] as Record<string, unknown>;
  const interrupted = result["interrupted"] as Record<string, unknown>;

  expect(plan["duringClaimed"]).toBeNull();
  expect(plan).toMatchObject({
    recovered: ["job-plan"],
    afterClaimed: "job-plan",
    finalJobStatus: "claimed",
    finalRunStatus: "planning",
    finalLocked: false,
    finalFencingToken: 5,
  });

  expect(apply["duringClaimed"]).toBeNull();
  expect(apply).toMatchObject({
    recovered: ["job-apply"],
    afterClaimed: "job-apply",
    finalJobStatus: "claimed",
    finalRunStatus: "applying",
    finalLocked: true,
    finalFencingToken: 5,
  });

  expect(interrupted).toEqual({
    recovered: ["job-interrupted"],
    claimed: "job-interrupted",
    status: "claimed",
    fencingToken: 11,
  });
}, 30_000);
