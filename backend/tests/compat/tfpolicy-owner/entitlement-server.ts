// Local acceptance control plane. This uses the production API route and real
// run-token helpers. It cannot proxy other API paths or perform infrastructure work.
import { appendFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
const info = await stat(root);
if ((info.mode & 0o777) !== 0o700 || process.env["DATABASE_URL"] !== `file:${join(root, "test.db")}`)
  throw new Error("A private isolated acceptance database is required");
let ready = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { key: Bun.file(join(root, "server.key")), cert: Bun.file(join(root, "server.crt")) },
  async fetch(request: Request): Promise<Response> {
    return ready ? handle(request) : new Response(null, { status: 503 });
  },
});
process.env["PUBLIC_URL"] = `https://localhost:${server.port}`;
const [{ app }, { db }, schema, { mintRunToken, revokeRunTokens }] = await Promise.all([
  import("../../../src/app"),
  import("../../../src/db"),
  import("../../../src/db/schema"),
  import("../../../src/lib/run-token"),
]);
const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`,
  orgName = `native-owner-${suffix}`,
  workspaceId = `ws-${suffix}`,
  runId = `run-${suffix}`;
await db.insert(schema.organizations).values({ id: orgId, name: orgName });
await db.insert(schema.workspaces).values({ id: workspaceId, name: "native-owner-local", orgId });
await db.insert(schema.runs).values({ id: runId, workspaceId, status: "planning", createdAt: Date.now() });
const token = await mintRunToken(runId, workspaceId, orgId, 10 * 60 * 1000);
const entitlementPath = `/api/v2/organizations/${orgName}/entitlement-set`;
const handle = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET" || !["/.well-known/terraform.json", "/api/v2/ping", entitlementPath].includes(path))
    return new Response(null, { status: 403 });
  const response = await app.handle(request);
  const bytes = await response.clone().arrayBuffer();
  await appendFile(
    join(root, "requests.jsonl"),
    JSON.stringify({
      path,
      status: response.status,
      bodySha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    }) + "\n",
    { mode: 0o600 },
  );
  return response;
};
ready = true;
await writeFile(
  join(root, "context.json"),
  JSON.stringify({
    pid: process.pid,
    runId,
    workspaceId,
    runContext: { host: `localhost:${server.port}`, organization: orgName, token },
  }),
  { flag: "wx", mode: 0o600 },
);
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await revokeRunTokens(runId);
  await server.stop(true);
  await rm(join(root, "context.json"), { force: true });
  await writeFile(join(root, "stopped.json"), JSON.stringify({ tokenRevoked: true, serverStopped: true }), {
    mode: 0o600,
  });
  process.exit(0);
}
process.once("SIGTERM", (): void => {
  void stop();
});
process.once("SIGINT", (): void => {
  void stop();
});
