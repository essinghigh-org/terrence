/**
 * End-to-end HTTP benchmark: boots the real app against a temp DB and times
 * actual request handling (auth, rate limit, routing, serialization).
 * Run: bun run bench/http-routes.bench.ts [--json bench/baseline-http.json]
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, report } from "./harness";

const testDir = await mkdtemp(join(tmpdir(), "terrence-http-bench-"));
process.env.DATABASE_URL = `file:${join(testDir, "bench.db")}`;
process.env.STORAGE_DIR = join(testDir, "storage");
process.env.NODE_ENV = "test";
process.env.SIMULATED_RUNS = "true";

const { db } = await import("../src/db");
const { app } = await import("../src/app");
const { apiTokens, organizationMemberships, organizations, runs, users, workspaces } = await import("../src/db/schema");
const { eq } = await import("drizzle-orm");

const userId = "usr-bench";
const orgId = "org-bench";
const workspaceId = "ws-bench";
const token = `bench-token-${crypto.randomUUID()}`;

await db.insert(organizations).values({ id: orgId, name: "bench-org" });
await db.insert(users).values({ id: userId, username: "bench", email: "bench@example.test", passwordHash: "unused" });
await db.insert(apiTokens).values({
  id: "tok-bench",
  token: createHash("sha256").update(token).digest("hex"),
  userId,
  createdAt: Date.now(),
});
await db.insert(organizationMemberships).values({ id: "oum-bench", userId, orgId, role: "owner" });
await db.insert(workspaces).values({ id: workspaceId, orgId, name: "bench-ws" });
await db.insert(runs).values(
  Array.from({ length: 200 }, (_, i) => ({
    id: `run-bench-${i}`,
    workspaceId,
    status: i % 4 === 0 ? "pending" : i % 4 === 1 ? "planned" : i % 4 === 2 ? "applied" : "errored",
    createdAt: Date.now() - i * 60_000,
    statusTimestamps: { "pending-at": new Date(Date.now() - i * 60_000).toISOString() },
  })),
);

const authHeaders = { Authorization: `Bearer ${token}` };
const runsList = async (): Promise<Response> => app.handle(new Request(`http://localhost/api/v2/workspaces/${workspaceId}/runs?page%5Bnumber%5D=1&page%5Bsize%5D=50`, { headers: authHeaders }));
const ping = async (): Promise<Response> => app.handle(new Request("http://localhost/api/v2/ping"));
const readyz = async (): Promise<Response> => app.handle(new Request("http://localhost/readyz"));

// 5 iterations: the app's rate limiter allows 30 requests/min per key, and
// each iteration here is one real HTTP request.
await suite("http-end-to-end", {
  "GET /api/v2/ping (unauth)": async () => {
    const res = await ping();
    if (!res.ok) throw new Error(`ping failed: ${res.status}`);
    await res.arrayBuffer();
  },
  "GET /readyz": async () => {
    const res = await readyz();
    if (!res.ok) throw new Error(`readyz failed: ${res.status}`);
    await res.text();
  },
  "GET workspace runs list (50/page, authed)": async () => {
    const res = await runsList();
    if (res.status !== 200) throw new Error(`runs list failed: ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await res.arrayBuffer();
  },
}, 5);

report();

await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
await db.delete(apiTokens).where(eq(apiTokens.id, "tok-bench"));
await db.delete(users).where(eq(users.id, userId));
await db.delete(organizations).where(eq(organizations.id, orgId));
await rm(testDir, { recursive: true, force: true });
// The booted app keeps background pollers alive; exit explicitly.
process.exit(0);
