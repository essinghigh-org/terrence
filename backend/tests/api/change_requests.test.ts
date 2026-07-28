import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  changeRequests,
  organizationMemberships,
  organizations,
  users,
  workspaces,
} from "../../src/db/schema";

describe("change request API", () => {
  const suffix = crypto.randomUUID();
  const ownerId = `change-owner-${suffix}`;
  const outsiderId = `change-outsider-${suffix}`;
  const orgId = `change-org-${suffix}`;
  const workspaceId = `change-workspace-${suffix}`;
  const workspaceName = `change-workspace-name-${suffix}`;
  const ownerToken = `change-owner-token-${suffix}`;
  const outsiderToken = `change-outsider-token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, token = ownerToken): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerId, username: ownerId, passwordHash: "unused" },
      { id: outsiderId, username: outsiderId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId: ownerId, orgId, role: "owner" });
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: ownerToken, userId: ownerId },
      { id: crypto.randomUUID(), token: outsiderToken, userId: outsiderId },
    ]);
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceName, orgId });
  });

  afterAll(async () => {
    await db.delete(changeRequests).where(eq(changeRequests.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, ownerId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, outsiderId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, outsiderId));
  });

  it("creates, lists, and shows workspace change requests", async () => {
    const invalid = await request(`/api/v2/workspaces/${workspaceId}/change-requests`, "POST", {
      data: { type: "workspace-change-requests", attributes: { subject: "" } },
    });
    expect(invalid.status).toBe(422);

    const created = await request(`/api/v2/workspaces/${workspaceId}/change-requests`, "POST", {
      data: {
        type: "workspace-change-requests",
        attributes: { subject: "Rotate credentials", message: "Move this workspace to short-lived credentials." },
      },
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const id = createdBody.data.id as string;
    expect(createdBody.data.attributes.status).toBe("pending");

    const listed = await request(`/api/v2/workspaces/${workspaceName}/change-requests?page[size]=1`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.data.map((item: { id: string }): string => item.id)).toContain(id);
    expect(listedBody.meta.pagination["total-count"]).toBe(1);

    expect((await request(`/api/v2/change-requests/${id}`)).status).toBe(200);
    expect((await request(`/api/v2/workspaces/change-requests/${id}`)).status).toBe(200);
    expect((await request(`/api/v2/change-requests/${id}`, "GET", undefined, outsiderToken)).status).toBe(404);
  });

  it("approves and discards pending requests exactly once", async () => {
    const create = async (subject: string): Promise<string> => {
      const response = await request(`/api/v2/workspaces/${workspaceId}/change-requests`, "POST", {
        data: { attributes: { subject, message: `${subject} details` } },
      });
      return (await response.json()).data.id as string;
    };

    const approvedId = await create("Approved request");
    const approved = await request(`/api/v2/change-requests/${approvedId}/actions/approve`, "POST");
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody.data.attributes.status).toBe("approved");
    expect(approvedBody.data.attributes["archived-at"]).toBeString();
    expect((await request(`/api/v2/change-requests/${approvedId}/actions/discard`, "POST")).status).toBe(409);

    const discardedId = await create("Discarded request");
    const discarded = await request(`/api/v2/change-requests/${discardedId}/actions/discard`, "POST");
    expect(discarded.status).toBe(200);
    expect((await discarded.json()).data.attributes.status).toBe("discarded");
  });
});
