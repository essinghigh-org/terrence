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
  const queryWorkspaceId = `change-query-workspace-${suffix}`;
  const queryWorkspaceName = `query-target-${suffix}`;
  const ownerToken = `change-owner-token-${suffix}`;
  const outsiderToken = `change-outsider-token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, token = ownerToken): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    await db.insert(workspaces).values([
      { id: workspaceId, name: workspaceName, orgId },
      { id: queryWorkspaceId, name: queryWorkspaceName, orgId },
    ]);
  });

  afterAll(async () => {
    await db.delete(changeRequests).where(eq(changeRequests.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
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
    const listedResource = listedBody.data.find((item: { id: string }): boolean => item.id === id);
    expect(listedResource).toEqual({
      id,
      type: "workspace_change_requests",
      attributes: {
        subject: "Rotate credentials",
        message: "Move this workspace to short-lived credentials.",
        "archived-by": null,
        "archived-at": null,
        "created-at": expect.any(String),
        "updated-at": expect.any(String),
      },
      relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } },
    });

    const shown = await request(`/api/v2/change-requests/${id}`);
    expect(shown.status).toBe(200);
    expect((await shown.json()).data.type).toBe("workspace_change_requests");
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

  it("creates independent change requests through Explorer selections and queries", async () => {
    const subject = `Bulk targets ${suffix}`;
    const targetPayload = {
      data: {
        type: "bulk_actions",
        attributes: {
          action_type: "change_request",
          action_inputs: { subject, message: "Update every selected workspace." },
          target_ids: [workspaceId, queryWorkspaceId],
        },
      },
    };
    const path = `/api/v2/organizations/${orgId}/explorer/bulk-actions`;
    expect((await request(path, "POST", targetPayload, outsiderToken)).status).toBe(404);

    const response = await request(path, "POST", targetPayload);
    expect(response.status).toBe(201);
    expect((await response.json()).data).toEqual({
      id: expect.stringMatching(/^eba-/),
      type: "explorer_bulk_actions",
      attributes: {
        organization_id: orgId,
        action_type: "change_requests",
        action_inputs: { subject, message: "Update every selected workspace." },
        created_by: { id: ownerId, type: "users" },
      },
    });
    const targetRows = await db.query.changeRequests.findMany({ where: eq(changeRequests.subject, subject) });
    expect(targetRows.map((row): string => row.workspaceId).sort()).toEqual([queryWorkspaceId, workspaceId].sort());

    const querySubject = `Query target ${suffix}`;
    const queryResponse = await request(path, "POST", {
      data: {
        type: "bulk_actions",
        attributes: {
          action_type: "change_requests",
          action_inputs: { subject: querySubject, message: "Only the query match." },
          query: {
            type: "workspaces",
            filter: [{ workspace_name: { contains: ["query-target-"] } }],
          },
        },
      },
    });
    expect(queryResponse.status).toBe(201);
    const queryRows = await db.query.changeRequests.findMany({ where: eq(changeRequests.subject, querySubject) });
    expect(queryRows.map((row): string => row.workspaceId)).toEqual([queryWorkspaceId]);

    expect((await request(path, "POST", {
      data: {
        type: "bulk_actions",
        attributes: {
          action_type: "change_requests",
          action_inputs: { subject: "Missing targets", message: "No selector." },
        },
      },
    })).status).toBe(422);
  });

  it("archives a change request through the documented workspace endpoint", async () => {
    const created = await request(`/api/v2/workspaces/${workspaceId}/change-requests`, "POST", {
      data: { attributes: { subject: "Archive request", message: "This work is complete." } },
    });
    const id = (await created.json()).data.id as string;
    expect((await request(`/api/v2/workspaces/change-requests/${id}`, "PATCH", undefined, outsiderToken)).status).toBe(404);

    const archived = await request(`/api/v2/workspaces/change-requests/${id}`, "PATCH");
    expect(archived.status).toBe(200);
    expect((await archived.json()).data).toEqual({
      id,
      type: "workspace_change_requests",
      attributes: {
        subject: "Archive request",
        message: "This work is complete.",
        "archived-by": ownerId,
        "archived-at": expect.any(String),
        "created-at": expect.any(String),
        "updated-at": expect.any(String),
      },
      relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } },
    });
    expect((await db.query.changeRequests.findFirst({ where: eq(changeRequests.id, id) }))?.status).toBe("archived");
    expect((await request(`/api/v2/workspaces/change-requests/${id}`, "PATCH")).status).toBe(409);
  });
});
