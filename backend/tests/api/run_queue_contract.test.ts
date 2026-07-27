import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";

describe("native Terraform organization run queue", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const otherOrgId = `other-org-${suffix}`;
  const orgName = `queue-${suffix}`;
  const token = `token-${suffix}`;
  const workspaceIds = [`workspace-a-${suffix}`, `workspace-b-${suffix}`];
  const runIds = {
    planning: `run-planning-${suffix}`,
    applying: `run-applying-${suffix}`,
    firstPending: `run-pending-a-${suffix}`,
    secondPending: `run-pending-b-${suffix}`,
  };

  const request = (path: string) => app.handle(new Request(`http://terrence.test${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: `queue-${suffix}`, passwordHash: "unused" });
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: otherOrgId, name: `private-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values({
      id: `membership-${suffix}`,
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({
      id: `token-${suffix}`,
      token,
      userId,
      description: "run queue contract",
    });
    await db.insert(workspaces).values([
      { id: workspaceIds[0], name: "alpha", orgId, locked: true },
      { id: workspaceIds[1], name: "beta", orgId, locked: true },
      { id: `private-workspace-${suffix}`, name: "private", orgId: otherOrgId, locked: true },
    ]);
    await db.insert(runs).values([
      { id: runIds.planning, workspaceId: workspaceIds[0], status: "planning", createdAt: 100 },
      { id: runIds.applying, workspaceId: workspaceIds[1], status: "applying", createdAt: 200 },
      { id: runIds.firstPending, workspaceId: workspaceIds[0], status: "pending", createdAt: 300 },
      { id: runIds.secondPending, workspaceId: workspaceIds[1], status: "pending", createdAt: 400 },
      { id: `run-planned-${suffix}`, workspaceId: workspaceIds[0], status: "planned", createdAt: 500 },
      {
        id: `run-private-${suffix}`,
        workspaceId: `private-workspace-${suffix}`,
        status: "pending",
        createdAt: 50,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("returns the paginated active queue with client-readable positions", async () => {
    const response = await request(
      `/api/v2/organizations/${orgName}/runs/queue?page[number]=2&page[size]=2`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((run: any) => run.id)).toEqual([
      runIds.firstPending,
      runIds.secondPending,
    ]);
    expect(body.data.map((run: any) => run.attributes["position-in-queue"])).toEqual([3, 4]);
    expect(body.meta.pagination).toMatchObject({
      "current-page": 2,
      "page-size": 2,
      "total-pages": 2,
      "total-count": 4,
    });
  });

  it("reports pending and running organization capacity", async () => {
    const response = await request(`/api/v2/organizations/${orgName}/capacity`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        id: orgName,
        type: "organization-capacity",
        attributes: { pending: 2, running: 2 },
      },
    });
  });

  it("hides organizations outside the token scope", async () => {
    expect((await request(`/api/v2/organizations/private-${suffix}/runs/queue`)).status).toBe(404);
    expect((await request(`/api/v2/organizations/private-${suffix}/capacity`)).status).toBe(404);
  });
});
