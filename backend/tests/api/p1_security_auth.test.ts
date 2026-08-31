import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  auditLogs,
  organizationMemberships,
  organizations,
  oauthClients,
  oauthTokens,
  remoteStateConsumers,
  runTaskResults,
  runTasks,
  runTriggers,
  runs,
  sshKeys,
  teams,
  users,
  workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { signedApiURL } from "../../src/lib/utils";

const suffix = crypto.randomUUID();
const orgId = `p1-org-${suffix}`;
const orgName = `p1-org-${suffix}`;
const otherOrgId = `p1-other-org-${suffix}`;
const otherOrgName = `p1-other-org-${suffix}`;
const adminId = `p1-admin-${suffix}`;
const memberId = `p1-member-${suffix}`;
const ownerId = `p1-owner-${suffix}`;
const targetUserId = `p1-target-${suffix}`;
const adminToken = `p1-admin-token-${suffix}`;
const memberToken = `p1-member-token-${suffix}`;
const ownerToken = `p1-owner-token-${suffix}`;
const scopedToken = `p1-scoped-token-${suffix}`;
const organizationAuditToken = `p1-organization-audit-token-${suffix}`;
const targetWorkspaceId = `p1-target-workspace-${suffix}`;
const sourceWorkspaceId = `p1-source-workspace-${suffix}`;
const otherWorkspaceId = `p1-other-workspace-${suffix}`;
const teamId = `p1-team-${suffix}`;
const sameOrgSshKeyId = `p1-same-org-ssh-${suffix}`;
const otherOrgSshKeyId = `p1-other-org-ssh-${suffix}`;
const auditMemberId = `p1-audit-member-${suffix}`;
const auditOwnerId = `p1-audit-owner-${suffix}`;

const resource = (type: string, attributes: Record<string, unknown>): Record<string, unknown> => ({
  data: { type, attributes },
});

function request(
  path: string,
  token: string | null = adminToken,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/vnd.api+json";
  return app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  }));
}

const scopedPermissions = {
  "audit-logs:read": true,
  "run-tasks:write": true,
  "vcs:write": true,
  "teams:write": true,
};

