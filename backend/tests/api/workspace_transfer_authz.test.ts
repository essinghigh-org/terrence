import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq, inArray } from "drizzle-orm";

import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  projects,
  users,
  workspaces,
  workspaceTransfers,
} from "../../src/db/schema";

// Workspace transfers move configuration, state, variables, and policy sets
// between organizations. The API must never let an unprivileged caller stage,
// read, or mutate a transfer: creation requires admin over the source
// workspace AND org-owner of the destination (or site admin); reads and
// lifecycle actions are scoped to the orgs a transfer touches.
describe("workspace transfer authorization", () => {
  const suffix = crypto.randomUUID();
  const adminId = `wt-admin-${suffix}`;
  const ownerId = `wt-owner-${suffix}`;
  const outsiderId = `wt-outsider-${suffix}`;
  const memberOnlyId = `wt-member-${suffix}`;
  const srcOrgId = `wt-src-org-${suffix}`;
  const dstOrgId = `wt-dst-org-${suffix}`;
  const wsId = `wt-ws-${suffix}`;
  const projectId = `wt-project-${suffix}`;
  const adminToken = `wt-tok-admin-${suffix}`;
  const ownerToken = `wt-tok-owner-${suffix}`;
  const outsiderToken = `wt-tok-out-${suffix}`;
  const memberToken = `wt-tok-member-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, token?: string): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));

  const createTransferBody = (sourceWorkspaceId: string, destinationOrgId: string): unknown => ({
    data: {
      type: "workspace-transfers",
      attributes: {},
      relationships: {
        "source-workspace": { data: { id: sourceWorkspaceId, type: "workspaces" } },
        "destination-organization": { data: { id: destinationOrgId, type: "organizations" } },
      },
    },
  });

  beforeAll(async () => {
    await db.insert(users).values([
      { id: adminId, username: `wt-admin-${suffix}@test`, passwordHash: "unused", isSiteAdmin: true },
      { id: ownerId, username: `wt-owner-${suffix}@test`, passwordHash: "unused" },
      { id: outsiderId, username: `wt-out-${suffix}@test`, passwordHash: "unused" },
      { id: memberOnlyId, username: `wt-mem-${suffix}@test`, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: srcOrgId, name: `wt-src-${suffix}` },
      { id: dstOrgId, name: `wt-dst-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values([
      // Source org: owned by ownerId; destination org: also owned by ownerId.
      { id: `wt-mem-src-${suffix}`, userId: ownerId, orgId: srcOrgId, role: "owner" },
      { id: `wt-mem-dst-${suffix}`, userId: ownerId, orgId: dstOrgId, role: "owner" },
      // Member (non-owner) of both orgs: must NOT be able to create transfers.
      { id: `wt-mem-m-${suffix}`, userId: memberOnlyId, orgId: srcOrgId, role: "member" },
      { id: `wt-mem-d2-${suffix}`, userId: memberOnlyId, orgId: dstOrgId, role: "member" },
    ]);
    await db.insert(apiTokens).values([
      { id: `wt-id-a-${suffix}`, token: hashAuthenticationToken(adminToken), userId: adminId },
      { id: `wt-id-o-${suffix}`, token: hashAuthenticationToken(ownerToken), userId: ownerId },
      { id: `wt-id-x-${suffix}`, token: hashAuthenticationToken(outsiderToken), userId: outsiderId },
      { id: `wt-id-m-${suffix}`, token: hashAuthenticationToken(memberToken), userId: memberOnlyId },
    ]);
    await db.insert(workspaces).values({ id: wsId, name: `wt-ws-${suffix}`, orgId: srcOrgId });
    await db.insert(projects).values({ id: projectId, orgId: dstOrgId, name: `wt-proj-${suffix}` });
  });

  const createdTransferIds: string[] = [];

  afterAll(async () => {
    await db.delete(workspaceTransfers).where(inArray(workspaceTransfers.id, createdTransferIds));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, srcOrgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, dstOrgId));
    await db.delete(organizations).where(eq(organizations.id, srcOrgId));
    await db.delete(organizations).where(eq(organizations.id, dstOrgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, adminToken));
    await db.delete(apiTokens).where(eq(apiTokens.token, ownerToken));
    await db.delete(apiTokens).where(eq(apiTokens.token, outsiderToken));
    await db.delete(apiTokens).where(eq(apiTokens.token, memberToken));
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, outsiderId));
    await db.delete(users).where(eq(users.id, memberOnlyId));
  });

  it("401s when unauthenticated", async () => {
    const res = await request("/api/v2/workspace-transfers", "POST", createTransferBody(wsId, dstOrgId));
    expect(res.status).toBe(401);
  });

  it("422s when the source workspace or destination org is missing", async () => {
    const noWs = await request("/api/v2/workspace-transfers", "POST", createTransferBody("does-not-exist", dstOrgId), ownerToken);
    expect(noWs.status).toBe(404);
    const noOrg = await request("/api/v2/workspace-transfers", "POST", createTransferBody(wsId, "org-never"), ownerToken);
    expect(noOrg.status).toBe(404);
  });

  it("rejects creation by a user who is not an admin of the source workspace", async () => {
    // outsider has no relationship with either org.
    const res = await request("/api/v2/workspace-transfers", "POST", createTransferBody(wsId, dstOrgId), outsiderToken);
    expect(res.status).toBe(404);
  });

  it("rejects creation by a non-owner member of the destination organization", async () => {
    // memberOnlyId belongs to both orgs but owns neither.
    const res = await request("/api/v2/workspace-transfers", "POST", createTransferBody(wsId, dstOrgId), memberToken);
    expect(res.status).toBe(404);
  });

  it("allows creation for a source-workspace admin who owns the destination org", async () => {
    const res = await request("/api/v2/workspace-transfers", "POST", createTransferBody(wsId, dstOrgId), ownerToken);
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string } };
    expect(body.data.id.startsWith("wt-")).toBeTrue();
    createdTransferIds.push(body.data.id);
  });

  it("allows creation for a site admin", async () => {
    const res = await request("/api/v2/workspace-transfers", "POST", createTransferBody(wsId, dstOrgId), adminToken);
    expect(res.status).toBe(201);
    const adminBody = await res.json() as { data: { id: string } };
    createdTransferIds.push(adminBody.data.id);
  });

  it("422s when the destination project belongs to another organization", async () => {
    const body = {
      data: {
        type: "workspace-transfers",
        attributes: {},
        relationships: {
          "source-workspace": { data: { id: wsId, type: "workspaces" } },
          "destination-organization": { data: { id: dstOrgId, type: "organizations" } },
          "destination-project": { data: { id: "project-of-other-org", type: "projects" } },
        },
      },
    };
    const res = await request("/api/v2/workspace-transfers", "POST", body, ownerToken);
    expect(res.status).toBe(422);
  });

  it("hides transfers in list and detail views from unrelated users", async () => {
    const createRes = await request("/api/v2/workspace-transfers", "POST", createTransferBody(wsId, dstOrgId), ownerToken);
    expect(createRes.status).toBe(201);
    const created = (await createRes.json() as { data: { id: string } }).data.id;
    createdTransferIds.push(created);

    // Outsider: hidden everywhere.
    const outsiderList = await request("/api/v2/workspace-transfers", "GET", undefined, outsiderToken);
    const outsiderBody = await outsiderList.json() as { data: { id: string }[] };
    expect(outsiderBody.data.some((t): boolean => t.id === created)).toBeFalse();
    const outsiderGet = await request(`/api/v2/workspace-transfers/${created}`, "GET", undefined, outsiderToken);
    expect(outsiderGet.status).toBe(404);

    // Destination-org owner: visible.
    const ownerList = await request("/api/v2/workspace-transfers", "GET", undefined, ownerToken);
    const ownerBody = await ownerList.json() as { data: { id: string }[] };
    expect(ownerBody.data.some((t): boolean => t.id === created)).toBeTrue();
    const ownerGet = await request(`/api/v2/workspace-transfers/${created}`, "GET", undefined, ownerToken);
    expect(ownerGet.status).toBe(200);
  });

  it("lets only authorized users cancel or resume a transfer", async () => {
    const createRes = await request("/api/v2/workspace-transfers", "POST", createTransferBody(wsId, dstOrgId), ownerToken);
    expect(createRes.status).toBe(201);
    const created = (await createRes.json() as { data: { id: string } }).data.id;
    createdTransferIds.push(created);

    const paused = await request("/api/v2/workspace-transfers", "POST", createTransferBody(wsId, dstOrgId), ownerToken);
    expect(paused.status).toBe(201);
    const pausedId = (await paused.json() as { data: { id: string } }).data.id;
    createdTransferIds.push(pausedId);

    const outsiderCancel = await request(`/api/v2/workspace-transfers/${created}/actions/cancel`, "POST", {}, outsiderToken);
    expect(outsiderCancel.status).toBe(404);
    const outsiderResume = await request(`/api/v2/workspace-transfers/${pausedId}/actions/resume`, "POST", {}, outsiderToken);
    expect(outsiderResume.status).toBe(404);

    const resume = await request(`/api/v2/workspace-transfers/${pausedId}/actions/resume`, "POST", {}, ownerToken);
    expect(resume.status).toBe(200);
    const cancel = await request(`/api/v2/workspace-transfers/${created}/actions/cancel`, "POST", {}, ownerToken);
    expect(cancel.status).toBe(200);
    const canceled = (await cancel.json() as { data: { attributes: { status: string } } }).data;
    expect(canceled.attributes.status).toBe("canceled");
  });
});