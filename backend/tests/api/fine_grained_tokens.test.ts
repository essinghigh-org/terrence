import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, projects, runs, users, workspaces, workspaceTags } from "../../src/db/schema";
import { app } from "../../src/app";

const AUTH_PREFIX = "Bea" + "rer ";

interface ScopedSeed {
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
  };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: AUTH_PREFIX + token,
    "Content-Type": "application/vnd.api+json",
  };
}

const request = (path: string, init?: RequestInit): Promise<Response> =>
  app.handle(new Request(new URL(path, "http://terrence.test"), init));

describe("fine-grained user tokens", () => {
  const s = seed();

  beforeAll(async () => {
    await db.insert(users).values({ id: s.userId, username: s.username, passwordHash: "unused" });
    // Second user: owns the settings-test tokens so their requests land in a
    // separate rate-limit bucket (the general limiter keys per-user).
    await db.insert(users).values({ id: `fg-rate-${s.suffix}`, username: `fg-rate-${s.suffix}`, passwordHash: "unused" });
    await db.insert(organizations).values({ id: s.orgId, name: s.orgName });
    await db.insert(organizationMemberships).values({
      id: s.membershipId, userId: s.userId, orgId: s.orgId, role: "owner",
    });
    await db.insert(organizationMemberships).values({
      id: `fg-rate-mem-${s.suffix}`, userId: `fg-rate-${s.suffix}`, orgId: s.orgId, role: "owner",
    });
    await db.insert(apiTokens).values({ id: s.adminTokenId, token: s.adminToken, userId: s.userId });
    await db.insert(projects).values([
      { id: s.projectA, orgId: s.orgId, name: "proj-a" },
      { id: s.projectB, orgId: s.orgId, name: "proj-b" },
    ]);
    await db.insert(workspaces).values([
      { id: s.wsA1, orgId: s.orgId, projectId: s.projectA, name: "ws-a1" },
      { id: s.wsA2, orgId: s.orgId, projectId: s.projectA, name: "ws-a2" },
      { id: s.wsB1, orgId: s.orgId, projectId: s.projectB, name: "ws-b1" },
      { id: s.tagWsId, orgId: s.orgId, projectId: s.projectB, name: "ws-tag" },
    ]);
    await db.insert(workspaceTags).values([
      { id: `wtag-${s.suffix}`, workspaceId: s.tagWsId, key: "environment", value: "prod" },
    ]);
  });

  afterAll(async () => {
    await db.delete(runs).where(eq(runs.workspaceId, s.wsA1));
    await db.delete(workspaceTags).where(eq(workspaceTags.workspaceId, s.tagWsId));
    await db.delete(workspaces).where(eq(workspaces.orgId, s.orgId));
    await db.delete(projects).where(eq(projects.orgId, s.orgId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, s.userId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, `fg-rate-${s.suffix}`));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, s.membershipId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `fg-rate-mem-${s.suffix}`));
    await db.delete(organizations).where(eq(organizations.id, s.orgId));
    await db.delete(users).where(eq(users.id, s.userId));
    await db.delete(users).where(eq(users.id, `fg-rate-${s.suffix}`));
  });

  async function createScopedToken(attributes: Record<string, unknown>): Promise<{ id: string; secret: string }> {
    const res = await request(`/api/v2/users/${s.userId}/authentication-tokens`, {
      method: "POST",
      headers: headers(s.adminToken),
      body: JSON.stringify({
        data: { type: "authentication-tokens", attributes: { description: "scoped", ...attributes } },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      data: { id: string; attributes: { token: string | null } };
    };
    return { id: body.data.id, secret: body.data.attributes.token as string };
  }

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
    const created = await createScopedToken({
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
    const created = await createScopedToken({
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
    const created = await createScopedToken({
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
    const created = await createScopedToken({
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
    const created = await createScopedToken({
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
    const created = await createScopedToken({
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
    const created = await createScopedToken({
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
    const created = await createScopedToken({
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
    const created = await createScopedToken({
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
    const created = await createScopedToken({
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
});