beforeAll(async () => {
  await db.insert(users).values([
    { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
    { id: memberId, username: memberId, passwordHash: "unused", isSiteAdmin: false },
    { id: ownerId, username: ownerId, passwordHash: "unused", isSiteAdmin: false },
    { id: targetUserId, username: targetUserId, passwordHash: "unused", isSiteAdmin: false },
  ]);
  await db.insert(organizations).values([
    { id: orgId, name: orgName },
    { id: otherOrgId, name: otherOrgName },
  ]);
  await db.insert(organizationMemberships).values([
    { id: `p1-admin-membership-${suffix}`, userId: adminId, orgId, role: "owner" },
    { id: `p1-member-membership-${suffix}`, userId: memberId, orgId, role: "member" },
    { id: `p1-owner-membership-${suffix}`, userId: ownerId, orgId, role: "owner" },
  ]);
  await db.insert(teams).values({ id: teamId, orgId, name: `p1-team-${suffix}` });
  await db.insert(workspaces).values([
    { id: targetWorkspaceId, orgId, name: `target-${suffix}` },
    { id: sourceWorkspaceId, orgId, name: `source-${suffix}` },
    { id: otherWorkspaceId, orgId: otherOrgId, name: `other-${suffix}` },
  ]);
  await db.insert(sshKeys).values([
    { id: sameOrgSshKeyId, orgId, name: `same-${suffix}`, value: "private-key" },
    { id: otherOrgSshKeyId, orgId: otherOrgId, name: `other-${suffix}`, value: "private-key" },
  ]);
  await db.insert(apiTokens).values([
    { id: `p1-admin-token-row-${suffix}`, token: hashAuthenticationToken(adminToken), userId: adminId },
    { id: `p1-member-token-row-${suffix}`, token: hashAuthenticationToken(memberToken), userId: memberId },
    { id: `p1-owner-token-row-${suffix}`, token: hashAuthenticationToken(ownerToken), userId: ownerId },
    {
      id: `p1-scoped-token-row-${suffix}`,
      token: hashAuthenticationToken(scopedToken),
      userId: adminId,
      scopes: JSON.stringify({ version: 1, orgs: [orgId], permissions: scopedPermissions }),
    },
    {
      id: `p1-organization-audit-token-row-${suffix}`,
      token: hashAuthenticationToken(organizationAuditToken),
      orgId,
      tokenType: "audit-trails",
    },
  ]);
  await db.insert(auditLogs).values([
    {
      id: auditMemberId,
      orgId,
      userId: memberId,
      action: "p1-member-entry",
      resourceType: "users",
      resourceId: memberId,
      details: null,
      createdAt: Date.now() - 2,
    },
    {
      id: auditOwnerId,
      orgId,
      userId: ownerId,
      action: "p1-owner-entry",
      resourceType: "users",
      resourceId: ownerId,
      details: null,
      createdAt: Date.now() - 1,
    },
  ]);
});

afterAll(async () => {
  await db.delete(remoteStateConsumers).where(eq(remoteStateConsumers.workspaceId, targetWorkspaceId));
  await db.delete(runTriggers).where(eq(runTriggers.workspaceId, targetWorkspaceId));
  await db.delete(runTaskResults).where(eq(runTaskResults.runTaskId, `p1-task-${suffix}`));
  await db.delete(runs).where(eq(runs.workspaceId, targetWorkspaceId));
  await db.delete(runTasks).where(eq(runTasks.id, `p1-task-${suffix}`));
  await db.delete(oauthClients).where(eq(oauthClients.orgId, orgId));
  await db.delete(auditLogs).where(eq(auditLogs.id, auditMemberId));
  await db.delete(auditLogs).where(eq(auditLogs.id, auditOwnerId));
  await db.delete(auditLogs).where(and(eq(auditLogs.action, "impersonate"), eq(auditLogs.resourceId, targetUserId)));
  await db.delete(auditLogs).where(and(eq(auditLogs.action, "unimpersonate"), eq(auditLogs.resourceId, targetUserId)));
  await db.delete(apiTokens).where(eq(apiTokens.userId, adminId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, memberId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, ownerId));
  await db.delete(apiTokens).where(eq(apiTokens.orgId, orgId));
  await db.delete(teams).where(eq(teams.id, teamId));
  await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
  await db.delete(workspaces).where(eq(workspaces.orgId, otherOrgId));
  await db.delete(sshKeys).where(eq(sshKeys.orgId, orgId));
  await db.delete(sshKeys).where(eq(sshKeys.orgId, otherOrgId));
  await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrgId));
  await db.delete(users).where(and(eq(users.id, adminId), eq(users.username, adminId)));
  await db.delete(users).where(eq(users.id, memberId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, targetUserId));
});

