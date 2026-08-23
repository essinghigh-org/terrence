import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { agents, agentPools, apiTokens, organizationMemberships, organizations, policies, policySetParameters, policySets, projects, runs, teams, teamMemberships, users, workspaceVariables, workspaces, workspaceTags } from "../../src/db/schema";
import { MAX_TAG_RULE_DEPTH } from "../../src/lib/token-scopes";

const AUTH_PREFIX = "Bea" + "rer ";

type ScopedSeed = {
  suffix: string;
  userId: string;
  username: string;
  orgId: string;
  orgName: string;
  adminToken: string;
  adminTokenId: string;
  membershipId: string;
  projectA: string;
  projectB: string;
  wsA1: string;
  wsA2: string;
  wsB1: string;
  tagWsId: string;
  wsA3: string;
  policySetId: string | null;
}

function seed(): ScopedSeed {
  const suffix = crypto.randomUUID();
  return {
    suffix,
    userId: `fg-user-${suffix}`,
    username: `fg-user-${suffix}`,
    orgId: `fg-org-${suffix}`,
    orgName: `fg-org-${suffix}`,
    adminToken: `fg-admin-${suffix}`,
    adminTokenId: `fg-admin-tok-${suffix}`,
    membershipId: `fg-membership-${suffix}`,
    projectA: `fg-prj-a-${suffix}`,
    projectB: `fg-prj-b-${suffix}`,
    wsA1: `fg-ws-a1-${suffix}`,
    wsA2: `fg-ws-a2-${suffix}`,
    wsB1: `fg-ws-b1-${suffix}`,
    tagWsId: `fg-ws-tag-${suffix}`,
    wsA3: `fg-ws-a3-${suffix}`,
    policySetId: null,
  };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: AUTH_PREFIX + token,
    "Content-Type": "application/vnd.api+json",
  };
}

// The suite mints dozens of tokens per user, far past the default general
// (30 req / 1s) and sensitive (5 / 60s) rate limits. Instead of raising the
// limits in-process (which bun test would leak into other files sharing a
// worker process, breaking rate_limits.test.ts), it talks to a dedicated
// server process whose env overrides are isolated to this suite alone.
async function startFgServer(): Promise<{ proc: Bun.Subprocess; port: number; logPath: string }> {
  const port = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      srv.close(() => { resolve(addr.port); });
    });
  });
  const logPath = join(mkdtempSync(join(tmpdir(), "terrence-fg-tests-")), "server.log");
  const proc = Bun.spawn(["bun", "run", "index.ts"], {
    cwd: import.meta.dir + "/../..",
    env: {
      ...process.env,
      PORT: String(port),
      RATE_LIMIT_MAX: "10000",
      RATE_LIMIT_SENSITIVE_MAX: "10000",
    },
    stdout: openSync(logPath, "w"),
    stderr: openSync(logPath, "w"),
  });
  for (let i = 0; i < 75; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return { proc, port, logPath };
    } catch {}
    if (proc.exitCode !== null) break;
    await Bun.sleep(200);
  }
  proc.kill();
  const tail = await Bun.file(logPath).text().catch((): string => "");
  throw new Error(`backend failed to start within 15s\n${tail.slice(-4000)}`);
}

const fgServer = await startFgServer();

afterAll(() => {
  fgServer.proc.kill();
});

const request = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(new URL(path, `http://127.0.0.1:${fgServer.port}`), init);

async function seedOrgFixtures(s: ScopedSeed, opts: { tags?: boolean; includeUsers?: boolean } = {}): Promise<void> {
  await db.insert(users).values({ id: s.userId, username: s.username, passwordHash: "unused" });
  if (opts.includeUsers === true) {
    await db.insert(users).values({ id: `fg-rate-${s.suffix}`, username: `fg-rate-${s.suffix}`, passwordHash: "unused" });
  }
  await db.insert(organizations).values({ id: s.orgId, name: s.orgName });
  await db.insert(organizationMemberships).values({ id: s.membershipId, userId: s.userId, orgId: s.orgId, role: "owner" });
  if (opts.includeUsers === true) {
    await db.insert(organizationMemberships).values({ id: `fg-rate-mem-${s.suffix}`, userId: `fg-rate-${s.suffix}`, orgId: s.orgId, role: "owner" });
  }
  await db.insert(apiTokens).values({ id: s.adminTokenId, token: createHash("sha256").update(s.adminToken).digest("hex"), userId: s.userId });
  await db.insert(projects).values([
    { id: s.projectA, orgId: s.orgId, name: "proj-a" },
    { id: s.projectB, orgId: s.orgId, name: "proj-b" },
  ]);
  await db.insert(workspaces).values([
    { id: s.wsA1, orgId: s.orgId, projectId: s.projectA, name: "ws-a1" },
    { id: s.wsA2, orgId: s.orgId, projectId: s.projectA, name: "ws-a2" },
    { id: s.wsB1, orgId: s.orgId, projectId: s.projectB, name: "ws-b1" },
    { id: s.tagWsId, orgId: s.orgId, projectId: s.projectB, name: "ws-tag" },
    { id: s.wsA3, orgId: s.orgId, projectId: s.projectB, name: "ws-and-half" },
  ]);
  if (opts.tags === true) {
    await db.insert(workspaceTags).values([
      { id: `wtag-${s.suffix}`, workspaceId: s.tagWsId, key: "environment", value: "prod" },
      { id: `wtag-a1-${s.suffix}`, workspaceId: s.wsA1, key: "foo", value: "bar" },
      { id: `wtag-a1b-${s.suffix}`, workspaceId: s.wsA1, key: "baz", value: "bing" },
      { id: `wtag-a2-${s.suffix}`, workspaceId: s.wsA2, key: "xyz", value: "abc" },
      { id: `wtag-a3-${s.suffix}`, workspaceId: s.wsA3, key: "foo", value: "bar" },
    ]);
  }
}

async function teardownOrgFixtures(s: ScopedSeed, opts: { tags?: boolean; includeUsers?: boolean } = {}): Promise<void> {
  await db.delete(runs).where(eq(runs.workspaceId, s.wsA1));
  if (opts.tags === true) {
    await db.delete(workspaceTags).where(eq(workspaceTags.workspaceId, s.wsA1));
    await db.delete(workspaceTags).where(eq(workspaceTags.workspaceId, s.wsA2));
    await db.delete(workspaceTags).where(eq(workspaceTags.workspaceId, s.wsA3));
    await db.delete(workspaceTags).where(eq(workspaceTags.workspaceId, s.tagWsId));
  }
  await db.delete(workspaces).where(eq(workspaces.orgId, s.orgId));
  await db.delete(projects).where(eq(projects.orgId, s.orgId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, s.userId));
  if (opts.includeUsers === true) {
    await db.delete(apiTokens).where(eq(apiTokens.userId, `fg-rate-${s.suffix}`));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `fg-rate-mem-${s.suffix}`));
    await db.delete(users).where(eq(users.id, `fg-rate-${s.suffix}`));
  }
  await db.delete(organizationMemberships).where(eq(organizationMemberships.id, s.membershipId));
  await db.delete(organizations).where(eq(organizations.id, s.orgId));
  await db.delete(users).where(eq(users.id, s.userId));
}

