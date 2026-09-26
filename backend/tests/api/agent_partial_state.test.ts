import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runAgentProtocolScript(script: string): Promise<Record<string, unknown>> {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-agent-partial-state-"));
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        DATABASE_URL: "file:" + join(testDir, "terrence.db"),
        STORAGE_DIR: join(testDir, "storage"),
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

test("failed remote-agent apply persists returned partial state before acknowledgment (#930)", async () => {
  const result = await runAgentProtocolScript(`
    const { asc, eq } = await import("drizzle-orm");
    const { db } = await import("./src/db/index.ts");
    const { agentJobs, agentPools, agents, organizations, runs, stateVersions, workspaces } =
      await import("./src/db/schema.ts");
    const { completeAgentJob } = await import("./src/lib/agent-jobs.ts");
    const { decodeStatePayload } = await import("./src/lib/validation.ts");

    const now = Date.now();
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "pool", orgId: "org", name: "pool", organizationScoped: true });
    await db.insert(agents).values({ id: "agent", agentPoolId: "pool", name: "agent", status: "busy", lastPingAt: now });
    await db.insert(workspaces).values({
      id: "workspace",
      orgId: "org",
      name: "workspace",
      executionMode: "agent",
      agentPoolId: "pool",
      locked: true,
      lockedReason: "Run run is applying",
      lockOwnerType: "agent-run",
      lockOwnerId: "run",
    });
    await db.insert(stateVersions).values({
      id: "old-state",
      workspaceId: "workspace",
      serial: 1,
      statePayload: JSON.stringify({ version: 4, serial: 1, lineage: "lineage", resources: [] }),
      status: "finalized",
    });
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      agentPoolId: "pool",
      agentId: "agent",
      status: "applying",
      createdAt: now,
    });
    await db.insert(agentJobs).values({
      id: "job",
      runId: "run",
      agentPoolId: "pool",
      agentId: "agent",
      phase: "apply",
      status: "claimed",
      fencingToken: 4,
      claimedAt: now,
      createdAt: now,
    });

    const partial = JSON.stringify({ version: 4, serial: 2, lineage: "lineage", resources: [{ type: "test_resource" }] });
    const completed = await completeAgentJob("agent", "job", 4, {
      status: "errored",
      errorMessage: "provider failed after mutation",
      resourceAdditions: null,
      resourceChanges: null,
      resourceDestructions: null,
      resourceImports: null,
      planJson: null,
      statePayload: partial,
      jsonState: partial,
      jsonStateOutputs: null,
      result: {},
    });

    const states = await db.query.stateVersions.findMany({
      where: eq(stateVersions.workspaceId, "workspace"),
      orderBy: [asc(stateVersions.serial)],
    });
    const run = await db.query.runs.findFirst({ where: eq(runs.id, "run") });
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, "workspace") });
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, "agent") });
    console.log(JSON.stringify({
      acked: completed !== undefined,
      runStatus: run?.status,
      locked: workspace?.locked,
      agentStatus: agent?.status,
      serials: states.map((state) => state.serial),
      latest: decodeStatePayload(states.at(-1)?.statePayload ?? "null"),
    }));
  `);

  expect(result).toEqual({
    acked: true,
    runStatus: "errored",
    locked: false,
    agentStatus: "idle",
    serials: [1, 2],
    latest: JSON.stringify({ version: 4, serial: 2, lineage: "lineage", resources: [{ type: "test_resource" }] }),
  });
}, 30_000);

test("canceled remote-agent apply durably captures returned state before releasing its lock (#930)", async () => {
  const result = await runAgentProtocolScript(`
    const { readFile } = await import("node:fs/promises");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("./src/db/index.ts");
    const { agentJobs, agentPools, agents, organizations, runs, workspaces } =
      await import("./src/db/schema.ts");
    const { completeAgentJob } = await import("./src/lib/agent-jobs.ts");
    const { recoveryMarkerPathFor, recoveryStatePathFor } = await import("./src/lib/recovery-files.ts");
    const { decodeStatePayload } = await import("./src/lib/validation.ts");

    const now = Date.now();
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "pool", orgId: "org", name: "pool", organizationScoped: true });
    await db.insert(agents).values({ id: "agent", agentPoolId: "pool", name: "agent", status: "busy", lastPingAt: now });
    await db.insert(workspaces).values({
      id: "workspace",
      orgId: "org",
      name: "workspace",
      executionMode: "agent",
      agentPoolId: "pool",
      locked: true,
      lockedReason: "Run run is applying",
      lockOwnerType: "agent-run",
      lockOwnerId: "run",
    });
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      agentPoolId: "pool",
      agentId: "agent",
      status: "canceled",
      createdAt: now,
    });
    await db.insert(agentJobs).values({
      id: "job",
      runId: "run",
      agentPoolId: "pool",
      agentId: "agent",
      phase: "apply",
      status: "canceled",
      fencingToken: 2,
      claimedAt: now,
      createdAt: now,
    });

    const partial = JSON.stringify({ version: 4, serial: 8, lineage: "cancel-lineage", resources: [{ type: "partial" }] });
    const completed = await completeAgentJob("agent", "job", 2, {
      status: "errored",
      errorMessage: "canceled after mutation",
      resourceAdditions: null,
      resourceChanges: null,
      resourceDestructions: null,
      resourceImports: null,
      planJson: null,
      statePayload: partial,
      jsonState: partial,
      jsonStateOutputs: null,
      result: {},
    });

    const storage = process.env.STORAGE_DIR;
    const captured = decodeStatePayload(await readFile(recoveryStatePathFor(storage, "run"), "utf8"));
    const marker = await readFile(recoveryMarkerPathFor(storage, "run"), "utf8");
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, "workspace") });
    console.log(JSON.stringify({
      acked: completed !== undefined,
      locked: workspace?.locked,
      captured,
      marker: marker.length > 0,
    }));
  `);

  expect(result).toEqual({
    acked: true,
    locked: false,
    captured: JSON.stringify({ version: 4, serial: 8, lineage: "cancel-lineage", resources: [{ type: "partial" }] }),
    marker: true,
  });
}, 30_000);

test("canceled remote-agent apply stays unacknowledged until recovery capture succeeds (#930)", async () => {
  const result = await runAgentProtocolScript(`
    const { mkdir, rm, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("./src/db/index.ts");
    const { agentJobs, agentPools, agents, organizations, runs, workspaces } =
      await import("./src/db/schema.ts");
    const { completeAgentJob } = await import("./src/lib/agent-jobs.ts");

    const now = Date.now();
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "pool", orgId: "org", name: "pool", organizationScoped: true });
    await db.insert(agents).values({ id: "agent", agentPoolId: "pool", name: "agent", status: "busy", lastPingAt: now });
    await db.insert(workspaces).values({
      id: "workspace",
      orgId: "org",
      name: "workspace",
      executionMode: "agent",
      agentPoolId: "pool",
      locked: true,
      lockedReason: "Run run is applying",
      lockOwnerType: "agent-run",
      lockOwnerId: "run",
    });
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      agentPoolId: "pool",
      agentId: "agent",
      status: "canceled",
      createdAt: now,
    });
    await db.insert(agentJobs).values({
      id: "job",
      runId: "run",
      agentPoolId: "pool",
      agentId: "agent",
      phase: "apply",
      status: "canceled",
      fencingToken: 7,
      claimedAt: now,
      createdAt: now,
    });

    const completion = {
      status: "errored",
      errorMessage: "canceled after mutation",
      resourceAdditions: null,
      resourceChanges: null,
      resourceDestructions: null,
      resourceImports: null,
      planJson: null,
      statePayload: JSON.stringify({ version: 4, serial: 3, lineage: "retry", resources: [{ type: "partial" }] }),
      jsonState: null,
      jsonStateOutputs: null,
      result: {},
    };

    const storage = process.env.STORAGE_DIR;
    await mkdir(storage, { recursive: true });
    await writeFile(join(storage, "recovery"), "blocked");
    let firstError = null;
    try {
      await completeAgentJob("agent", "job", 7, completion);
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
    const lockedAfterFailure = (await db.query.workspaces.findFirst({ where: eq(workspaces.id, "workspace") }))?.locked;
    const agentAfterFailure = (await db.query.agents.findFirst({ where: eq(agents.id, "agent") }))?.status;

    await rm(join(storage, "recovery"), { force: true });
    const retried = await completeAgentJob("agent", "job", 7, completion);
    const lockedAfterRetry = (await db.query.workspaces.findFirst({ where: eq(workspaces.id, "workspace") }))?.locked;
    const agentAfterRetry = (await db.query.agents.findFirst({ where: eq(agents.id, "agent") }))?.status;

    console.log(JSON.stringify({
      firstError,
      lockedAfterFailure,
      agentAfterFailure,
      retryAcked: retried !== undefined,
      lockedAfterRetry,
      agentAfterRetry,
    }));
  `);

  expect(result).toEqual({
    firstError: "Canceled apply run cannot be acknowledged until its returned state is durably captured for recovery",
    lockedAfterFailure: true,
    agentAfterFailure: "busy",
    retryAcked: true,
    lockedAfterRetry: false,
    agentAfterRetry: "idle",
  });
}, 30_000);