describe("P1 security and authorization regressions", () => {
  it("authenticates metadata and blocks scoped tokens from site-admin routes", async () => {
    expect((await request("/api/v2/meta", null)).status).toBe(401);
    expect((await request("/api/v2/meta")).status).toBe(200);
    expect((await request("/api/v2/admin/system-info", scopedToken)).status).toBe(403);
  });

  it("rejects malformed VCS URLs before persisting an OAuth client", async () => {
    const invalidProtocol = await request(`/api/v2/organizations/${orgName}/oauth-clients`, adminToken, "POST", resource("oauth-clients", {
      name: `invalid-protocol-${suffix}`,
      "service-provider": "github_enterprise",
      "api-url": "file:///etc/passwd",
    }));
    expect(invalidProtocol.status).toBe(422);

    const invalidType = await request(`/api/v2/organizations/${orgName}/oauth-clients`, adminToken, "POST", resource("oauth-clients", {
      name: `invalid-type-${suffix}`,
      "api-url": 42,
    }));
    expect(invalidType.status).toBe(422);

    const emptyUrls = await request(`/api/v2/organizations/${orgName}/oauth-clients`, adminToken, "POST", resource("oauth-clients", {
      name: `empty-urls-${suffix}`,
      "service-provider": "github_enterprise",
      "api-url": "",
      "http-url": "",
    }));
    expect(emptyUrls.status).toBe(201);
    const emptyUrlClient = await db.query.oauthClients.findFirst({ where: eq(oauthClients.name, `empty-urls-${suffix}`) });
    expect(emptyUrlClient?.apiUrl).toBeNull();
    expect(emptyUrlClient?.httpUrl).toBeNull();

    const clients = await db.query.oauthClients.findMany({ where: eq(oauthClients.orgId, orgId) });
    expect(clients.some((client): boolean => client.name === `invalid-protocol-${suffix}` || client.name === `invalid-type-${suffix}`)).toBeFalse();
  });

  it("requires HTTPS for OAuth endpoints outside test and opted-in development environments", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousInsecureFlag = process.env.TERRENCE_ALLOW_INSECURE_OAUTH_URLS;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.TERRENCE_ALLOW_INSECURE_OAUTH_URLS;
      const rejected = await request(`/api/v2/organizations/${orgName}/oauth-clients`, adminToken, "POST", resource("oauth-clients", {
        name: `http-rejected-${suffix}`,
        "service-provider": "github_enterprise",
        "http-url": "http://oauth.example.test",
      }));
      expect(rejected.status).toBe(422);

      process.env.NODE_ENV = "development";
      process.env.TERRENCE_ALLOW_INSECURE_OAUTH_URLS = "true";
      const optedIn = await request(`/api/v2/organizations/${orgName}/oauth-clients`, adminToken, "POST", resource("oauth-clients", {
        name: `http-development-${suffix}`,
        "service-provider": "github_enterprise",
        "http-url": "http://oauth.example.test",
      }));
      expect(optedIn.status).toBe(201);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousInsecureFlag === undefined) delete process.env.TERRENCE_ALLOW_INSECURE_OAUTH_URLS;
      else process.env.TERRENCE_ALLOW_INSECURE_OAUTH_URLS = previousInsecureFlag;
    }
  });

  it("rejects malformed run-task URLs on create, update, and callback", async () => {
    const invalidCreate = await request(`/api/v2/organizations/${orgName}/run-tasks`, adminToken, "POST", resource("tasks", {
      name: `invalid-task-${suffix}`,
      url: "file:///etc/passwd",
    }));
    expect(invalidCreate.status).toBe(422);

    const taskId = `p1-task-${suffix}`;
    await db.insert(runTasks).values({
      id: taskId,
      orgId,
      name: `valid-task-${suffix}`,
      url: "https://task.example.test/callback",
      enabled: true,
    });
    const invalidUpdate = await request(`/api/v2/run-tasks/${taskId}`, adminToken, "PATCH", resource("tasks", {
      url: "not a URL",
    }));
    expect(invalidUpdate.status).toBe(422);
    const unchanged = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    expect(unchanged?.url).toBe("https://task.example.test/callback");

    const runId = `p1-run-${suffix}`;
    const resultId = `p1-result-${suffix}`;
    await db.insert(runs).values({ id: runId, workspaceId: targetWorkspaceId, status: "planning", createdAt: Date.now() });
    await db.insert(runTaskResults).values({ id: resultId, runId, runTaskId: taskId, status: "running", url: null });
    const callbackPath = `/api/v2/task-results/${resultId}/callback`;
    const signedCallback = signedApiURL(new Request(`http://terrence.test${callbackPath}`), callbackPath, "PATCH");
    const callback = await app.handle(new Request(signedCallback, {
      method: "PATCH",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { type: "task-results", attributes: { status: "passed", url: "file:///etc/passwd" } } }),
    }));
    expect(callback.status).toBe(422);
    const result = await db.query.runTaskResults.findFirst({ where: eq(runTaskResults.id, resultId) });
    expect(result?.url).toBeNull();
  });

  it("validates remote-state consumers and SSH keys against the workspace organization", async () => {
    const invalidConsumer = await request(`/api/v2/workspaces/${targetWorkspaceId}/relationships/remote-state-consumers`, adminToken, "POST", {
      data: [{ id: otherWorkspaceId, type: "workspaces" }],
    });
    expect(invalidConsumer.status).toBe(422);

    const validConsumer = await request(`/api/v2/workspaces/${targetWorkspaceId}/relationships/remote-state-consumers`, adminToken, "POST", {
      data: [{ id: sourceWorkspaceId, type: "workspaces" }],
    });
    expect(validConsumer.status).toBe(204);
    expect((await db.query.remoteStateConsumers.findMany({ where: eq(remoteStateConsumers.workspaceId, targetWorkspaceId) })).map((row): string => row.consumerWorkspaceId)).toEqual([sourceWorkspaceId]);

    const omittedReplacement = await request(`/api/v2/workspaces/${targetWorkspaceId}/relationships/remote-state-consumers`, adminToken, "PATCH", {});
    expect(omittedReplacement.status).toBe(422);
    expect((await db.query.remoteStateConsumers.findMany({ where: eq(remoteStateConsumers.workspaceId, targetWorkspaceId) })).map((row): string => row.consumerWorkspaceId)).toEqual([sourceWorkspaceId]);

    const invalidReplacement = await request(`/api/v2/workspaces/${targetWorkspaceId}/relationships/remote-state-consumers`, adminToken, "PATCH", {
      data: [{ id: otherWorkspaceId, type: "workspaces" }],
    });
    expect(invalidReplacement.status).toBe(422);
    expect((await db.query.remoteStateConsumers.findMany({ where: eq(remoteStateConsumers.workspaceId, targetWorkspaceId) })).map((row): string => row.consumerWorkspaceId)).toEqual([sourceWorkspaceId]);

    const invalidSsh = await request(`/api/v2/workspaces/${targetWorkspaceId}/relationships/ssh-key`, adminToken, "PATCH", {
      data: { id: otherOrgSshKeyId, type: "ssh-keys" },
    });
    expect(invalidSsh.status).toBe(422);
    const afterInvalidSsh = await db.query.workspaces.findFirst({ where: eq(workspaces.id, targetWorkspaceId) });
    expect(afterInvalidSsh?.sshKeyId).toBeNull();

    const validSsh = await request(`/api/v2/workspaces/${targetWorkspaceId}/relationships/ssh-key`, adminToken, "PATCH", {
      data: { id: sameOrgSshKeyId, type: "ssh-keys" },
    });
    expect(validSsh.status).toBe(200);
    const afterValidSsh = await db.query.workspaces.findFirst({ where: eq(workspaces.id, targetWorkspaceId) });
    expect(afterValidSsh?.sshKeyId).toBe(sameOrgSshKeyId);
  });

  it("rejects cross-organization, self, and wrong-type run-trigger relationships", async () => {
    const crossOrg = await request(`/api/v2/workspaces/${targetWorkspaceId}/relationships/run-triggers`, adminToken, "POST", {
      data: [{ id: otherWorkspaceId, type: "workspaces" }],
    });
    expect(crossOrg.status).toBe(422);

    const selfReference = await request(`/api/v2/workspaces/${targetWorkspaceId}/relationships/run-triggers`, adminToken, "POST", {
      data: [{ id: targetWorkspaceId, type: "workspaces" }],
    });
    expect(selfReference.status).toBe(422);

    const wrongType = await request(`/api/v2/workspaces/${targetWorkspaceId}/relationships/run-triggers`, adminToken, "POST", {
      data: [{ id: sourceWorkspaceId, type: "run-triggers" }],
    });
    expect(wrongType.status).toBe(422);

    const directWrongType = await request(`/api/v2/workspaces/${targetWorkspaceId}/run-triggers`, adminToken, "POST", {
      data: {
        relationships: {
          sourceable: { data: { id: sourceWorkspaceId, type: "run-triggers" } },
        },
      },
    });
    expect(directWrongType.status).toBe(422);

    const triggers = await db.query.runTriggers.findMany({ where: eq(runTriggers.workspaceId, targetWorkspaceId) });
    expect(triggers).toHaveLength(0);
  });

  it("prevents scoped callers from minting unscoped organization or team tokens", async () => {
    const orgToken = await request(`/api/v2/organizations/${orgName}/authentication-token`, scopedToken, "POST", resource("authentication-tokens", {}));
    expect(orgToken.status).toBe(403);
    const teamToken = await request(`/api/v2/teams/${teamId}/authentication-token`, scopedToken, "POST");
    expect(teamToken.status).toBe(403);
    const modernTeamToken = await request(`/api/v2/teams/${teamId}/authentication-tokens`, scopedToken, "POST", resource("authentication-tokens", { description: "scoped-escape" }));
    expect(modernTeamToken.status).toBe(403);
  });

  it("audit-logs impersonation start and end with a linking token identifier", async () => {
    const started = await request(`/api/v2/admin/users/${targetUserId}/actions/impersonate`, adminToken, "POST");
    expect(started.status).toBe(200);
    const startedBody = await started.json() as { data: { attributes: { token: string } } };
    const impersonationToken = startedBody.data.attributes.token;

    const startLog = await db.query.auditLogs.findFirst({
      where: and(eq(auditLogs.action, "impersonate"), eq(auditLogs.resourceId, targetUserId)),
    });
    expect(startLog?.userId).toBe(adminId);
    expect(startLog?.details).toMatchObject({ targetUserId, impersonatorUserId: adminId });
    const tokenId = (startLog?.details as Record<string, unknown> | null)?.impersonationTokenId;
    expect(typeof tokenId).toBe("string");

    const ended = await request("/api/v2/admin/users/actions/unimpersonate", impersonationToken, "POST");
    expect(ended.status).toBe(204);
    const endLog = await db.query.auditLogs.findFirst({
      where: and(eq(auditLogs.action, "unimpersonate"), eq(auditLogs.resourceId, targetUserId)),
    });
    expect(endLog?.userId).toBe(targetUserId);
    expect(endLog?.details).toMatchObject({ targetUserId, impersonationTokenId: tokenId });
  });

  it("clears retained OAuth credentials when an endpoint origin changes", async () => {
    const clientId = `p1-oauth-client-${suffix}`;
    const tokenId = `p1-oauth-token-${suffix}`;
    await db.insert(oauthClients).values({
      id: clientId,
      orgId,
      name: `credential-origin-${suffix}`,
      serviceProvider: "github_enterprise",
      apiUrl: "https://old-api.example.test/api/v3",
      httpUrl: "https://old-login.example.test",
      key: "old-client-key",
      secret: "old-client-secret",
    });
    await db.insert(oauthTokens).values({ id: tokenId, oauthClientId: clientId, token: "old-access-token" });

    const unchanged = await request(`/api/v2/oauth-clients/${clientId}`, adminToken, "PATCH", resource("oauth-clients", {
      name: `credential-origin-unchanged-${suffix}`,
    }));
    expect(unchanged.status).toBe(200);
    expect((await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId) }))?.secret).toBe("old-client-secret");
    expect(await db.query.oauthTokens.findMany({ where: eq(oauthTokens.oauthClientId, clientId) })).toHaveLength(1);

    const changed = await request(`/api/v2/oauth-clients/${clientId}`, adminToken, "PATCH", resource("oauth-clients", {
      "api-url": "https://new-api.example.test/api/v3",
    }));
    expect(changed.status).toBe(200);
    const updated = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId) });
    expect(updated?.apiUrl).toBe("https://new-api.example.test/api/v3");
    expect(updated?.secret).toBeNull();
    expect(await db.query.oauthTokens.findMany({ where: eq(oauthTokens.oauthClientId, clientId) })).toHaveLength(0);
  });

  it("limits audit reads to owners, auditors, and declared scoped grants", async () => {
    const memberResponse = await request("/api/v2/audit-trails", memberToken);
    expect(memberResponse.status).toBe(200);
    expect((await memberResponse.json() as { data: unknown[] }).data).toHaveLength(0);

    const ownerResponse = await request("/api/v2/audit-trails", ownerToken);
    expect(ownerResponse.status).toBe(200);
    expect((await ownerResponse.json() as { data: { id: string }[] }).data.some(({ id }): boolean => id === auditMemberId)).toBeTrue();

    const orgTokenResponse = await request("/api/v2/audit-trails", organizationAuditToken);
    expect(orgTokenResponse.status).toBe(200);
    expect((await orgTokenResponse.json() as { data: { id: string }[] }).data.some(({ id }): boolean => id === auditOwnerId)).toBeTrue();

    const scopedResponse = await request("/api/v2/audit-trails", scopedToken);
    expect(scopedResponse.status).toBe(200);
  });
});

describe("P1 documentation and generated-artifact consistency", () => {
  it("documents only implemented security controls and builds Landlock from source", () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const envExample = readFileSync(join(repoRoot, ".env.example"), "utf8");
    const configuration = readFileSync(join(repoRoot, "backend/docs/configuration.md"), "utf8");
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const sessionKey = ["SESSION", "KEY"].join("_");
    const legacyTokenFlag = ["TERRENCE_ALLOW", "LEGACY_TOKENS"].join("_");
    expect(envExample).not.toContain(sessionKey);
    expect(configuration).not.toContain(sessionKey);
    expect(envExample).not.toContain(legacyTokenFlag);
    expect(workflow).not.toContain(legacyTokenFlag);
    expect(envExample).toContain("ENCRYPTION_PASSWORD");
    expect(readFileSync(join(repoRoot, "Dockerfile"), "utf8")).toContain("backend/bin/build-landlock-runner.sh");
  });
});