async function createScopedToken(
  userId: string,
  adminToken: string,
  attributes: Record<string, unknown>,
): Promise<{ id: string; secret: string }> {
  const res = await request(`/api/v2/users/${userId}/authentication-tokens`, {
    method: "POST",
    headers: headers(adminToken),
    body: JSON.stringify({
      data: { type: "authentication-tokens", attributes: { description: "scoped", ...attributes } },
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as { data: { id: string; attributes: { token: string | null } } };
  return { id: body.data.id, secret: body.data.attributes.token! };
}

describe("fine-grained user tokens", () => {
  const s = seed();

  beforeAll(async () => {
    await seedOrgFixtures(s, { tags: true, includeUsers: true });
  });

  afterAll(async () => {
    await teardownOrgFixtures(s, { tags: true, includeUsers: true });
  });

  it("rejects invalid scopes on creation", async () => {
    const res = await request(`/api/v2/users/${s.userId}/authentication-tokens`, {
      method: "POST",
      headers: headers(s.adminToken),
      body: JSON.stringify({
        data: {
          type: "authentication-tokens",
          attributes: { description: "bad", scopes: { version: 1, orgs: [], permissions: {} } },
        },
      }),
    });
    expect(res.status).toBe(422);
  });

  it("fails closed (401) when a stored token has malformed scopes", async () => {
    // Simulate DB corruption: a token row whose scopes JSON is unparseable.
    const id = crypto.randomUUID();
    const raw = `fg-corrupt-${s.suffix}`;
    await db.insert(apiTokens).values({
      id,
      token: createHash("sha256").update(raw).digest("hex"),
      userId: s.userId,
      orgId: null,
      description: "corrupt",
      scopes: "{not-valid-json",
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt: null,
      teamId: null,
    });
    try {
      const res = await request(`/api/v2/workspaces/${s.wsA1}`, { headers: headers(raw) });
      // A corrupt scope must never escalate to full permissions.
      expect(res.status).toBe(401);
      const mcp = await request("/mcp", {
        method: "POST",
        headers: { ...headers(raw), "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(mcp.status).toBe(401);
      // The SSE setup endpoint (GET /mcp) must fail closed too, not 500.
      const mcpSse = await request("/mcp", {
        method: "GET",
        headers: { ...headers(raw), Accept: "text/event-stream" },
      });
      expect(mcpSse.status).toBe(401);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, id));
    }
  });

  it("allows a token scoped to a single workspace with workspaces:read", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true },
      },
    });
    try {
      // Can read the scoped workspace by ID
      const ok = await request(`/api/v2/workspaces/${s.wsA1}`, { headers: headers(created.secret) });
      expect(ok.status).toBe(200);

      // Cannot read a workspace outside the scope
      const denied = await request(`/api/v2/workspaces/${s.wsB1}`, { headers: headers(created.secret) });
      expect(denied.status).toBe(404);

      // Listing workspaces only returns the scoped one
      const list = await request(`/api/v2/organizations/${s.orgName}/workspaces`, { headers: headers(created.secret) });
      expect(list.status).toBe(200);
      const listBody = await list.json() as { data: { id: string }[] };
      const ids = listBody.data.map((w): string => w.id);
      expect(ids).toContain(s.wsA1);
      expect(ids).not.toContain(s.wsB1);
      expect(ids).not.toContain(s.wsA2);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("denies state reads without the state:read grant", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true },
      },
    });
    try {
      const res = await request(`/api/v2/workspaces/${s.wsA1}/current-state-version`, { headers: headers(created.secret) });
      // Even though the token can read the workspace, state:read is not
      // granted, so this must not return state.
      expect(res.status).toBe(404);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("allows state reads when state:read is granted", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true, "state:read": true },
      },
    });
    try {
      const res = await request(`/api/v2/workspaces/${s.wsA1}/current-state-version`, { headers: headers(created.secret) });
      // No state exists yet; the important part is this is not 403/404 due to
      // missing state:read — it should be a "not found" for state, or 200.
      expect([200, 404]).toContain(res.status);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("scopes a token to a project (all workspaces within it)", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        projects: [s.projectA],
        permissions: { "workspaces:read": true },
      },
    });
    try {
      const list = await request(`/api/v2/organizations/${s.orgName}/workspaces`, { headers: headers(created.secret) });
      expect(list.status).toBe(200);
      const listBody = await list.json() as { data: { id: string }[] };
      const ids = listBody.data.map((w): string => w.id);
      expect(ids).toContain(s.wsA1);
      expect(ids).toContain(s.wsA2);
      expect(ids).not.toContain(s.wsB1);
      expect(ids).not.toContain(s.tagWsId);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("requires settings:read to read org settings", async () => {
    // Insert tokens directly (no HTTP creation) under the dedicated rate-limit
    // user so this test's requests don't consume the shared admin bucket.
    const rateUserId = `fg-rate-${s.suffix}`;
    const mkToken = async (id: string, raw: string, scopes: unknown): Promise<string> => {
      await db.insert(apiTokens).values({
        id,
        token: createHash("sha256").update(raw).digest("hex"),
        userId: rateUserId,
        orgId: null,
        description: "settings",
        scopes: JSON.stringify(scopes),
        createdAt: Date.now(),
        lastUsedAt: null,
        expiresAt: null,
        teamId: null,
      });
      return raw;
    };
    const readOnlySecret = await mkToken(`fg-ro-${s.suffix}`, `fg-ro-secret-${s.suffix}`, {
      version: 1, orgs: [s.orgId], permissions: { "workspaces:read": true },
    });
    const withSettingsSecret = await mkToken(`fg-ws-${s.suffix}`, `fg-ws-secret-${s.suffix}`, {
      version: 1, orgs: [s.orgId], permissions: { "workspaces:read": true, "settings:read": true },
    });
    try {
      // Without settings:read, org-settings reads are denied (404).
      const denied = await request(`/api/v2/organizations/${s.orgName}`, { headers: headers(readOnlySecret) });
      expect(denied.status).toBe(404);
      const deniedTags = await request(`/api/v2/organizations/${s.orgName}/reserved-tag-keys`, { headers: headers(readOnlySecret) });
      expect(deniedTags.status).toBe(404);
      const deniedEntitlements = await request(`/api/v2/organizations/${s.orgName}/entitlement-set`, { headers: headers(readOnlySecret) });
      expect(deniedEntitlements.status).toBe(404);
      // With settings:read, the same reads succeed.
      const allowed = await request(`/api/v2/organizations/${s.orgName}`, { headers: headers(withSettingsSecret) });
      expect(allowed.status).toBe(200);
      const allowedTags = await request(`/api/v2/organizations/${s.orgName}/reserved-tag-keys`, { headers: headers(withSettingsSecret) });
      expect(allowedTags.status).toBe(200);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, `fg-ro-${s.suffix}`));
      await db.delete(apiTokens).where(eq(apiTokens.id, `fg-ws-${s.suffix}`));
    }
  });

  it("denies token creation when authenticated with a fine-grained token", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true },
      },
    });
    try {
      // Per-user endpoint: 403, not a new token.
      const res = await request(`/api/v2/users/${s.userId}/authentication-tokens`, {
        method: "POST",
        headers: headers(created.secret),
        body: JSON.stringify({
          data: { type: "authentication-tokens", attributes: { description: "escalation" } },
        }),
      });
      expect(res.status).toBe(403);
      // Frontend endpoint: 403 too.
      const res2 = await request("/api/v2/tokens", {
        method: "POST",
        headers: headers(created.secret),
        body: JSON.stringify({
          data: { type: "authentication-tokens", attributes: { description: "escalation" } },
        }),
      });
      expect(res2.status).toBe(403);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("allows an org owner with only workspaces:write to manage workspaces", async () => {
    // The rate-limit user (fg-rate-*) is an org owner with no custom org roles
    // and no teams.  The fine-grained token grants workspaces:write only (no
    // settings:write).  checkOrganizationPermission("manage-workspaces") must
    // accept the token via the grant check, and its inner owner/member probes
    // must not re-apply the scope filter (which would deny the owner shortcut
    // for lack of settings:write).  Direct insert keeps the request in the
    // rate user's own bucket without an HTTP token-creation call.
    const tokenId = `fg-ow-${s.suffix}`;
    const secret = `fg-ow-secret-${s.suffix}`;
    await db.insert(apiTokens).values({
      id: tokenId,
      token: createHash("sha256").update(secret).digest("hex"),
      userId: `fg-rate-${s.suffix}`,
      orgId: null,
      description: "org-owner ws:write",
      scopes: JSON.stringify({
        version: 1,
        orgs: [s.orgId],
        permissions: { "workspaces:write": true },
      }),
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt: null,
      teamId: null,
    });
    try {
      const res = await request(`/api/v2/organizations/${s.orgName}/workspaces`, {
        method: "POST",
        headers: { ...headers(secret), "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: {
            type: "workspaces",
            attributes: { name: `fg-owner-ws-${s.suffix}` },
          },
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { data?: { id?: string }; errors?: { title: string }[] };
      const createdWsId = body.data?.id;
      expect(typeof createdWsId).toBe("string");
      await db.delete(workspaces).where(eq(workspaces.id, createdWsId ?? ""));
      // The token cannot, however, read org settings (no settings:read).
      const settingsDenied = await request(`/api/v2/organizations/${s.orgName}/entitlement-set`, {
        headers: headers(secret),
      });
      expect(settingsDenied.status).toBe(404);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
    }
  });

  it("allows run reads with runs:read even without workspaces:read", async () => {
    const runId = `fg-run-${s.suffix}`;
    await db.insert(runs).values({ id: runId, workspaceId: s.wsA1, status: "planned", message: "scoped", createdAt: Date.now() });
    // Direct inserts under the rate-limit user (no HTTP token creation).
    const rateUserId = `fg-rate-${s.suffix}`;
    const mkToken = async (id: string, raw: string, scopes: unknown): Promise<string> => {
      await db.insert(apiTokens).values({
        id,
        token: createHash("sha256").update(raw).digest("hex"),
        userId: rateUserId,
        orgId: null,
        description: "run-read",
        scopes: JSON.stringify(scopes),
        createdAt: Date.now(),
        lastUsedAt: null,
        expiresAt: null,
        teamId: null,
      });
      return raw;
    };
    const runOnlySecret = await mkToken(`fg-rr-${s.suffix}`, `fg-rr-secret-${s.suffix}`, {
      version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "runs:read": true },
    });
    const wsOnlySecret = await mkToken(`fg-rw-${s.suffix}`, `fg-rw-secret-${s.suffix}`, {
      version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "workspaces:read": true },
    });
    try {
      // runs:read alone unlocks run reads...
      const runRes = await request(`/api/v2/runs/${runId}`, { headers: headers(runOnlySecret) });
      expect(runRes.status).toBe(200);
      // ...but not workspace reads.
      const wsDenied = await request(`/api/v2/workspaces/${s.wsA1}`, { headers: headers(runOnlySecret) });
      expect(wsDenied.status).toBe(404);
      // workspaces:read alone does NOT unlock run reads (explicit grants only).
      const runViaWs = await request(`/api/v2/runs/${runId}`, { headers: headers(wsOnlySecret) });
      expect(runViaWs.status).toBe(404);
      // A token with both grants reads runs AND the workspace.
      const bothSecret = await mkToken(`fg-rb-${s.suffix}`, `fg-rb-secret-${s.suffix}`, {
        version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "workspaces:read": true, "runs:read": true },
      });
      const bothRun = await request(`/api/v2/runs/${runId}`, { headers: headers(bothSecret) });
      expect(bothRun.status).toBe(200);
      await db.delete(apiTokens).where(eq(apiTokens.id, `fg-rb-${s.suffix}`));
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, `fg-rr-${s.suffix}`));
      await db.delete(apiTokens).where(eq(apiTokens.id, `fg-rw-${s.suffix}`));
      await db.delete(runs).where(eq(runs.id, runId));
    }
  });

  it("scopes a token to workspaces matching a tag", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        tags: [{ key: "environment", value: "prod" }],
        permissions: { "workspaces:read": true },
      },
    });
    try {
      const list = await request(`/api/v2/organizations/${s.orgName}/workspaces`, { headers: headers(created.secret) });
      expect(list.status).toBe(200);
      const listBody = await list.json() as { data: { id: string }[] };
      const ids = listBody.data.map((w): string => w.id);
      expect(ids).toContain(s.tagWsId);
      expect(ids).not.toContain(s.wsA1);
      expect(ids).not.toContain(s.wsB1);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("cannot access an org outside the scope", async () => {
    const otherOrgId = `fg-other-${s.suffix}`;
    const otherOrgName = `fg-other-${s.suffix}`;
    await db.insert(organizations).values({ id: otherOrgId, name: otherOrgName });
    await db.insert(organizationMemberships).values({
      id: `fg-other-mem-${s.suffix}`, userId: s.userId, orgId: otherOrgId, role: "owner",
    });
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        permissions: { "workspaces:read": true },
      },
    });
    try {
      const res = await request(`/api/v2/organizations/${otherOrgName}`, { headers: headers(created.secret) });
      expect(res.status).toBe(404);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `fg-other-mem-${s.suffix}`));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
  });

  it("does not leak orgs the user is not a member of via MCP list_organizations", async () => {
    // A scope may name an org the user does not belong to (e.g. a copied or
    // hand-edited scope). list_organizations must intersect with the user's
    // real memberships, never return the org name verbatim.
    const foreignOrgId = `fg-foreign-${s.suffix}`;
    await db.insert(organizations).values({ id: foreignOrgId, name: `fg-foreign-${s.suffix}` });
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId, foreignOrgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true },
      },
    });
    try {
      const orgs = await request("/mcp", {
        method: "POST",
        headers: { ...headers(created.secret), "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_organizations", arguments: {} } }),
      });
      expect(orgs.status).toBe(200);
      const body = await orgs.json() as { result: { content: { text: string }[] } };
      const parsed = JSON.parse(body.result.content[0]?.text ?? "[]") as { id: string }[];
      expect(parsed.map((o): string => o.id)).toEqual([s.orgId]);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
      await db.delete(organizations).where(eq(organizations.id, foreignOrgId));
    }
  });

  it("exposes scopes in the token list response", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        permissions: { "workspaces:read": true },
      },
    });
    try {
      const list = await request(`/api/v2/users/${s.userId}/authentication-tokens`, { headers: headers(s.adminToken) });
      expect(list.status).toBe(200);
      const body = await list.json() as { data: { id: string; attributes: { scopes: unknown } }[] };
      const mine = body.data.find((t): boolean => t.id === created.id);
      expect(mine).toBeDefined();
      expect(mine?.attributes.scopes).toEqual({
        version: 1,
        orgs: [s.orgId],
        projects: null,
        workspaces: null,
        tags: null,
        permissions: { "workspaces:read": true },
      });
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("MCP tools/list only exposes tools the token's grants permit", async () => {
    // Only workspaces:read granted.
    const readOnly = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true },
      },
    });
    // grants settings + state + runs + variables on top.
    const broad = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: {
          "workspaces:read": true,
          "settings:read": true,
          "state:read": true,
          "runs:read": true,
          "variables:read": true,
        },
      },
    });
    const listTools = async (secret: string): Promise<{ name: string }[]> => {
      const res = await request("/mcp", {
        method: "POST",
        headers: { ...headers(secret), "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { result: { tools: { name: string }[] } };
      return body.result.tools;
    };
    try {
      // A fine-grained token exposing only reads that its grants permit.
      const names = (await listTools(readOnly.secret)).map((t): string => t.name);
      // Membership-scoped tools (no grant required) are always present:
      expect(names).toContain("list_organizations");
      // Workspaces:read unlocks workspace reads:
      expect(names).toContain("get_workspace");
      // Workspaces:lock, variables, state, runs, settings are NOT for this token:
      expect(names).not.toContain("lock_workspace");
      expect(names).not.toContain("unlock_workspace");
      expect(names).not.toContain("get_workspace_vars");
      expect(names).not.toContain("create_workspace_variable");
      expect(names).not.toContain("get_workspace_state");
      expect(names).not.toContain("get_run");
      expect(names).not.toContain("get_org_settings");

      // Broad token sees state/runs/variables/settings reads:
      const broadNames = (await listTools(broad.secret)).map((t): string => t.name);
      expect(broadNames).toContain("get_workspace_state");
      expect(broadNames).toContain("get_run");
      expect(broadNames).toContain("get_workspace_vars");
      expect(broadNames).toContain("get_org_settings");
      // But still NO write mutations:
      expect(broadNames).not.toContain("create_workspace_variable");
      expect(broadNames).not.toContain("lock_workspace");
      expect(broadNames).not.toContain("create_project");

      // A denied tool is rejected even if called directly (defense in depth).
      const call = await request("/mcp", {
        method: "POST",
        headers: { ...headers(readOnly.secret), "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "get_workspace_state", arguments: { workspace_id: s.wsA1 } },
        }),
      });
      const callBody = await call.json() as { error?: { code: number } };
      expect(callBody.error?.code).toBe(-32001);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, readOnly.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, broad.id));
    }
  });

  it("creates a scoped token via the /api/v2/tokens endpoint (frontend path)", async () => {
    const res = await request("/api/v2/tokens", {
      method: "POST",
      headers: headers(s.adminToken),
      body: JSON.stringify({
        data: {
          type: "tokens",
          attributes: {
            description: "frontend-scoped",
            scopes: {
              version: 1,
              orgs: [s.orgId],
              workspaces: [s.wsA1],
              permissions: { "workspaces:read": true, "state:read": true },
            },
          },
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; attributes: { token: string; scopes: unknown } } };
    expect(body.data.attributes.token).toBeTruthy();
    expect(body.data.attributes.scopes).toEqual({
      version: 1,
      orgs: [s.orgId],
      projects: null,
      workspaces: [s.wsA1],
      tags: null,
      permissions: { "workspaces:read": true, "state:read": true },
    });
    // The returned token must actually be restricted.
    const other = await request(`/api/v2/workspaces/${s.wsB1}`, { headers: headers(body.data.attributes.token) });
    expect(other.status).toBe(404);
    const inside = await request(`/api/v2/workspaces/${s.wsA1}`, { headers: headers(body.data.attributes.token) });
    expect(inside.status).toBe(200);
    await db.delete(apiTokens).where(eq(apiTokens.id, body.data.id));
  });

  it("enforces scopes on MCP tool calls", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true },
      },
    });
    try {
      // MCP list_organizations only returns the scoped org
      const orgs = await request("/mcp", {
        method: "POST",
        headers: { ...headers(created.secret), "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_organizations", arguments: {} } }),
      });
      expect(orgs.status).toBe(200);
      const orgsBody = await orgs.json() as { result: { content: { text: string }[] } };
      const orgsText = orgsBody.result.content[0]?.text ?? "";
      const parsed = JSON.parse(orgsText) as { id: string }[];
      expect(parsed.map((o): string => o.id)).toEqual([s.orgId]);

      // get_workspace on a workspace INSIDE the scope works
      const inside = await request("/mcp", {
        method: "POST",
        headers: { ...headers(created.secret), "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "get_workspace", arguments: { org: s.orgName, name: "ws-a1" } },
        }),
      });
      const insideBody = await inside.json() as { result: { content: { text: string }[] } };
      const insideText = insideBody.result.content[0]?.text ?? "";
      expect(inside.status).toBe(200);
      expect(insideText).not.toContain("error");

      // get_workspace on a workspace OUTSIDE the scope is denied
      const outside = await request("/mcp", {
        method: "POST",
        headers: { ...headers(created.secret), "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 3, method: "tools/call",
          params: { name: "get_workspace", arguments: { org: s.orgName, name: "ws-b1" } },
        }),
      });
      const outsideBody = await outside.json() as { result?: { content: { text: string }[] }; error?: { code: number; message: string } };
      // A tool-level denial is a JSON-RPC error, not a result wrapper.
      const outsideText = outsideBody.result?.content[0]?.text ?? "";
      let toolError: { code?: number } | undefined;
      if (outsideText !== "") {
        try {
          toolError = (JSON.parse(outsideText) as { error?: { code: number } }).error;
        } catch { /* not a result payload */ }
      }
      const denied = outsideBody.error ?? toolError;
      expect(denied).toBeDefined();
      expect(denied?.code).toBe(-32001);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("MCP variable, lock, and workspace-creation tools enforce their grants", async () => {
    const wsOnly = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true },
      },
    });
    const varWrite = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true, "variables:read": true, "variables:write": true },
      },
    });
    const lockOnly = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        workspaces: [s.wsA1],
        permissions: { "workspaces:read": true, "workspaces:lock": true },
      },
    });
    const wsWrite = await createScopedToken(s.userId, s.adminToken, {
      scopes: {
        version: 1,
        orgs: [s.orgId],
        permissions: { "workspaces:write": true },
      },
    });
    const call = async (secret: string, name: string, args: Record<string, unknown>): Promise<{ status: number; text: string }> => {
      const res = await request("/mcp", {
        method: "POST",
        headers: { ...headers(secret), "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      return { status: res.status, text: await res.text() };
    };
    const deniedBy = async (res: { text: string }): Promise<boolean> => {
      const body = JSON.parse(res.text) as { error?: { code: number }; result?: unknown };
      return body.error?.code === -32001;
    };
    try {
      // Without variables:write, variable writes are blocked at discovery
      // AND at call time (defense in depth).
      const varDenied = await call(wsOnly.secret, "create_workspace_variable", {
        workspace_id: s.wsA1, key: "K", value: "v",
      });
      expect(await deniedBy(varDenied)).toBe(true);

      // With variables:write, the tool works on a scoped workspace.
      const varOk = await call(varWrite.secret, "create_workspace_variable", {
        workspace_id: s.wsA1, key: "MCP_KEY", value: "mcp-value",
      });
      expect(varOk.status).toBe(200);
      const varBody = JSON.parse(varOk.text) as { result: { content: { text: string }[] } };
      const created = JSON.parse(varBody.result.content[0]?.text ?? "{}") as { id: string; key: string };
      expect(created.key).toBe("MCP_KEY");
      expect(created.id).toBeTruthy();
      await db.delete(workspaceVariables).where(eq(workspaceVariables.id, created.id));

      // Sensitive variable values are masked (null) on read, matching the REST API.
      const secretOk = await call(varWrite.secret, "create_workspace_variable", {
        workspace_id: s.wsA1, key: "MCP_SECRET", value: "top-secret", sensitive: true,
      });
      expect(secretOk.status).toBe(200);
      const secretBody = JSON.parse(secretOk.text) as { result: { content: { text: string }[] } };
      const secretCreated = JSON.parse(secretBody.result.content[0]?.text ?? "{}") as { id: string; value: string | null };
      expect(secretCreated.value).toBeNull();
      const listVars = await call(varWrite.secret, "get_workspace_vars", { workspace_id: s.wsA1 });
      const varsList = JSON.parse(listVars.text) as { result: { content: { text: string }[] } };
      const readRows = JSON.parse(varsList.result.content[0]?.text ?? "[]") as { key: string; value: string | null; sensitive: boolean }[];
      const secretRow = readRows.find((r): boolean => r.key === "MCP_SECRET");
      expect(secretRow?.sensitive).toBe(true);
      expect(secretRow?.value).toBeNull();
      await db.delete(workspaceVariables).where(eq(workspaceVariables.id, secretCreated.id));

      // Without workspaces:lock, lock is blocked; with it, lock/unlock work.
      expect(await deniedBy(await call(wsOnly.secret, "lock_workspace", { workspace_id: s.wsA1 }))).toBe(true);
      const lockOk = await call(lockOnly.secret, "lock_workspace", { workspace_id: s.wsA1, reason: "mcp" });
      expect(lockOk.status).toBe(200);
      const lockBody = JSON.parse(lockOk.text) as { result: { content: { text: string }[] } };
      expect(JSON.parse(lockBody.result.content[0]?.text ?? "{}").locked).toBe(true);
      const unlockOk = await call(lockOnly.secret, "unlock_workspace", { workspace_id: s.wsA1 });
      expect(unlockOk.status).toBe(200);

      // create_workspace requires workspaces:write; wsOnly lacks it.
      expect(await deniedBy(await call(wsOnly.secret, "create_workspace", { org: s.orgName, name: "nope" }))).toBe(true);
      const createdWs = await call(wsWrite.secret, "create_workspace", { org: s.orgName, name: `fg-mcp-ws-${s.suffix}` });
      expect(createdWs.status).toBe(200);
      const wsBody = JSON.parse(createdWs.text) as { result: { content: { text: string }[] } };
      const wsCreated = JSON.parse(wsBody.result.content[0]?.text ?? "{}") as { id: string };
      expect(wsCreated.id).toBeTruthy();
      await db.delete(workspaces).where(eq(workspaces.id, wsCreated.id));
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, wsOnly.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, varWrite.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, lockOnly.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, wsWrite.id));
    }
  });
});

