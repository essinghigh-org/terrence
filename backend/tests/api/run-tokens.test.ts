// Ephemeral per-run tokens (TFE run-token model).
//
// A run token is minted per run, delivered to the terraform process via a
// private CLI config file (TF_CLI_CONFIG_FILE), and grants ONLY:
//   - registry module reads for the run's own organization
//   - state read/write for the run's own workspace
// It is revoked on terminal state and expires after 24h regardless.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizations, runs, runTokens, stateVersions, users, workspaces } from "../../src/db/schema";
import { hashRunToken, mintRunToken, revokeRunTokens, writeRunCliConfig } from "../../src/lib/run-token";

let suffix = "";
let adminToken = "";
let adminUserId = "";

let orgA = "";
let orgB = "";
let wsA = "";
let wsB = "";
let runA = "";
let stateVersionId = "";

function request(path: string, method = "GET", token?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/vnd.api+json";
  return new Request(`http://terrence.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function seedRegistryModule(orgName: string, name: string): Promise<string> {
  const res = await app.handle(request(`/api/v2/organizations/${orgName}/registry-modules`, "POST", adminToken, {
    data: { attributes: { name, provider: "aws", namespace: orgName } },
  }));
  expect(res.status).toBe(201);
  const id = (await res.json()).data.id as string;
  await db.insert(
    await import("../../src/db/schema").then((m) => m.registryModuleVersions),
  ).values({
    id: `modver-${crypto.randomUUID()}`,
    moduleId: id,
    version: "1.0.0",
    status: "ok",
    createdAt: Date.now(),
  });
  return id;
}

beforeAll(async () => {
  suffix = crypto.randomUUID().slice(0, 8);
  adminUserId = `rt-admin-${suffix}`;
  adminToken = `rt-admin-tok-${suffix}`;
  await db.insert(users).values({ id: adminUserId, username: adminUserId, passwordHash: "unused", isSiteAdmin: true });
  await db.insert(apiTokens).values({
    id: crypto.randomUUID(),
    token: createHash("sha256").update(adminToken).digest("hex"),
    userId: adminUserId,
    createdAt: Date.now(),
  });

  orgA = `org-a-${suffix}`;
  orgB = `org-b-${suffix}`;
  for (const orgId of [orgA, orgB]) {
    await db.insert(organizations).values({ id: orgId, name: orgId });
  }
  await db.insert(workspaces).values([
    { id: `ws-a-${suffix}`, name: `ws-a-${suffix}`, orgId: orgA },
    { id: `ws-b-${suffix}`, name: `ws-b-${suffix}`, orgId: orgB },
  ]);
  wsA = `ws-a-${suffix}`;
  wsB = `ws-b-${suffix}`;

  const runRes = await app.handle(request(`/api/v2/workspaces/${wsA}/runs`, "POST", adminToken, {
    data: { type: "runs", attributes: { message: "run token test" } },
  }));
  expect(runRes.status).toBe(201);
  runA = (await runRes.json()).data.id as string;

  await seedRegistryModule(orgA, `vpc-${suffix}`);
  await seedRegistryModule(orgB, `vpc-${suffix}`);

  stateVersionId = `sv-${suffix}`;
  await db.insert(stateVersions).values({
    id: stateVersionId,
    workspaceId: wsA,
    serial: 1,
    statePayload: JSON.stringify({ version: 4, terraform_version: "1.0.0", resources: [] }),
    status: "finalized",
    createdAt: Date.now(),
  });
});

afterAll(async () => {
  await db.delete(runTokens).where(eq(runTokens.runId, runA));
  await db.delete(stateVersions).where(eq(stateVersions.id, stateVersionId));
  await db.delete(runs).where(eq(runs.id, runA));
  await db.delete(workspaces).where(eq(workspaces.id, wsA));
  await db.delete(workspaces).where(eq(workspaces.id, wsB));
  await db.delete(organizations).where(eq(organizations.id, orgA));
  await db.delete(organizations).where(eq(organizations.id, orgB));
  await db.delete(apiTokens).where(eq(apiTokens.userId, adminUserId));
  await db.delete(users).where(eq(users.id, adminUserId));
});

describe("run token minting and storage", () => {
  test("mints trun_-prefixed tokens and stores only the hash", async () => {
    const token = await mintRunToken(runA, wsA, orgA);
    expect(token.startsWith("trun_")).toBe(true);
    const row = await db.query.runTokens.findFirst({ where: eq(runTokens.tokenHash, hashRunToken(token)) });
    expect(row).toBeDefined();
    expect(row?.runId).toBe(runA);
    expect(row?.workspaceId).toBe(wsA);
    expect(row?.organizationId).toBe(orgA);
    expect(row?.revokedAt).toBeNull();
    const rt = row!;
    // Plaintext must not be stored.
    const plaintextRows = await db.query.runTokens.findFirst({ where: eq(runTokens.tokenHash, token) });
    expect(plaintextRows).toBeUndefined();
    // 24h expiry.
    expect(rt.expiresAt! - rt.createdAt!).toBe(24 * 60 * 60 * 1000);
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(token)));
  });

  test("writes a 0600 CLI config scoped to the hostname", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-tfrc-"));
    try {
      const token = `trun_${randomBytes(8).toString("base64url")}`;
      const path = await writeRunCliConfig(dir, "terraform.essinghigh.dev", token);
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
      const content = await readFile(path, "utf8");
      expect(content).toContain(`credentials "terraform.essinghigh.dev"`);
      expect(content).toContain(token);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("run token authorization", () => {
  test("reads registry modules from its own organization", async () => {
    const token = await mintRunToken(runA, wsA, orgA);
    const res = await app.handle(request(`/api/registry/v1/modules/${orgA}/vpc-${suffix}/aws/versions`, "GET", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modules: { versions: { version: string }[] }[] };
    expect(body.modules[0]?.versions[0]?.version).toBe("1.0.0");
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(token)));
  });

  test("cannot read registry modules from another organization", async () => {
    const token = await mintRunToken(runA, wsA, orgA);
    const res = await app.handle(request(`/api/registry/v1/modules/${orgB}/vpc-${suffix}/aws/versions`, "GET", token));
    expect(res.status).toBe(404);
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(token)));
  });

  test("cannot call user-facing API endpoints", async () => {
    const token = await mintRunToken(runA, wsA, orgA);
    const res = await app.handle(request("/api/v2/account/details", "GET", token));
    expect(res.status).not.toBe(200);
    const orgsRes = await app.handle(request("/api/v2/organizations", "GET", token));
    expect(orgsRes.status).not.toBe(200);
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(token)));
  });

  test("reads state for its own workspace only", async () => {
    const token = await mintRunToken(runA, wsA, orgA);
    const own = await app.handle(request(`/api/v2/workspaces/${wsA}/state-versions`, "GET", token));
    expect(own.status).toBe(200);
    const other = await app.handle(request(`/api/v2/workspaces/${wsB}/state-versions`, "GET", token));
    expect(other.status).toBe(404);
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(token)));
  });

  test("writes state for its own workspace", async () => {
    const token = await mintRunToken(runA, wsA, orgA);
    const res = await app.handle(request(`/api/v2/workspaces/${wsA}/state-versions`, "POST", token, {
      data: {
        type: "state-versions",
        attributes: {
          serial: 2,
          state: JSON.stringify({ version: 4, terraform_version: "1.0.0", resources: [] }),
        },
      },
    }));
    expect(res.status).toBe(201);
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(token)));
  });

  test("rejects revoked tokens", async () => {
    const token = await mintRunToken(runA, wsA, orgA);
    await revokeRunTokens(runA);
    const res = await app.handle(request("/api/v2/account/details", "GET", token));
    expect(res.status).toBe(401);
  });

  test("rejects expired tokens", async () => {
    const token = await mintRunToken(runA, wsA, orgA);
    await db.update(runTokens).set({ expiresAt: Date.now() - 1000 }).where(eq(runTokens.runId, runA));
    const res = await app.handle(request("/api/v2/account/details", "GET", token));
    expect(res.status).toBe(401);
    await db.delete(runTokens).where(eq(runTokens.runId, runA));
  });

  test("rejects unknown tokens with a revoked-like error", async () => {
    const res = await app.handle(request("/api/v2/account/details", "GET", `trun_${randomBytes(16).toString("base64url")}`));
    expect(res.status).toBe(401);
  });
});
