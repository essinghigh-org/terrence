import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  projectTags,
  projects,
  reservedTagKeys,
  users,
  workspaces,
} from "../../src/db/schema";

describe("reserved tag keys", () => {
  const prefix = crypto.randomUUID();
  const ownerId = `usr-owner-${prefix}`;
  const memberId = `usr-member-${prefix}`;
  const ownerToken = `token-owner-${prefix}`;
  const memberToken = `token-member-${prefix}`;
  const orgId = `org-${prefix}`;
  const orgName = `reserved-tags-${prefix}`;
  const projectId = `prj-${prefix}`;
  const workspaceId = `ws-${prefix}`;

  const request = (method: string, path: string, body?: unknown, token = ownerToken): Promise<Response> =>
    app.handle(new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const payload = (key: string, disableOverrides: boolean, id?: string): Record<string, unknown> => ({
    data: {
      ...(id === undefined ? {} : { id }),
      type: "reserved-tag-keys",
      attributes: { key, "disable-overrides": disableOverrides },
    },
  });

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerId, username: `reserved-owner-${prefix}`, passwordHash: "unused" },
      { id: memberId, username: `reserved-member-${prefix}`, passwordHash: "unused" },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: ownerToken, userId: ownerId },
      { id: crypto.randomUUID(), token: memberToken, userId: memberId },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), orgId, userId: ownerId, role: "owner" },
      { id: crypto.randomUUID(), orgId, userId: memberId, role: "member" },
    ]);
    await db.insert(projects).values({ id: projectId, orgId, name: `project-${prefix}` });
    await db.insert(workspaces).values({ id: workspaceId, orgId, projectId, name: `workspace-${prefix}` });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, memberId));
  });

  it("validates, lists, updates, and deletes organization reserved keys", async () => {
    expect((await request("POST", `/api/v2/organizations/${orgName}/reserved-tag-keys`, payload("bad/key", false))).status).toBe(422);
    expect((await request("POST", `/api/v2/organizations/${orgName}/reserved-tag-keys`, payload("x".repeat(129), false))).status).toBe(422);

    const key = "cost center:prod+blue@v1_2=ok";
    const created = await request("POST", `/api/v2/organizations/${orgName}/reserved-tag-keys`, payload(key, false));
    expect(created.status).toBe(201);
    const createdResource = (await created.json()).data;
    expect(createdResource.type).toBe("reserved-tag-keys");
    expect(createdResource.attributes).toMatchObject({ key, "disable-overrides": false });
    expect(createdResource.attributes["created-at"]).toBeString();
    expect(createdResource.links.self).toBe(`/api/v2/reserved-tags/${createdResource.id}`);

    expect((await request("POST", `/api/v2/organizations/${orgName}/reserved-tag-keys`, payload(key, true))).status).toBe(409);

    const listed = await request("GET", `/api/v2/organizations/${orgName}/reserved-tag-keys?page[size]=1`, undefined, memberToken);
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.data.map((item: { id: string }): string => item.id)).toContain(createdResource.id);
    expect(listBody.meta.pagination["total-count"]).toBe(1);

    expect((await request("PATCH", `/api/v2/reserved-tags/${createdResource.id}`, payload("billing.center", true, createdResource.id), memberToken)).status).toBe(404);

    const updated = await request("PATCH", `/api/v2/reserved-tags/${createdResource.id}`, payload("billing.center", true, createdResource.id));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.attributes).toMatchObject({
      key: "billing.center",
      "disable-overrides": true,
    });

    expect((await request("DELETE", `/api/v2/reserved-tags/${createdResource.id}`)).status).toBe(204);
    expect(await db.query.reservedTagKeys.findFirst({ where: eq(reservedTagKeys.id, createdResource.id) })).toBeUndefined();
  });

  it("rejects new workspace overrides across every tag write path", async () => {
    const projectTag = await request("POST", `/api/v2/projects/${projectId}/tag-bindings`, {
      data: { type: "tag-bindings", attributes: { key: "environment", value: "production" } },
    });
    expect(projectTag.status).toBe(201);
    expect((await request(
      "POST",
      `/api/v2/organizations/${orgName}/reserved-tag-keys`,
      payload("environment", true),
    )).status).toBe(201);

    const binding = { type: "tag-bindings", attributes: { key: "environment", value: "staging" } };
    expect((await request("PATCH", `/api/v2/workspaces/${workspaceId}/tag-bindings`, { data: [binding] })).status).toBe(422);
    expect((await request("POST", `/api/v2/workspaces/${workspaceId}/relationships/tags`, {
      data: [{ type: "tags", id: "environment", attributes: { value: "staging" } }],
    })).status).toBe(422);
    expect((await request("PATCH", `/api/v2/workspaces/${workspaceId}`, {
      data: {
        type: "workspaces",
        id: workspaceId,
        relationships: { "tag-bindings": { data: [binding] } },
      },
    })).status).toBe(422);
    expect((await request("POST", `/api/v2/organizations/${orgName}/workspaces`, {
      data: {
        type: "workspaces",
        attributes: { name: `locked-${prefix}` },
        relationships: {
          project: { data: { type: "projects", id: projectId } },
          "tag-bindings": { data: [binding] },
        },
      },
    })).status).toBe(422);

    const ordinary = await request("PATCH", `/api/v2/workspaces/${workspaceId}/tag-bindings`, {
      data: [{ type: "tag-bindings", attributes: { key: "team", value: "platform" } }],
    });
    expect(ordinary.status).toBe(200);

    const detachedWorkspaceId = `ws-detached-${prefix}`;
    await db.insert(workspaces).values({ id: detachedWorkspaceId, orgId, name: `detached-${prefix}` });
    expect((await request("PATCH", `/api/v2/workspaces/${detachedWorkspaceId}/tag-bindings`, {
      data: [binding],
    })).status).toBe(200);
    const move = {
      data: {
        type: "workspaces",
        id: detachedWorkspaceId,
        relationships: { project: { data: { type: "projects", id: projectId } } },
      },
    };
    expect((await request("PATCH", `/api/v2/workspaces/${detachedWorkspaceId}`, move)).status).toBe(422);
    expect((await request("PATCH", `/api/v2/workspaces/${detachedWorkspaceId}`, {
      data: {
        ...move.data,
        relationships: {
          ...move.data.relationships,
          "tag-bindings": { data: [] },
        },
      },
    })).status).toBe(200);
  });

  it("keeps existing overrides when locking a key but blocks later changes", async () => {
    await db.insert(projectTags).values({
      id: `ptag-region-${prefix}`,
      projectId,
      key: "region",
      value: "east",
    });
    const created = await request(
      "POST",
      `/api/v2/organizations/${orgName}/reserved-tag-keys`,
      payload("region", false),
    );
    const tagId = (await created.json()).data.id as string;

    expect((await request("PATCH", `/api/v2/workspaces/${workspaceId}/tag-bindings`, {
      data: [{ type: "tag-bindings", attributes: { key: "region", value: "west" } }],
    })).status).toBe(200);
    expect((await request("PATCH", `/api/v2/reserved-tags/${tagId}`, payload("region", true, tagId))).status).toBe(200);

    const effective = await request("GET", `/api/v2/workspaces/${workspaceId}/effective-tag-bindings`);
    const region = (await effective.json()).data.find((item: { attributes: { key: string } }): boolean => item.attributes.key === "region");
    expect(region.attributes.value).toBe("west");

    expect((await request("PATCH", `/api/v2/workspaces/${workspaceId}/tag-bindings`, {
      data: [{ type: "tag-bindings", attributes: { key: "region", value: "north" } }],
    })).status).toBe(422);
    expect((await request("DELETE", `/api/v2/workspaces/${workspaceId}/relationships/tags`, {
      data: [{ type: "tags", id: "region" }],
    })).status).toBe(204);

    const inherited = await request("GET", `/api/v2/workspaces/${workspaceId}/effective-tag-bindings`);
    const inheritedRegion = (await inherited.json()).data.find((item: { attributes: { key: string } }): boolean => item.attributes.key === "region");
    expect(inheritedRegion.attributes.value).toBe("east");
  });
});
