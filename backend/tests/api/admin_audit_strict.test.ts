import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  auditLogs,
  organizations,
  sshKeys,
  users,
  workspaceVariables,
  workspaces,
} from "../../src/db/schema";

// Covers kanban 12.10 (admin system-info endpoint) and 12.16 (AUDIT_STRICT
// mode: token minting, SSH key material, and sensitive variable reads are
// recorded in the audit log only when the env flag is enabled).
const suffix = crypto.randomUUID();
const adminId = `strict-admin-${suffix}`;
const adminToken = `strict-admin-token-${suffix}`;
const userId = `strict-user-${suffix}`;
const userToken = `strict-user-token-${suffix}`;
const orgName = `strict-org-${suffix}`;
const workspaceName = `strict-ws-${suffix}`;

let orgId = "";
let workspaceId = "";
let sshKeyId = "";
let sensitiveVarId = "";
let plainVarId = "";

function request(path: string, method = "GET", token = adminToken, body?: unknown): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function withStrict<T>(fn: () => Promise<T>): Promise<T> {
  process.env.AUDIT_STRICT = "1";
  try {
    return await fn();
  } finally {
    delete process.env.AUDIT_STRICT;
  }
}

beforeAll(async () => {
  await db.insert(users).values([
    { id: adminId, username: `strict-admin-${suffix}`, email: `strict-admin-${suffix}@example.com`, passwordHash: "unused", isSiteAdmin: true },
    { id: userId, username: `strict-user-${suffix}`, email: `strict-user-${suffix}@example.com`, passwordHash: "unused", isSiteAdmin: false },
  ]);
  await db.insert(apiTokens).values([
    { id: `strict-atok-admin-${suffix}`, token: createHash("sha256").update(adminToken).digest("hex"), userId: adminId },
    { id: `strict-atok-user-${suffix}`, token: createHash("sha256").update(userToken).digest("hex"), userId },
  ]);

  const orgResponse = await request("/api/v2/organizations", "POST", adminToken, {
    data: { type: "organizations", attributes: { name: orgName } },
  });
  expect(orgResponse.status).toBe(201);
  orgId = (await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) }))?.id ?? "";

  const workspaceResponse = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", adminToken, {
    data: { type: "workspaces", attributes: { name: workspaceName } },
  });
  expect(workspaceResponse.status).toBe(201);
  workspaceId = ((await workspaceResponse.json()) as { data: { id: string } }).data.id;

  const sshResponse = await request(`/api/v2/organizations/${orgName}/ssh-keys`, "POST", adminToken, {
    data: { type: "ssh-keys", attributes: { name: "strict-deploy-key", value: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" } },
  });
  expect(sshResponse.status).toBe(201);
  sshKeyId = ((await sshResponse.json()) as { data: { id: string } }).data.id;

  const sensitiveVarResponse = await request(`/api/v2/workspaces/${workspaceId}/vars`, "POST", adminToken, {
    data: { type: "vars", attributes: { key: "SENSITIVE_SECRET", value: "hunter2", category: "terraform", sensitive: true } },
  });
  expect(sensitiveVarResponse.status).toBe(201);
  sensitiveVarId = ((await sensitiveVarResponse.json()) as { data: { id: string } }).data.id;

  const plainVarResponse = await request(`/api/v2/workspaces/${workspaceId}/vars`, "POST", adminToken, {
    data: { type: "vars", attributes: { key: "PLAIN_VAR", value: "visible", category: "terraform", sensitive: false } },
  });
  expect(plainVarResponse.status).toBe(201);
  plainVarId = ((await plainVarResponse.json()) as { data: { id: string } }).data.id;
});