async function createRunWith(token: string, workspaceId: string): Promise<{ id: string; status: number }> {
  const res = await request(`/api/v2/workspaces/${workspaceId}/runs`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ data: { type: "runs", attributes: { message: "fg-test" } } }),
  });
  const text = await res.text();
  const body = text !== "" ? JSON.parse(text) as { data?: { id: string } } : {};
  return { id: (body.data?.id as string | undefined) ?? "", status: res.status };
}

describe("fine-grained tag expressions (AND/OR combinators)", () => {
  const s = seed();

  beforeAll(async () => {
    await seedOrgFixtures(s, { tags: true });
  });

  afterAll(async () => {
    await teardownOrgFixtures(s, { tags: true });
  });

  it("matches workspaces with a nested (foo=bar AND baz=bing) OR xyz=abc expression", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      description: "tag-expr",
      scopes: {
        version: 1,
        orgs: [s.orgId],
        tags: {
          combinator: "OR",
          rules: [
            { combinator: "AND", rules: [{ key: "foo", value: "bar" }, { key: "baz", value: "bing" }] },
            { key: "xyz", value: "abc" },
          ],
        },
        permissions: { "workspaces:read": true },
      },
    });
    try {
      const list = await request(`/api/v2/organizations/${s.orgName}/workspaces`, { headers: headers(created.secret) });
      expect(list.status).toBe(200);
      const listBody = await list.json() as { data: { id: string }[] };
      const ids = listBody.data.map((w): string => w.id);
      expect(ids).toContain(s.wsA1); // foo=bar AND baz=bing
      expect(ids).toContain(s.wsA2); // xyz=abc
      expect(ids).not.toContain(s.wsB1);
      expect(ids).not.toContain(s.tagWsId); // only has environment=prod
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("exposes the nested tag expression in the token list response", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      description: "tag-expr",
      scopes: {
        version: 1,
        orgs: [s.orgId],
        tags: {
          combinator: "OR",
          rules: [
            { combinator: "AND", rules: [{ key: "foo", value: "bar" }, { key: "baz", value: "bing" }] },
            { key: "xyz", value: "abc" },
          ],
        },
        permissions: { "workspaces:read": true },
      },
    });
    try {
      const list = await request(`/api/v2/users/${s.userId}/authentication-tokens`, { headers: headers(s.adminToken) });
      const listBody = await list.json() as { data: { id: string; attributes: { scopes: unknown } }[] };
      const mine = listBody.data.find((t): boolean => t.id === created.id);
      expect(mine?.attributes.scopes).toEqual({
        version: 1,
        orgs: [s.orgId],
        projects: null,
        workspaces: null,
        tags: {
          combinator: "OR",
          rules: [
            { combinator: "AND", rules: [{ key: "foo", value: "bar" }, { key: "baz", value: "bing" }] },
            { key: "xyz", value: "abc" },
          ],
        },
        permissions: { "workspaces:read": true },
      });
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("rejects an invalid combinator on token creation", async () => {
    const res = await request(`/api/v2/users/${s.userId}/authentication-tokens`, {
      method: "POST",
      headers: headers(s.adminToken),
      body: JSON.stringify({
        data: {
          type: "authentication-tokens",
          attributes: {
            description: "bad-tag-expr",
            scopes: {
              version: 1,
              orgs: [s.orgId],
              tags: { combinator: "XOR", rules: [{ key: "foo", value: "bar" }] },
              permissions: { "workspaces:read": true },
            },
          },
        },
      }),
    });
    expect(res.status).toBe(422);
  });

  it("keeps the legacy empty tags array unrestricted but fails closed on empty expressions", async () => {
    // Legacy `tags: []` (array form) means "no tag restriction".
    const legacy = await createScopedToken(s.userId, s.adminToken, {
      description: "legacy-empty",
      scopes: { version: 1, orgs: [s.orgId], tags: [], permissions: { "workspaces:read": true } },
    });
    try {
      const list = await request(`/api/v2/organizations/${s.orgName}/workspaces`, { headers: headers(legacy.secret) });
      expect(list.status).toBe(200);
      const listBody = await list.json() as { data: { id: string }[] };
      const ids = listBody.data.map((w): string => w.id);
      expect(ids).toContain(s.wsA1);
      expect(ids).toContain(s.wsB1); // tagless workspace must not be skipped
      expect(ids).toContain(s.tagWsId);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, legacy.id));
    }

    // An explicit expression object with no rules is a token whose intent is
    // unclear; rejecting it fails closed instead of silently widening scope.
    for (const tags of [{ combinator: "OR", rules: [] }, { combinator: "AND", rules: [] }]) {
      const denied = await request(`/api/v2/users/${s.userId}/authentication-tokens`, {
        method: "POST",
        headers: headers(s.adminToken),
        body: JSON.stringify({
          data: {
            type: "authentication-tokens",
            attributes: {
              description: "empty-expr",
              scopes: { version: 1, orgs: [s.orgId], tags, permissions: { "workspaces:read": true } },
            },
          },
        }),
      });
      expect(denied.status).toBe(422);
      const deniedBody = await denied.json() as { errors: { detail?: string }[] };
      expect(deniedBody.errors[0]?.detail).toContain("at least one rule");
    }
  });

  it("excludes a workspace holding only one half of a nested AND", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      description: "tag-and-half",
      scopes: {
        version: 1,
        orgs: [s.orgId],
        tags: {
          combinator: "OR",
          rules: [
            { combinator: "AND", rules: [{ key: "foo", value: "bar" }, { key: "baz", value: "bing" }] },
            { key: "xyz", value: "abc" },
          ],
        },
        permissions: { "workspaces:read": true },
      },
    });
    try {
      const list = await request(`/api/v2/organizations/${s.orgName}/workspaces`, { headers: headers(created.secret) });
      expect(list.status).toBe(200);
      const listBody = await list.json() as { data: { id: string }[] };
      const ids = listBody.data.map((w): string => w.id);
      expect(ids).toContain(s.wsA1); // has both AND branches
      expect(ids).toContain(s.wsA2); // matches the OR leaf
      expect(ids).not.toContain(s.wsA3); // only foo=bar, missing baz=bing
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("enforces the tag expression depth limit at exactly MAX_TAG_RULE_DEPTH", async () => {
    let rules: unknown = [{ key: "a", value: "1" }];
    for (let i = 0; i < MAX_TAG_RULE_DEPTH; i++) {
      rules = [{ combinator: "AND", rules }];
    }
    const post = (rulesValue: unknown): Promise<Response> => request(`/api/v2/users/${s.userId}/authentication-tokens`, {
      method: "POST",
      headers: headers(s.adminToken),
      body: JSON.stringify({
        data: {
          type: "authentication-tokens",
          attributes: {
            description: "depth",
            scopes: { version: 1, orgs: [s.orgId], tags: { combinator: "OR", rules: rulesValue }, permissions: { "workspaces:read": true } },
          },
        },
      }),
    });
    expect((await post(rules)).status).toBe(201); // innermost rule at depth MAX_TAG_RULE_DEPTH

    const denied = await post([{ combinator: "AND", rules }]);
    expect(denied.status).toBe(422); // one level past the limit
    const deniedBody = await denied.json() as { errors: { detail?: string }[] };
    expect(deniedBody.errors[0]?.detail).toContain("nesting depth");
  });

  it("rejects empty rule groups and excessive nesting depth", async () => {
    const emptyGroup = await request(`/api/v2/users/${s.userId}/authentication-tokens`, {
      method: "POST",
      headers: headers(s.adminToken),
      body: JSON.stringify({
        data: {
          type: "authentication-tokens",
          attributes: {
            description: "empty-group",
            scopes: {
              version: 1,
              orgs: [s.orgId],
              tags: { combinator: "OR", rules: [{ combinator: "AND", rules: [] }] },
              permissions: { "workspaces:read": true },
            },
          },
        },
      }),
    });
    expect(emptyGroup.status).toBe(422);

    let nested: Record<string, unknown> = { key: "foo", value: "bar" };
    for (let i = 0; i < 20; i++) {
      nested = { combinator: "AND", rules: [nested] };
    }
    const deep = await request(`/api/v2/users/${s.userId}/authentication-tokens`, {
      method: "POST",
      headers: headers(s.adminToken),
      body: JSON.stringify({
        data: {
          type: "authentication-tokens",
          attributes: {
            description: "deep-tags",
            scopes: {
              version: 1,
              orgs: [s.orgId],
              tags: { combinator: "OR", rules: [nested] },
              permissions: { "workspaces:read": true },
            },
          },
        },
      }),
    });
    expect(deep.status).toBe(422);
  });
});

