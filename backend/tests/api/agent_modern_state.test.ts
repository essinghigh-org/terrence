import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function runStateScript(script: string): Promise<Record<string, unknown>> {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-agent-state-"));
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        DATABASE_URL: `file:${join(testDir, "terrence.db")}`,
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

test("modern agent completion persists apply state payloads", async () => {
  const result = await runStateScript(`
    const { createHash } = await import("node:crypto");
    const { eq } = await import("drizzle-orm");
    const { app } = await import("./src/app.ts");
    const { db } = await import("./src/db/index.ts");
    const { decodeStatePayload } = await import("./src/lib/validation.ts");
    const { agentJobs, agentPoolTokens, agentPools, agents, organizations, runs, stateVersions, workspaces } = await import("./src/db/schema.ts");
    const token = "agent-state-token";
    const state = JSON.stringify({ version: 4, serial: 1, outputs: { answer: { value: 42 } } });

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "pool", orgId: "org", name: "pool", organizationScoped: true, createdAt: Date.now() });
    await db.insert(agentPoolTokens).values({ id: "pool-token", agentPoolId: "pool", token: createHash("sha256").update(token).digest("hex"), createdAt: Date.now() });
    await db.insert(agents).values({ id: "agent-1", agentPoolId: "pool", name: "agent", status: "busy", createdAt: Date.now() });
    await db.insert(workspaces).values({ id: "ws", name: "ws", orgId: "org", executionMode: "agent", agentPoolId: "pool", createdAt: Date.now() });
    await db.insert(runs).values({ id: "run1", planId: "run1", workspaceId: "ws", agentPoolId: "pool", agentId: "agent-1", status: "applying", autoApply: false, createdAt: Date.now() });
    await db.insert(agentJobs).values({ id: "job1", runId: "run1", agentPoolId: "pool", agentId: "agent-1", phase: "apply", status: "claimed", createdAt: Date.now() });

    const response = await app.fetch(new Request("http://test.local/api/agent/status", {
      method: "PUT",
      headers: {
        authorization: \`Bearer \${token}\`,
        "tfc-agent-id": "agent-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "idle",
        job: {
          status: "finished",
          data: {
            run_id: "run1",
            operation: "apply",
            resource_additions: 1,
            resource_changes: 0,
            resource_destructions: 0,
            resource_imports: 0,
            state,
            json_state: state,
            json_state_outputs: JSON.stringify({ answer: { value: 42 } }),
          },
        },
      }),
    }));
    const run = await db.query.runs.findFirst({ where: eq(runs.id, "run1") });
    const stateVersion = await db.query.stateVersions.findFirst({ where: eq(stateVersions.runId, "run1") });
    console.log(JSON.stringify({
      responseStatus: response.status,
      runStatus: run?.status,
      applyResourceAdditions: run?.applyResourceAdditions,
      stateSerial: stateVersion?.serial,
      statePayload: stateVersion?.statePayload === null || stateVersion?.statePayload === undefined ? stateVersion?.statePayload : decodeStatePayload(stateVersion.statePayload),
      jsonState: stateVersion?.jsonState === null || stateVersion?.jsonState === undefined ? stateVersion?.jsonState : decodeStatePayload(stateVersion.jsonState),
      jsonStateOutputs: stateVersion?.jsonStateOutputs === null || stateVersion?.jsonStateOutputs === undefined ? stateVersion?.jsonStateOutputs : decodeStatePayload(stateVersion.jsonStateOutputs),
    }));
    process.exit(0);
  `);

  expect(result).toEqual({
    responseStatus: 200,
    runStatus: "applied",
    applyResourceAdditions: 1,
    stateSerial: 1,
    statePayload: JSON.stringify({ version: 4, serial: 1, outputs: { answer: { value: 42 } } }),
    jsonState: JSON.stringify({ version: 4, serial: 1, outputs: { answer: { value: 42 } } }),
    jsonStateOutputs: JSON.stringify({ answer: { value: 42 } }),
  });
}, 30_000);
