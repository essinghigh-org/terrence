import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, like } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, users } from "../../src/db/schema";

describe("organization API contract", () => {
  const prefix = `org-contract-${crypto.randomUUID()}`;
  const userId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();
  const token = `user-${crypto.randomUUID()}`;
  const orgToken = `org-${crypto.randomUUID()}`;
  const createdName = `${prefix}-alpha`;
  const betaName = `${prefix}-beta`;
  const gammaName = `${prefix}-gamma`;
  const inactiveName = `${prefix}-inactive`;
  const pendingName = `${prefix}-pending`;
  const privateName = `${prefix}-private`;

  const request = (path: string, auth = token, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, username: `${prefix}-user`, passwordHash: "unused" },
      { id: otherUserId, username: `${prefix}-other`, passwordHash: "unused" },
    ]);
    await db.insert(apiTokens).values({
      id: crypto.randomUUID(),
      token,
      userId,
      description: "organization contract",
    });
  });

  afterAll(async () => {
    await db.delete(organizations).where(like(organizations.name, `${prefix}%`));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  it("creates, shows, and updates organization defaults and relationship links", async () => {
    const created = await request("/api/v2/organizations", token, "POST", {
      data: {
        type: "organizations",
        attributes: {
          name: createdName,
          "default-iac-binary": "terraform",
          "default-terraform-version": "1.15.0",
          "assessments-enforced": true,
        },
      },
    });
    expect(created.status).toBe(201);
    const resource = (await created.json()).data;
    expect(resource.attributes).toMatchObject({
      name: createdName,
      "external-id": resource.id,
      email: null,
      "collaborator-auth-policy": "password",
      "cost-estimation-enabled": false,
      "speculative-plan-management-enabled": true,
      "allow-force-delete-workspaces": true,
      "default-execution-mode": "remote",
      "default-iac-binary": "terraform",
      "default-terraform-version": "1.15.0",
      "assessments-enforced": true,
    });
    expect(resource.relationships).toMatchObject({
      "oauth-tokens": { links: { related: `/api/v2/organizations/${createdName}/oauth-tokens` } },
      "authentication-token": { links: { related: `/api/v2/organizations/${createdName}/authentication-token` } },
      "entitlement-set": { links: { related: `/api/v2/organizations/${createdName}/entitlement-set` } },
      subscription: { links: { related: `/api/v2/organizations/${createdName}/subscription` } },
      "default-agent-pool": { data: null },
    });

    const shown = await request(`/api/v2/organizations/${createdName}`);
    expect(shown.status).toBe(200);
    expect((await shown.json()).data).toMatchObject(resource);

    const updated = await request(`/api/v2/organizations/${createdName}`, token, "PATCH", {
      data: {
        type: "organizations",
        attributes: {
          "default-iac-binary": "tofu",
          "default-terraform-version": "1.12.1",
          "assessments-enforced": false,
        },
      },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.attributes).toMatchObject({
      "default-iac-binary": "tofu",
      "default-terraform-version": "1.12.1",
      "assessments-enforced": false,
    });
  });

  it("scopes, searches, and paginates organization lists for users and organization tokens", async () => {
    await db.delete(organizations).where(like(organizations.name, `${prefix}%`));
    const createdId = crypto.randomUUID();
    const betaId = crypto.randomUUID();
    const gammaId = crypto.randomUUID();
    const inactiveId = crypto.randomUUID();
    const pendingId = crypto.randomUUID();
    const privateId = crypto.randomUUID();
    await db.insert(organizations).values([
      { id: createdId, name: createdName },
      { id: betaId, name: betaName },
      { id: gammaId, name: gammaName },
      { id: inactiveId, name: inactiveName },
      { id: pendingId, name: pendingName },
      { id: privateId, name: privateName },
    ]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId: createdId, role: "owner" },
      { id: crypto.randomUUID(), userId, orgId: betaId, role: "member" },
      { id: crypto.randomUUID(), userId, orgId: gammaId, role: "member" },
      { id: crypto.randomUUID(), userId, orgId: inactiveId, role: "member", status: "inactive" },
      { id: crypto.randomUUID(), userId, orgId: pendingId, role: "member", status: "pending" },
      { id: crypto.randomUUID(), userId: otherUserId, orgId: privateId, role: "owner" },
    ]);
    await db.insert(apiTokens).values({
      id: crypto.randomUUID(),
      token: orgToken,
      orgId: betaId,
      description: "organization principal",
    });

    const page = await request(`/api/v2/organizations?q=${prefix}&page[number]=1&page[size]=2`);
    expect(page.status).toBe(200);
    const pageBody = await page.json();
    expect(pageBody.data.map((item: any) => item.attributes.name)).toEqual([createdName, betaName]);
    expect(pageBody.meta.pagination).toEqual({
      "current-page": 1,
      "page-size": 2,
      "prev-page": null,
      "next-page": 2,
      "total-pages": 2,
      "total-count": 3,
    });
    expect(pageBody.links).toMatchObject({
      self: expect.stringContaining("page%5Bnumber%5D=1"),
      first: expect.any(String),
      prev: null,
      next: expect.stringContaining("page%5Bnumber%5D=2"),
      last: expect.stringContaining("page%5Bnumber%5D=2"),
    });

    const allActive = await request(`/api/v2/organizations?q=${prefix}&page[size]=100`);
    expect((await allActive.json()).data.map((item: any) => item.attributes.name)).toEqual([
      createdName,
      betaName,
      gammaName,
    ]);

    const byName = await request(`/api/v2/organizations?q[name]=${betaName}`);
    expect((await byName.json()).data.map((item: any) => item.attributes.name)).toEqual([betaName]);

    const generic = await request(`/api/v2/organizations?q=${gammaName}`);
    expect((await generic.json()).data.map((item: any) => item.attributes.name)).toEqual([gammaName]);

    const orgScoped = await request(`/api/v2/organizations?q=${prefix}`, orgToken);
    const orgScopedBody = await orgScoped.json();
    expect(orgScopedBody.data.map((item: any) => item.id)).toEqual([betaId]);
    expect(orgScopedBody.meta.pagination["total-count"]).toBe(1);

    expect((await request(`/api/v2/organizations/${privateName}`)).status).toBe(404);
    expect((await request(`/api/v2/organizations/${privateName}`, token, "PATCH", {
      data: { type: "organizations", attributes: { "default-iac-binary": "terraform" } },
    })).status).toBe(404);
    expect((await request(`/api/v2/organizations/${createdName}`, orgToken)).status).toBe(404);
  });
});
