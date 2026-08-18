import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Agent liveness persistence is throttled (kanban 9.12) and agent-pool token
// lastUsedAt writes mirror the user-token throttle (kanban 5.10). The module
// under test binds to the singleton DB at import time, so each scenario runs
// in a fresh `bun -e` subprocess with its own temp database, like the
// migration tests.
let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "terrence-agent-throttle-"));
  dirs.push(dir);
  return dir;
}

afterEach(async (): Promise<void> => {
  await Promise.all(dirs.map((dir): Promise<void> => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

const script = `
const { db } = await import("./src/db/index.ts");
const { agents, agentPoolTokens, agentPools, organizations } = await import("./src/db/schema.ts");
const { eq, sql } = await import("drizzle-orm");
const { authenticateAgent } = await import("./src/lib/agent-jobs.ts");
const { createHash } = await import("node:crypto");

const out = {};
const tokenHash = createHash("sha256").update("agent-secret").digest("hex");
await db.insert(organizations).values({ id: "org", name: "org" });
await db.insert(agentPools).values({ id: "pool", orgId: "org", name: "pool" });
await db.insert(agentPoolTokens).values({ id: "tok", agentPoolId: "pool", token: tokenHash, lastUsedAt: null });
const birth = Date.now();
await db.insert(agents).values({
  id: "agent",
  agentPoolId: "pool",
  name: "agent-1",
  status: "unknown",
  ipAddress: "10.0.0.1",
  version: "1.0.0",
  architecture: "amd64",
  lastPingAt: birth - 120_000,
  createdAt: birth,
});

async function row() {
  return db.query.agents.findFirst({ where: eq(agents.id, "agent") });
}
async function tokenRow() {
  return db.query.agentPoolTokens.findFirst({ where: eq(agentPoolTokens.id, "tok") });
}
async function pingSecondsAgo(ms) {
  await db.update(agents).set({ lastPingAt: Date.now() - ms }).where(eq(agents.id, "agent"));
}

// First auth: stale liveness and unknown status both persist immediately.
const first = await authenticateAgent("agent", "Bearer agent-secret");
const pingAfterFirst = (await row()).lastPingAt;
const tokenAfterFirst = (await tokenRow()).lastUsedAt;
out.firstTransitionersIdle = first !== undefined && first.status === "idle";
out.firstPersistsPing = pingAfterFirst !== null && Date.now() - pingAfterFirst < 5_000;
out.firstPersistsTokenUse = tokenAfterFirst !== null && Date.now() - tokenAfterFirst < 5_000;

// Second auth within both throttle windows: no DB writes, in-memory freshness kept.
const second = await authenticateAgent("agent", "Bearer agent-secret");
const pingAfterSecond = (await row()).lastPingAt;
const tokenAfterSecond = (await tokenRow()).lastUsedAt;
out.secondKeepsPing = pingAfterSecond === pingAfterFirst;
out.secondKeepsTokenUse = tokenAfterSecond === tokenAfterFirst;
out.secondFreshInMemory = second !== undefined && second.lastPingAt !== null && Date.now() - second.lastPingAt < 5_000;

// Expire both windows: writes resume.
await pingSecondsAgo(20_000);
await db.update(agentPoolTokens).set({ lastUsedAt: Date.now() - 61_000 }).where(eq(agentPoolTokens.id, "tok"));
await authenticateAgent("agent", "Bearer agent-secret");
const pingAfterThird = (await row()).lastPingAt;
const tokenAfterThird = (await tokenRow()).lastUsedAt;
out.thirdRefreshesPing = pingAfterThird !== null && Date.now() - pingAfterThird < 5_000 && pingAfterThird !== pingAfterFirst;
out.thirdRefreshesTokenUse = tokenAfterThird !== null && Date.now() - tokenAfterThird < 5_000 && tokenAfterThird !== tokenAfterFirst;

// Fresh liveness but unknown status still persists (status recovery is not throttled).
await pingSecondsAgo(1_000);
await db.update(agents).set({ status: "unknown" }).where(eq(agents.id, "agent"));
const recovered = await authenticateAgent("agent", "Bearer agent-secret");
const pingAfterRecovery = (await row()).lastPingAt;
out.recoveryPersists = recovered !== undefined && recovered.status === "idle" && pingAfterRecovery !== null && Date.now() - pingAfterRecovery < 5_000 && pingAfterRecovery !== pingAfterThird;

console.log(JSON.stringify(out));
`;

test("agent heartbeat and token lastUsedAt writes are throttled (kanban 9.12, 5.10)", async () => {
  const dir = await tempDir();
  const databaseUrl = `file:${join(dir, "test.db")}`;
  const result = Bun.spawnSync([Bun.which("bun")!, "-e", script], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env as Record<string, string>, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  expect(result.exitCode).toBe(0);
  if (stderr !== "") throw new Error(`subprocess stderr: ${stderr.slice(0, 1000)}`);
  const verdict = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  for (const [key, value] of Object.entries(verdict)) {
    expect(value, key).toBe(true);
  }
});