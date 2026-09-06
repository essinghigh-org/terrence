import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  auditLogs,
  oidcConfigs,
  organizationMemberships,
  organizations,
  users,
  workloadIdentityTokens,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";

describe("credential doctor API", () => {
  const suffix = crypto.randomUUID();
  const userId = `doctor-user-${suffix}`;
  const orgId = `doctor-org-${suffix}`;
  const orgName = `doctor-${suffix}`;
  const authToken = `doctor-token-${suffix}`;
  const configId = `oidc-doctor-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown): Promise<Response> => app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: `membership-${suffix}`, userId, orgId, role: "owner", status: "active" });
    await db.insert(apiTokens).values({ id: `token-row-${suffix}`, token: hashAuthenticationToken(authToken), userId });
    await db.insert(oidcConfigs).values({
      id: configId,
      orgId,
      configType: "azure-oidc-configurations",
      config: { identity: "client-id", "tenant-id": "tenant", "subscription-id": "subscription" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
      if (init.method === "HEAD") return new Response(null, { status: 200 });
      if (target.url.includes("login.microsoftonline.com")) return Response.json({ access_token: "provider-access-token" });
      return Response.json({ subscriptionId: "subscription", tenantId: "tenant", displayName: "Doctor subscription", state: "Enabled" });
    });
  });

  afterAll(async () => {
    setExternalUrlTransportForTests(undefined);
    await db.delete(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "credential_doctor.run")));
    await db.delete(oidcConfigs).where(eq(oidcConfigs.id, configId));
    await db.delete(apiTokens).where(eq(apiTokens.id, `token-row-${suffix}`));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `membership-${suffix}`));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("runs from the local worker and exposes only safe claims and result metadata", async () => {
    const response = await request(`/api/v2/organizations/${orgName}/oidc-configurations/${configId}/credential-doctor`, "POST", {
      data: { type: "credential-doctor-runs", attributes: { subject: `organization:${orgName}:credential-doctor` } },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { type: string; attributes: Record<string, unknown> } };
    expect(body.data.type).toBe("credential-doctor-runs");
    expect(body.data.attributes["execution-context"]).toMatchObject({ kind: "worker" });
    expect(body.data.attributes["claims"]).toMatchObject({ aud: "azure.workload.identity", sub: `organization:${orgName}:credential-doctor` });
    expect(body.data.attributes["checks"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "token_issuance", status: "passed" }),
      expect.objectContaining({ name: "network_reachability", status: "passed" }),
      expect.objectContaining({ name: "provider_access", status: "passed" }),
    ]));
    expect(JSON.stringify(body)).not.toContain("provider-access-token");
    const claims = body.data.attributes["claims"] as { jti?: string };
    expect(claims.jti).toBeString();
    expect(await db.query.workloadIdentityTokens.findFirst({ where: eq(workloadIdentityTokens.jti, claims.jti!) })).toBeUndefined();
  });

  test("requires organization provider-management access", async () => {
    const response = await app.handle(new Request(`http://terrence.test/api/v2/oidc-configurations/${configId}/credential-doctor`, { method: "POST" }));
    expect(response.status).toBe(404);
  });
});