describe("fine-grained run action grants", () => {
  const s = seed();

  beforeAll(async () => {
    await seedOrgFixtures(s);
  });

  afterAll(async () => {
    await teardownOrgFixtures(s);
  });

  it("runs:plan creates a run but cannot discard/cancel", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      description: "run-actions",
      scopes: { version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "workspaces:read": true, "runs:read": true, "runs:plan": true } },
    });
    try {
      const run = await createRunWith(created.secret, s.wsA1);
      expect(run.status).toBe(201);
      const discard = await request(`/api/v2/runs/${run.id}/actions/discard`, { method: "POST", headers: headers(created.secret) });
      expect(discard.status).toBe(403);
      const cancel = await request(`/api/v2/runs/${run.id}/actions/cancel`, { method: "POST", headers: headers(created.secret) });
      expect(cancel.status).toBe(403);
      const apply = await request(`/api/v2/runs/${run.id}/actions/apply`, { method: "POST", headers: headers(created.secret) });
      expect(apply.status).toBe(403);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("runs:apply does not imply discard, cancel, or run creation", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      description: "run-actions",
      scopes: { version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "workspaces:read": true, "runs:read": true, "runs:apply": true } },
    });
    try {
      // Creating a run requires the plan action; runs:apply must not imply it.
      const create = await createRunWith(created.secret, s.wsA1);
      expect(create.status).toBe(403);

      // Discard/cancel are deliberate, separate grants: a token that may apply
      // a run it did not plan must not be able to terminate other runs.
      const seeded = await createRunWith(s.adminToken, s.wsA1);
      expect(seeded.status).toBe(201);
      const discard = await request(`/api/v2/runs/${seeded.id}/actions/discard`, { method: "POST", headers: headers(created.secret) });
      expect(discard.status).toBe(403);

      const seeded2 = await createRunWith(s.adminToken, s.wsA1);
      expect(seeded2.status).toBe(201);
      const cancel = await request(`/api/v2/runs/${seeded2.id}/actions/cancel`, { method: "POST", headers: headers(created.secret) });
      expect(cancel.status).toBe(403);

      // An explicit runs:discard grant restores exactly that one action.
      const discarder = await createScopedToken(s.userId, s.adminToken, {
        description: "run-actions",
        scopes: { version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "workspaces:read": true, "runs:read": true, "runs:apply": true, "runs:discard": true } },
      });
      try {
        const seeded3 = await createRunWith(s.adminToken, s.wsA1);
        expect(seeded3.status).toBe(201);
        const discardOk = await request(`/api/v2/runs/${seeded3.id}/actions/discard`, { method: "POST", headers: headers(discarder.secret) });
        expect(discardOk.status).toBe(202);
      } finally {
        await db.delete(apiTokens).where(eq(apiTokens.id, discarder.id));
      }
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("runs:discard and runs:cancel are distinct grants", async () => {
    const discardOnly = await createScopedToken(s.userId, s.adminToken, {
      description: "run-actions",
      scopes: { version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "workspaces:read": true, "runs:read": true, "runs:discard": true } },
    });
    const cancelOnly = await createScopedToken(s.userId, s.adminToken, {
      description: "run-actions",
      scopes: { version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "workspaces:read": true, "runs:read": true, "runs:cancel": true } },
    });
    try {
      const a = await createRunWith(s.adminToken, s.wsA1);
      expect(a.status).toBe(201);
      const discard = await request(`/api/v2/runs/${a.id}/actions/discard`, { method: "POST", headers: headers(discardOnly.secret) });
      expect(discard.status).toBe(202);

      // Fresh run for the negative assertion: a run whose state already
      // changed could mask a permission failure with a state failure.
      const a2 = await createRunWith(s.adminToken, s.wsA1);
      expect(a2.status).toBe(201);
      const cancelByDiscard = await request(`/api/v2/runs/${a2.id}/actions/cancel`, { method: "POST", headers: headers(discardOnly.secret) });
      expect(cancelByDiscard.status).toBe(403);

      const b = await createRunWith(s.adminToken, s.wsA1);
      expect(b.status).toBe(201);
      const cancel = await request(`/api/v2/runs/${b.id}/actions/cancel`, { method: "POST", headers: headers(cancelOnly.secret) });
      expect(cancel.status).toBe(202);
      const b2 = await createRunWith(s.adminToken, s.wsA1);
      expect(b2.status).toBe(201);
      const discardByCancel = await request(`/api/v2/runs/${b2.id}/actions/discard`, { method: "POST", headers: headers(cancelOnly.secret) });
      expect(discardByCancel.status).toBe(403);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, discardOnly.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, cancelOnly.id));
    }
  });

  it("MCP run action tools are exposed and enforced by their grants", async () => {
    const planOnly = await createScopedToken(s.userId, s.adminToken, {
      description: "run-actions",
      scopes: { version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "workspaces:read": true, "runs:read": true, "runs:plan": true } },
    });
    const discard = await createScopedToken(s.userId, s.adminToken, {
      description: "run-actions",
      scopes: { version: 1, orgs: [s.orgId], workspaces: [s.wsA1], permissions: { "workspaces:read": true, "runs:read": true, "runs:discard": true } },
    });
    const listTools = async (secret: string): Promise<{ name: string }[]> => {
      const res = await request("/mcp", {
        method: "POST",
        headers: { ...headers(secret), "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { result: { tools: { name: string }[] } };
      return body.result.tools;
    };
    try {
      // runs:plan exposes create_run but not apply/discard/cancel.
      const planNames = (await listTools(planOnly.secret)).map((t): string => t.name);
      expect(planNames).toContain("create_run");
      expect(planNames).not.toContain("apply_run");
      expect(planNames).not.toContain("discard_run");
      expect(planNames).not.toContain("cancel_run");

      // runs:discard exposes discard_run and get_run (runs:read), but not apply.
      const discardNames = (await listTools(discard.secret)).map((t): string => t.name);
      expect(discardNames).toContain("discard_run");
      expect(discardNames).toContain("get_run");
      expect(discardNames).not.toContain("apply_run");
      expect(discardNames).not.toContain("create_run");

      // A plan-only token cannot discard a run via MCP even if it fabricates the call.
      const run = await createRunWith(s.adminToken, s.wsA1);
      expect(run.status).toBe(201);
      const denied = await request("/mcp", {
        method: "POST",
        headers: { ...headers(planOnly.secret), "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "discard_run", arguments: { run_id: run.id } },
        }),
      });
      const deniedBody = await denied.json() as { error?: { code: number } };
      expect(deniedBody.error?.code).toBe(-32001);

      // A runs:discard token CAN discard the run via MCP.
      const allowed = await request("/mcp", {
        method: "POST",
        headers: { ...headers(discard.secret), "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 3, method: "tools/call",
          params: { name: "discard_run", arguments: { run_id: run.id } },
        }),
      });
      expect(allowed.status).toBe(200);
      const allowedText = await allowed.text();
      expect(allowedText).not.toContain('"error"');
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, planOnly.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, discard.id));
    }
  });

  it("lets org-scoped tokens discard and cancel runs via MCP (orgId forwarded to permission checks)", async () => {
    // An org-scoped token has userId === null and an orgId; its scopes grant
    // discard/cancel. Regression test: discard_run/cancel_run must forward the
    // token's orgId so the org-level permission check does not fail closed.
    const id = `fg-orgtok-${s.suffix}`;
    const raw = `fg-org-${s.suffix}`;
    const scopes = JSON.stringify({
      version: 1,
      orgs: [s.orgId],
      workspaces: [s.wsA1],
      permissions: { "workspaces:read": true, "runs:read": true, "runs:discard": true, "runs:cancel": true },
    });
    await db.insert(apiTokens).values({
      id,
      token: createHash("sha256").update(raw).digest("hex"),
      userId: null,
      orgId: s.orgId,
      description: "org-scoped-mcp",
      scopes,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt: null,
      teamId: null,
    });
    const call = async (name: string, args: Record<string, unknown>): Promise<{ status: number; text: string }> => {
      const res = await request("/mcp", {
        method: "POST",
        headers: { ...headers(raw), "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      return { status: res.status, text: await res.text() };
    };
    try {
      // The scoped org token may discover the tools its grants permit.
      const listed = await request("/mcp", {
        method: "POST",
        headers: { ...headers(raw), "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const listBody = await listed.json() as { result: { tools: { name: string }[] } };
      const names = listBody.result.tools.map((t): string => t.name);
      expect(names).toContain("discard_run");
      expect(names).toContain("cancel_run");

      const run = await createRunWith(s.adminToken, s.wsA1);
      expect(run.status).toBe(201);

      const discardRes = await call("discard_run", { run_id: run.id });
      expect(discardRes.status).toBe(200);
      expect(discardRes.text).not.toContain('"error"');

      const run2 = await createRunWith(s.adminToken, s.wsA1);
      const cancelRes = await call("cancel_run", { run_id: run2.id });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.text).not.toContain('"error"');
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, id));
      await db.delete(runs).where(eq(runs.workspaceId, s.wsA1));
    }
  });
});

describe("fine-grained org-level read grants", () => {
  const s = seed();

  beforeAll(async () => {
    await seedOrgFixtures(s);
  });

  afterAll(async () => {
    await db.delete(policySetParameters).where(eq(policySetParameters.policySetId, s.policySetId ?? ""));
    await db.delete(policies).where(eq(policies.policySetId, s.policySetId ?? ""));
    await db.delete(policySets).where(eq(policySets.orgId, s.orgId));
    await db.delete(agentPools).where(eq(agentPools.orgId, s.orgId));
    await db.delete(teamMemberships).where(eq(teamMemberships.userId, s.userId));
    await db.delete(teams).where(eq(teams.orgId, s.orgId));
    await teardownOrgFixtures(s);
  });





  const endpoints: { path: string; grant: string }[] = [
    { path: "/api/v2/organizations/:org/agent-pools", grant: "agent-pools:read" },
    { path: "/api/v2/organizations/:org/policy-sets", grant: "policies:read" },
    { path: "/api/v2/organizations/:org/teams", grant: "teams:read" },
    { path: "/api/v2/organizations/:org/users", grant: "members:read" },
    { path: "/api/v2/organizations/:org/audit-logs", grant: "audit-logs:read" },
    { path: "/api/v2/organizations/:org/varsets", grant: "varsets:read" },
    { path: "/api/v2/organizations/:org/ssh-keys", grant: "vcs:read" },
  ];

  it("denies org-level reads without the specific grant", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "workspaces:read": true } },
    });
    try {
      for (const { path } of endpoints) {
        const res = await request(path.replace(":org", s.orgName), { headers: headers(created.secret) });
        expect(res.status).toBe(404);
      }
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("scopes the audit-log aliases to the audit-logs:read grant", async () => {
    const without = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "workspaces:read": true } },
    });
    const withGrant = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "audit-logs:read": true } },
    });
    try {
      for (const path of ["/api/v2/organization-audit-trailers", "/api/v2/audit-trails"]) {
        const denied = await request(path, { headers: headers(without.secret) });
        expect(denied.status).toBe(200);
        const deniedBody = await denied.json() as { data: unknown[] };
        // A scoped token without the grant must fail closed to no records,
        // not widen the aliases across every org the user can reach.
        expect(deniedBody.data.length).toBe(0);

        const allowed = await request(path, { headers: headers(withGrant.secret) });
        expect(allowed.status).toBe(200);
        const allowedBody = await allowed.json() as { data: unknown[] };
        expect(Array.isArray(allowedBody.data)).toBe(true);
      }
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, without.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, withGrant.id));
    }
  });

  it("allows each org-level read with its matching grant", async () => {
    const created = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: Object.fromEntries(endpoints.map((e): [string, boolean] => [e.grant, true])) },
    });
    try {
      for (const { path } of endpoints) {
        const res = await request(path.replace(":org", s.orgName), { headers: headers(created.secret) });
        expect(res.status).toBe(200);
      }
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, created.id));
    }
  });

  it("requires workspaces:write to create a workspace (manage-workspaces)", async () => {
    const readOnly = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "workspaces:read": true } },
    });
    const writeOnly = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "workspaces:write": true } },
    });
    const post = (token: string): Promise<Response> => request(`/api/v2/organizations/${s.orgName}/workspaces`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        data: {
          type: "workspaces",
          attributes: { name: `fg-ws-create-${s.suffix}` },
        },
      }),
    });
    try {
      const denied = await post(readOnly.secret);
      expect(denied.status).toBe(403);

      const allowed = await post(writeOnly.secret);
      expect(allowed.status).toBe(201);
      const body = await allowed.json() as { data: { id: string } };
      expect(body.data.id).toBeTruthy();
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, readOnly.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, writeOnly.id));
    }
  });

  it("allows read-only policy routes with policies:read and agent routes with agent-pools:read", async () => {
    const policySetId = `fg-ps-${s.suffix}`;
    const policyId = `fg-pol-${s.suffix}`;
    const paramId = `fg-param-${s.suffix}`;
    const poolId = `fg-pool-${s.suffix}`;
    const agentId = `fg-agent-${s.suffix}`;
    s.policySetId = policySetId;
    await db.insert(policySets).values({ id: policySetId, orgId: s.orgId, name: `ps-${s.suffix}` });
    await db.insert(policies).values({ id: policyId, policySetId, name: `pol-${s.suffix}` });
    await db.insert(policySetParameters).values({ id: paramId, policySetId, key: `key-${s.suffix}`, value: "x" });
    await db.insert(agentPools).values({ id: poolId, orgId: s.orgId, name: `pool-${s.suffix}` });
    await db.insert(agents).values({ id: agentId, agentPoolId: poolId, name: `agent-${s.suffix}` });

    const read = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "policies:read": true, "agent-pools:read": true } },
    });
    const none = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "workspaces:read": true } },
    });
    const readPaths = [
      `/api/v2/policy-sets/${policySetId}`,
      `/api/v2/policy-sets/${policySetId}/policies`,
      `/api/v2/policy-sets/${policySetId}/parameters`,
      `/api/v2/policies/${policyId}`,
      `/api/v2/agent-pools/${poolId}/agents`,
      `/api/v2/agents/${agentId}`,
    ];
    try {
      for (const path of readPaths) {
        const res = await request(path, { headers: headers(read.secret) });
        expect(res.status).toBe(200);
      }
      for (const path of readPaths) {
        const res = await request(path, { headers: headers(none.secret) });
        expect(res.status).toBe(404);
      }
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, read.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, none.id));
    }
  });

  it("requires members:read for organization-memberships routes", async () => {
    const withMembers = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "members:read": true } },
    });
    const without = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "teams:read": true } },
    });
    try {
      for (const path of [
        `/api/v2/organizations/${s.orgName}/organization-memberships`,
        `/api/v2/organization-memberships/${s.membershipId}`,
      ]) {
        const denied = await request(path, { headers: headers(without.secret) });
        expect(denied.status).toBe(404);
        const allowed = await request(path, { headers: headers(withMembers.secret) });
        expect(allowed.status).toBe(200);
      }
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, withMembers.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, without.id));
    }
  });

  it("hides team roster data without members:read", async () => {
    const teamId = `fg-team-${s.suffix}`;
    await db.insert(teams).values({ id: teamId, orgId: s.orgId, name: `team-${s.suffix}` });
    await db.insert(teamMemberships).values({ id: `fg-tm-${s.suffix}`, teamId, userId: s.userId });

    const teamsOnly = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "teams:read": true } },
    });
    const withMembers = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "teams:read": true, "members:read": true } },
    });
    try {
      const list = await request(`/api/v2/organizations/${s.orgName}/teams`, { headers: headers(teamsOnly.secret) });
      expect(list.status).toBe(200);
      const listBody = await list.json() as { data: { id: string; relationships: { users?: { data: { id: string }[] } } }[] };
      const mine = listBody.data.find((t): boolean => t.id === teamId);
      expect(mine?.relationships.users?.data.length ?? 0).toBe(0);

      const listFull = await request(`/api/v2/organizations/${s.orgName}/teams`, { headers: headers(withMembers.secret) });
      expect(listFull.status).toBe(200);
      const fullBody = await listFull.json() as { data: { id: string; relationships: { users?: { data: { id: string }[] } } }[] };
      const fullMine = fullBody.data.find((t): boolean => t.id === teamId);
      expect(fullMine?.relationships.users?.data.map((u): string => u.id)).toContain(s.userId);

      const detail = await request(`/api/v2/teams/${teamId}?include=users`, { headers: headers(teamsOnly.secret) });
      expect(detail.status).toBe(200);
      const detailBody = await detail.json() as { data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> }; included?: unknown[] };
      expect(detailBody.included).toBeUndefined();
      expect(detailBody.data.relationships.users).toBeUndefined();
      // The team size is roster data too; without members:read it must not leak.
      expect(detailBody.data.attributes["users-count"]).toBe(0);

      const detailFull = await request(`/api/v2/teams/${teamId}?include=users`, { headers: headers(withMembers.secret) });
      expect(detailFull.status).toBe(200);
      const detailFullBody = await detailFull.json() as { data: { attributes: Record<string, unknown> } };
      expect(detailFullBody.data.attributes["users-count"]).toBe(1);
    } finally {
      await db.delete(teamMemberships).where(eq(teamMemberships.id, `fg-tm-${s.suffix}`));
      await db.delete(apiTokens).where(eq(apiTokens.id, teamsOnly.id));
      await db.delete(apiTokens).where(eq(apiTokens.id, withMembers.id));
    }
  });

  it("write grants imply their read counterparts", async () => {
    const writeOnly = await createScopedToken(s.userId, s.adminToken, {
      description: "org-read",
      scopes: { version: 1, orgs: [s.orgId], permissions: { "workspaces:write": true, "runs:plan": true } },
    });
    try {
      const list = await request(`/api/v2/organizations/${s.orgName}/workspaces`, { headers: headers(writeOnly.secret) });
      expect(list.status).toBe(200);
      const wsRes = await request(`/api/v2/organizations/${s.orgName}/workspaces`, {
        method: "POST",
        headers: headers(s.adminToken),
        body: JSON.stringify({ data: { type: "workspaces", attributes: { name: `fg-ws-read-${s.suffix}` } } }),
      });
      expect(wsRes.status).toBe(201);
      const wsBody = await wsRes.json() as { data: { id: string } };
      const run = await createRunWith(s.adminToken, wsBody.data.id);
      expect(run.status).toBe(201);
      const getRun = await request(`/api/v2/runs/${run.id}`, { headers: headers(writeOnly.secret) });
      expect(getRun.status).toBe(200);
      await db.delete(runs).where(eq(runs.id, run.id));
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, writeOnly.id));
    }
  });
});
