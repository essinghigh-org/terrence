import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  samlSettings,
  users,
} from "../../src/db/schema";

describe("SAML settings", () => {
  const suffix = crypto.randomUUID();
  const adminId = `usr-saml-admin-${suffix}`;
  const ownerId = `usr-saml-owner-${suffix}`;
  const orgId = `org-saml-${suffix}`;
  const orgName = `saml-${suffix}`;
  const adminToken = `saml-admin-token-${suffix}`;
  const ownerToken = `saml-owner-token-${suffix}`;
  const firstCertificate = "-----BEGIN CERTIFICATE-----\nFIRST\n-----END CERTIFICATE-----";
  const secondCertificate = "-----BEGIN CERTIFICATE-----\nSECOND\n-----END CERTIFICATE-----";

  const request = (method: string, path: string, token: string, body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: ownerId, username: ownerId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `orgmem-saml-${suffix}`,
      userId: ownerId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values([
      {
        id: `api-saml-admin-${suffix}`,
        token: createHash("sha256").update(adminToken).digest("hex"),
        userId: adminId,
      },
      {
        id: `api-saml-owner-${suffix}`,
        token: createHash("sha256").update(ownerToken).digest("hex"),
        userId: ownerId,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(samlSettings).where(eq(samlSettings.id, "saml"));
    await db.delete(apiTokens).where(inArray(apiTokens.userId, [adminId, ownerId]));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(inArray(users.id, [adminId, ownerId]));
  });

  test("persists validated settings and propagates the organization SAML flag", async () => {
    expect((await request("GET", "/api/v2/admin/saml-settings", ownerToken)).status).toBe(404);

    const initialResponse = await request("GET", "/api/v2/admin/saml-settings", adminToken);
    expect(initialResponse.status).toBe(200);
    expect((await initialResponse.json()).data.attributes).toMatchObject({
      enabled: false,
      debug: false,
      "attr-username": "Username",
      "attr-groups": "MemberOf",
      "sso-api-token-session-timeout": 1_209_600,
      "acs-consumer-url": "http://terrence.test/users/saml/auth",
      "metadata-url": "http://terrence.test/users/saml/metadata",
    });

    const missingIdentityProvider = await request("PATCH", "/api/v2/admin/saml-settings", adminToken, {
      data: { type: "saml-settings", attributes: { enabled: true } },
    });
    expect(missingIdentityProvider.status).toBe(422);

    const enabledResponse = await request("PATCH", "/api/v2/admin/saml-settings", adminToken, {
      data: {
        type: "saml-settings",
        attributes: {
          enabled: true,
          debug: true,
          "idp-cert": firstCertificate,
          "sso-endpoint-url": "https://idp.example.test/sso",
          "slo-endpoint-url": "https://idp.example.test/slo",
          "attr-username": "mail",
          "attr-groups": "groups",
          "sso-api-token-session-timeout": 3600,
        },
      },
    });
    expect(enabledResponse.status).toBe(200);
    expect((await enabledResponse.json()).data.attributes).toMatchObject({
      enabled: true,
      debug: true,
      "old-idp-cert": null,
      "idp-cert": firstCertificate,
      "attr-username": "mail",
      "attr-groups": "groups",
      "sso-api-token-session-timeout": 3600,
    });

    const organization = await request("GET", `/api/v2/organizations/${orgName}`, ownerToken);
    expect(organization.status).toBe(200);
    expect((await organization.json()).data.attributes["saml-enabled"]).toBeTrue();
  });

  test("rotates and revokes the previous certificate", async () => {
    const rotated = await request("PATCH", "/api/v2/admin/saml-settings", adminToken, {
      data: {
        type: "saml-settings",
        attributes: { "idp-cert": secondCertificate },
      },
    });
    expect(rotated.status).toBe(200);
    expect((await rotated.json()).data.attributes).toMatchObject({
      "old-idp-cert": firstCertificate,
      "idp-cert": secondCertificate,
    });

    const revoked = await request(
      "POST",
      "/api/v2/admin/saml-settings/actions/revoke-old-certificate",
      adminToken,
    );
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).data.attributes["old-idp-cert"]).toBeNull();
  });

  test("stores the owners-team role alias and validates its type", async () => {
    const updated = await request("PATCH", `/api/v2/organizations/${orgName}`, ownerToken, {
      data: {
        type: "organizations",
        attributes: { "owners-team-saml-role-id": "tfe-owners" },
      },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.attributes["owners-team-saml-role-id"]).toBe("tfe-owners");

    expect((await request("PATCH", `/api/v2/organizations/${orgName}`, ownerToken, {
      data: {
        type: "organizations",
        attributes: { "owners-team-saml-role-id": 42 },
      },
    })).status).toBe(422);
  });
});
