import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function runProtocolScript(script: string): Promise<Record<string, unknown>> {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-agent-protocol-"));
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
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

test("agent protocol registration negotiates versions and capabilities", async () => {
  const result = await runProtocolScript(`
    const { createHash } = await import("node:crypto");
    const { eq } = await import("drizzle-orm");
    const { app } = await import("./src/app.ts");
    const { db } = await import("./src/db/index.ts");
    const { agentPoolTokens, agentPools, agents, organizations } = await import("./src/db/schema.ts");

    const token = "agent-protocol-token";
    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "pool", orgId: "org", name: "pool" });
    await db.insert(agentPoolTokens).values({
      id: "token",
      agentPoolId: "pool",
      token: createHash("sha256").update(token).digest("hex"),
    });
    const out = {};

    let response = await app.fetch(new Request("http://localhost/api/agent/protocol"));
    const description = await response.json();
    out.discoveryStatus = response.status;
    out.discoveryVersion = description.protocol_version;
    out.discoveryHeader = response.headers.get("tfc-agent-protocol-version");
    out.discoveryHasAtomicUpload = description.capabilities.includes("artifact.atomic-upload");

    response = await app.fetch(new Request("http://localhost/api/agent/register", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "tfc-agent-version": "0.9.0",
      },
      body: JSON.stringify({
        name: "negotiated-agent",
        protocol_versions: ["2", "1"],
        capabilities: ["operation.plan", "artifact.plan-json", "future.artifact.v2"],
      }),
    }));
    const registration = await response.json();
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, registration.id) });
    out.registrationStatus = response.status;
    out.registrationVersion = registration.protocol_version;
    out.registrationUnsupported = registration.unsupported_capabilities;
    out.registrationAgentVersion = agent?.version;
    out.registrationAgentCapabilities = agent?.capabilities;

    response = await app.fetch(new Request("http://localhost/api/agent/register", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ name: "required-future", protocol_version: "1", required_capabilities: ["future.artifact.v2"] }),
    }));
    out.requiredFutureStatus = response.status;
    out.requiredFutureCode = (await response.json()).errors?.[0]?.code;

    response = await app.fetch(new Request("http://localhost/api/agent/register", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ name: "future-only", protocol_version: "2" }),
    }));
    out.futureOnlyStatus = response.status;
    out.futureOnlyCode = (await response.json()).errors?.[0]?.code;

    console.log(JSON.stringify(out));
    process.exit(0);
  `);

  expect(result).toEqual({
    discoveryStatus: 200,
    discoveryVersion: "1",
    discoveryHeader: "1",
    discoveryHasAtomicUpload: true,
    registrationStatus: 200,
    registrationVersion: "1",
    registrationUnsupported: ["future.artifact.v2"],
    registrationAgentVersion: "0.9.0",
    registrationAgentCapabilities: ["operation.plan", "artifact.plan-json"],
    requiredFutureStatus: 422,
    requiredFutureCode: "unsupported-capability",
    futureOnlyStatus: 406,
    futureOnlyCode: "unsupported-version",
  });
});