afterAll(async () => {
  delete process.env.AUDIT_STRICT;
  if (sensitiveVarId !== "") await db.delete(workspaceVariables).where(eq(workspaceVariables.id, sensitiveVarId));
  if (plainVarId !== "") await db.delete(workspaceVariables).where(eq(workspaceVariables.id, plainVarId));
  if (sshKeyId !== "") await db.delete(sshKeys).where(eq(sshKeys.id, sshKeyId));
  if (workspaceId !== "") await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  if (orgId !== "") await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, adminId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
  await db.delete(users).where(eq(users.id, adminId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("admin system-info (kanban 12.10)", () => {
  it("returns full system state for a site admin", async () => {
    const response = await request("/api/v2/admin/system-info", "GET", adminToken);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    const data = body.data;
    expect(typeof data.version).toBe("string");
    expect(typeof data["uptime-seconds"]).toBe("number");
    expect((data["uptime-seconds"] as number)).toBeGreaterThan(0);
    expect(typeof data["started-at"]).toBe("string");
    expect((data.storage as { dir: string }).dir).toBeTruthy();
    expect(typeof (data.database as Record<string, unknown>).sizeBytes).toBe("number");
    expect(typeof (data.database as Record<string, unknown>).journalMode).toBe("string");
    expect(typeof (data.worker as { enabled: boolean }).enabled).toBe("boolean");
    expect((data.worker as { enabled: boolean }).enabled).toBe(process.env.TERRENCE_DISABLE_WORKER !== "1");
    expect((data.worker as { "drain-mode": boolean })["drain-mode"]).toBe(process.env.TERRENCE_DISABLE_WORKER === "1");
    expect(typeof (data.sandbox as { abi: number }).abi).toBe("number");
    expect(typeof (data.integrations as { "saml-enabled": boolean })["saml-enabled"]).toBe("boolean");
    expect(typeof (data.agents as { total: number }).total).toBe("number");
  });

  it("rejects non-admins with 403", async () => {
    const response = await request("/api/v2/admin/system-info", "GET", userToken);
    expect(response.status).toBe(403);
  });
});

describe("strict audit mode (kanban 12.16)", () => {
  it("records user token minting only when AUDIT_STRICT is enabled", async () => {
    // Gated off: no audit row for the same operation.
    const offResponse = await request(`/api/v2/users/${userId}/authentication-tokens`, "POST", userToken, {
      data: { type: "authentication-tokens", attributes: { description: "strict-off-token" } },
    });
    expect(offResponse.status).toBe(201);
    const offRow = await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.action, "create"),
        eq(auditLogs.resourceType, "authentication-token"),
        eq(auditLogs.resourceId, ((await offResponse.json()) as { data: { id: string } }).data.id),
      ),
    });
    expect(offRow).toBeUndefined();

    // Gated on: row appears.
    const onResponse = await withStrict(async () =>
      request(`/api/v2/users/${userId}/authentication-tokens`, "POST", userToken, {
        data: { type: "authentication-tokens", attributes: { description: "strict-on-token" } },
      }),
    );
    expect(onResponse.status).toBe(201);
    const onRow = await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.action, "create"),
        eq(auditLogs.resourceType, "authentication-token"),
        eq(auditLogs.resourceId, ((await onResponse.json()) as { data: { id: string } }).data.id),
      ),
    });
    expect(onRow).toBeDefined();
    expect((onRow?.details as Record<string, unknown> | null)?.description).toBe("strict-on-token");
  });

  it("records SSH key access and mutation when AUDIT_STRICT is enabled", async () => {
    await withStrict(async () => {
      const readResponse = await request(`/api/v2/ssh-keys/${sshKeyId}`, "GET", adminToken);
      expect(readResponse.status).toBe(200);
      const patchResponse = await request(`/api/v2/ssh-keys/${sshKeyId}`, "PATCH", adminToken, {
        data: { type: "ssh-keys", attributes: { name: "strict-deploy-key-renamed" } },
      });
      expect(patchResponse.status).toBe(200);
    });
    const readRow = await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.action, "read"),
        eq(auditLogs.resourceType, "ssh-key"),
        eq(auditLogs.resourceId, sshKeyId),
      ),
    });
    expect(readRow).toBeDefined();
    expect(readRow?.orgId).toBe(orgId);
    const updateRow = await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.action, "update"),
        eq(auditLogs.resourceType, "ssh-key"),
        eq(auditLogs.resourceId, sshKeyId),
      ),
    });
    expect(updateRow).toBeDefined();
  });

  it("records reads of sensitive variables but not plain ones", async () => {
    await withStrict(async () => {
      const sensitiveRead = await request(`/api/v2/workspaces/${workspaceId}/vars/${sensitiveVarId}`, "GET", adminToken);
      expect(sensitiveRead.status).toBe(200);
      const plainRead = await request(`/api/v2/workspaces/${workspaceId}/vars/${plainVarId}`, "GET", adminToken);
      expect(plainRead.status).toBe(200);
    });
    const sensitiveRow = await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.action, "read"),
        eq(auditLogs.resourceType, "workspace-variable"),
        eq(auditLogs.resourceId, sensitiveVarId),
      ),
    });
    expect(sensitiveRow).toBeDefined();
    expect((sensitiveRow?.details as Record<string, unknown> | null)?.sensitive).toBe(true);
    const plainRow = await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.action, "read"),
        eq(auditLogs.resourceType, "workspace-variable"),
        eq(auditLogs.resourceId, plainVarId),
      ),
    });
    expect(plainRow).toBeUndefined();
  });
});
