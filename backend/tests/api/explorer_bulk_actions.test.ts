import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  explorerBulkActionRecords,
  organizationMemberships,
  organizations,
  users,
  workspaces,
} from "../../src/db/schema";

describe("preserved Explorer bulk-action compatibility", () => {
  const suffix = crypto.randomUUID();
  const ownerId = `explorer-bulk-owner-${suffix}`;
  const outsiderId = `explorer-bulk-outsider-${suffix}`;
  const orgId = `explorer-bulk-org-${suffix}`;
  const workspaceId = `explorer-bulk-workspace-${suffix}`;
  const queryWorkspaceId = `explorer-bulk-query-workspace-${suffix}`;
  const ownerToken = `explorer-bulk-owner-token-${suffix}`;
  const outsiderToken = `explorer-bulk-outsider-token-${suffix}`;

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
      { id: crypto.randomUUID(), token: hashAuthenticationToken(ownerToken), userId: ownerId },
      { id: crypto.randomUUID(), token: hashAuthenticationToken(outsiderToken), userId: outsiderId },
    ]);
    await db.insert(workspaces).values([
      { id: workspaceId, name: `selected-${suffix}`, orgId },
      { id: queryWorkspaceId, name: `query-target-${suffix}`, orgId },
    ]);
  });

  afterAll(async () => {
    await db.delete(explorerBulkActionRecords).where(inArray(explorerBulkActionRecords.workspaceId, [workspaceId, queryWorkspaceId]));
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, ownerId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, outsiderId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, outsiderId));
  });

  it("keeps Explorer selection and query bulk actions functional", async () => {
    const path = `/api/v2/organizations/${orgId}/explorer/bulk-actions`;
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
    const targetRows = await db.query.explorerBulkActionRecords.findMany({ where: eq(explorerBulkActionRecords.subject, subject) });
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
            filter: [{ workspace_name: { contains: [`query-target-${suffix}`] } }],
          },
        },
      },
    });
    expect(queryResponse.status).toBe(201);
    const queryRows = await db.query.explorerBulkActionRecords.findMany({ where: eq(explorerBulkActionRecords.subject, querySubject) });
    expect(queryRows.map((row): string => row.workspaceId)).toEqual([queryWorkspaceId]);

    const constrainedResponse = await request(path, "POST", {
      data: {
        type: "bulk_actions",
        attributes: {
          action_type: "change_requests",
          action_inputs: { subject: `Constrained ${suffix}`, message: "Status must also match." },
          query: {
            type: "workspaces",
            filter: [
              { workspace_name: { contains: [`query-target-${suffix}`] } },
              { current_run_status: { is: ["errored"] } },
            ],
          },
        },
      },
    });
    expect(constrainedResponse.status).toBe(422);
    expect((await db.query.explorerBulkActionRecords.findMany({
      where: eq(explorerBulkActionRecords.subject, `Constrained ${suffix}`),
    }))).toEqual([]);

    expect((await request(path, "POST", {
      data: {
        type: "bulk_actions",
        attributes: {
          action_type: "change_requests",
          action_inputs: { subject: `Too many ${suffix}`, message: "Reject oversized selections." },
          target_ids: Array.from({ length: 501 }, (): string => workspaceId),
        },
      },
    })).status).toBe(422);

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

  it("does not expose the removed workspace change-request routes", async () => {
    const response = await request(`/api/v2/workspaces/${workspaceId}/change-requests`);
    expect(response.status).toBe(404);
  });
});
