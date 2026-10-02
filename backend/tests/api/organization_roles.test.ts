import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, users } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("organization roles", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-roles-${suffix}`;
  const orgName = `roles-${suffix}`;
  const userId = `usr-roles-${suffix}`;
  const token = `token-roles-${suffix}`;
  const membershipId = `membership-roles-${suffix}`;
  const request = (path: string, method = "GET", body?: unknown): Promise<Response> =>
    app.handle(
      new Request(`http://terrence.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: membershipId, userId, orgId, role: "owner" });
    await db
      .insert(apiTokens)
      .values({ id: `token-row-${suffix}`, token: createHash("sha256").update(token).digest("hex"), userId });
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });
  it("creates, updates, lists, and assigns a named permission role", async () => {
    const create = await request(`/api/v2/organizations/${orgName}/roles`, "POST", {
      data: {
        type: "organization-roles",
        attributes: {
          name: "Workspace operator",
          description: "Can manage workspaces",
          permissions: { "manage-workspaces": true },
        },
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      data: { id: string; attributes: { permissions: Record<string, boolean> } };
    };
    expect(created.data.attributes.permissions["manage-workspaces"]).toBe(true);
    const listed = await request(`/api/v2/organizations/${orgName}/roles`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);
    const assigned = await request(`/api/v2/organization-memberships/${membershipId}/roles`, "PUT", {
      data: [{ id: created.data.id, type: "organization-roles" }],
    });
    expect(assigned.status).toBe(200);
    expect(((await assigned.json()) as { data: unknown[] }).data).toHaveLength(1);
  });
  it("preserves omitted fields during PATCH", async () => {
    const create = await request(`/api/v2/organizations/${orgName}/roles`, "POST", {
      data: {
        type: "organization-roles",
        attributes: {
          name: "Patchable",
          description: "keep me",
          permissions: { "manage-workspaces": true },
        },
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { id: string; attributes: { name: string } } };
    const id = created.data.id;

    const rename = await request(`/api/v2/organization-roles/${id}`, "PATCH", {
      data: { type: "organization-roles", attributes: { name: "Renamed" } },
    });
    expect(rename.status).toBe(200);
    const renamed = (await rename.json()) as {
      data: { attributes: { name: string; description: string | null; permissions: Record<string, boolean> } };
    };
    expect(renamed.data.attributes.name).toBe("Renamed");
    expect(renamed.data.attributes.description).toBe("keep me");
    expect(renamed.data.attributes.permissions["manage-workspaces"]).toBe(true);

    const permissionsOnly = await request(`/api/v2/organization-roles/${id}`, "PATCH", {
      data: { type: "organization-roles", attributes: { permissions: {} } },
    });
    expect(permissionsOnly.status).toBe(200);
    const cleared = (await permissionsOnly.json()) as {
      data: { attributes: { name: string; description: string | null; permissions: Record<string, boolean> } };
    };
    expect(cleared.data.attributes.name).toBe("Renamed");
    expect(cleared.data.attributes.description).toBe("keep me");
    expect(cleared.data.attributes.permissions).toEqual({});

    const descriptionOnly = await request(`/api/v2/organization-roles/${id}`, "PATCH", {
      data: { type: "organization-roles", attributes: { description: null } },
    });
    expect(descriptionOnly.status).toBe(200);
    const nulled = (await descriptionOnly.json()) as {
      data: { attributes: { name: string; description: string | null; permissions: Record<string, boolean> } };
    };
    expect(nulled.data.attributes.name).toBe("Renamed");
    expect(nulled.data.attributes.description).toBeNull();
    expect(nulled.data.attributes.permissions).toEqual({});

    const invalid = await request(`/api/v2/organization-roles/${id}`, "PATCH", {
      data: { type: "organization-roles", attributes: { permissions: { "manage-workspaces": "yes" } } },
    });
    expect(invalid.status).toBe(422);
  });
});
