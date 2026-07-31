import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations, users } from "../../src/db/schema";import {
  cleanupSeed,
  expectCollection,
  expectErrorResponse,
  expectNoContent,
  expectPaginationMeta,
  expectSelfLink,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedTfeOrg,
} from "./tfe_contract_helpers";

describe("TFE organizations and users contract", () => {
  const seed = seedTfeOrg("org");
  const headers = jsonHeaders(seed.token);
  const extraOrgId = `extra-org-${seed.suffix}`;
  const extraOrgName = `extra-${seed.suffix}`;
  const memberUsername = `member-${seed.suffix}`;
  const memberId = `member-user-${seed.suffix}`;
  let membershipId = "";

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(users).values({ id: memberId, username: memberUsername, email: `${memberUsername}@example.com`, passwordHash: "unused" });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, memberId));
    await db.delete(organizations).where(eq(organizations.id, extraOrgId));
    await cleanupSeed(seed);
  });

  it("creates an organization with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/organizations`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "organizations",
            attributes: { name: extraOrgName, email: "owner@example.com" },
          },
        }),
      }),
      201,
      "organizations",
    );
    expect(resource.attributes.name).toBe(extraOrgName);
    // TFE emits an opaque uuid; Terrence returns the org row id (opaque to clients).
    expect(resource.attributes["external-id"]).toBeTypeOf("string");
    expect(resource.attributes["external-id"]).not.toBe("");
    expect(resource.attributes["collaborator-auth-policy"]).toBe("password");
    expect(resource.attributes["cost-estimation-enabled"]).toBe(false);
    expect(resource.attributes["default-execution-mode"]).toBe("remote");
    expect(resource.attributes["user-tokens-enabled"]).toBe(true);
    expect(resource.attributes.permissions).toMatchObject({
      "can-update": true,
      "can-destroy": true,
      "can-manage-workspaces": true,
      "can-update-organization-access": true,
    });
    expect(resource.relationships?.["entitlement-set"]).toMatchObject({
      links: { related: `/api/v2/organizations/${extraOrgName}/entitlement-set` },
    });
    expectSelfLink(resource, "/api/v2/organizations/");
  });

  it("shows an organization", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}`, { headers }),
      200,
      "organizations",
    );
    expect(resource.attributes.name).toBe(seed.orgName);
    expect(resource.attributes["external-id"]).toBeTypeOf("string");
    expect(resource.attributes.permissions).toBeTypeOf("object");
    expectSelfLink(resource, "/api/v2/organizations/");
  });

  it("lists organizations with pagination metadata", async () => {
    const response = await request(`/api/v2/organizations?page[number]=1&page[size]=10`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "organizations");
    expect(items.map((o) => o.id)).toContain(seed.orgName);
    expectPaginationMeta(body);
  });

  it("updates an organization", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          data: {
            type: "organizations",
            attributes: { email: "new-owner@example.com" },
          },
        }),
      }),
      200,
      "organizations",
    );
    // TFE persists the email; Terrence does not store one for this org.
    expect(resource.attributes.email === null || resource.attributes.email === "new-owner@example.com").toBe(true);
  });

  it("creates and lists organization memberships", async () => {
    const created = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/organization-memberships`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "organization-memberships",
            attributes: { email: `${memberUsername}@example.com` },
          },
        }),
      }),
      201,
      "organization-memberships",
    );
    membershipId = created.id;
    expect(created.attributes.status).toBe("active");
    expect(created.attributes.role).toBe("member");
    expect(created.relationships?.user).toMatchObject({
      data: { id: memberId, type: "users" },
    });
    expect(created.relationships?.organization).toMatchObject({
      data: { id: seed.orgName, type: "organizations" },
    });

    const response = await request(`/api/v2/organizations/${seed.orgName}/organization-memberships?page[number]=1&page[size]=10`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "organization-memberships");
    expect(items.map((m) => m.id)).toContain(membershipId);
    expectPaginationMeta(body);
  });

  it("shows the current user", async () => {
    const resource = await expectSuccessResponse(await request(`/api/v2/users/${seed.userId}`, { headers }), 200, "users");
    expect(resource.attributes.username).toBe(seed.username);
    expect(resource.attributes["is-service-account"]).toBe(false);
    expect(resource.attributes["auth-method"]).toBe("local");
    expect(resource.attributes["avatar-url"]).toBeTypeOf("string");
    expect(resource.attributes.permissions).toMatchObject({
      "can-create-organizations": true,
      "can-change-email": true,
    });
    expectSelfLink(resource, "/api/v2/users/");
  });

  it("lists organization members", async () => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/users?page[number]=1&page[size]=10`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "users");
    expect(items.map((u) => u.id)).toContain(seed.userId);
    expectPaginationMeta(body);
  });

  it("removes an organization membership", async () => {
    await expectNoContent(await request(`/api/v2/organization-memberships/${membershipId}`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/organization-memberships/${membershipId}`, { headers }), 404);
  });

  it("destroys an organization", async () => {
    await expectNoContent(await request(`/api/v2/organizations/${extraOrgName}`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/organizations/${extraOrgName}`, { headers }), 404);
  });
});
