import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
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

describe("JSON:API pagination", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const otherOrgId = `other-org-${suffix}`;
  const orgName = `pagination-${suffix}`;
  const token = `token-${suffix}`;
  const workspaceIds = [`workspace-a-${suffix}`, `workspace-b-${suffix}`];
  const privateWorkspaceId = `workspace-private-${suffix}`;
  const runIds = [`run-new-${suffix}`, `run-old-${suffix}`];
  const privateRunId = `run-private-${suffix}`;

  const request = (path: string) => app.handle(new Request(`http://terrence.test${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));

  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      username: `pagination-${suffix}`,
      passwordHash: "unused",
    });
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
      token: hashAuthenticationToken(token),
      userId,
      description: "pagination contract",
    });
    await db.insert(workspaces).values([
      { id: workspaceIds[0]!, name: "alpha", orgId },
      { id: workspaceIds[1]!, name: "beta", orgId },
      { id: privateWorkspaceId, name: "private", orgId: otherOrgId },
    ]);
    await db.insert(runs).values([
      {
        id: runIds[0]!,
        workspaceId: workspaceIds[0]!,
        status: "planned",
        createdAt: 200,
      },
      {
        id: runIds[1]!,
        workspaceId: workspaceIds[1]!,
        status: "planned",
        createdAt: 100,
      },
      {
        id: privateRunId,
        workspaceId: privateWorkspaceId,
        status: "planned",
        createdAt: 300,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("parses bracket parameters and scopes page-two workspace and run counts", async () => {
    const workspaceResponse = await request(
      `/api/v2/organizations/${orgName}/workspaces?page[number]=2&page[size]=1`,
    );
    expect(workspaceResponse.status).toBe(200);
    const workspacePage = await workspaceResponse.json();
    expect(workspacePage.data).toHaveLength(1);
    expect(workspaceIds).toContain(workspacePage.data[0].id);
    expect(workspacePage.meta.pagination).toEqual({
      "current-page": 2,
      "page-size": 1,
      "prev-page": 1,
      "next-page": null,
      "total-pages": 2,
      "total-count": 2,
    });
    expect(workspacePage.links).toMatchObject({
      self: expect.stringContaining("page[number]=2"),
      first: expect.stringContaining("page%5Bnumber%5D=1"),
      prev: expect.stringContaining("page%5Bnumber%5D=1"),
      next: null,
      last: expect.stringContaining("page%5Bnumber%5D=2"),
    });

    const runResponse = await request(
      `/api/v2/organizations/${orgName}/runs?page[number]=2&page[size]=1`,
    );
    expect(runResponse.status).toBe(200);
    const runPage = await runResponse.json();
    expect(runPage.data.map((run: any) => run.id)).toEqual([runIds[1]]);
    expect(runPage.data.map((run: any) => run.id)).not.toContain(privateRunId);
    expect(runPage.meta.pagination).toEqual({
      "current-page": 2,
      "page-size": 1,
      "prev-page": 1,
      "next-page": null,
      "total-pages": 2,
      "total-count": 2,
    });
    expect(runPage.links).toMatchObject({
      self: expect.stringContaining("page[number]=2"),
      prev: expect.stringContaining("page%5Bnumber%5D=1"),
      next: null,
      last: expect.stringContaining("page%5Bnumber%5D=2"),
    });
  });

  it("complete multi-page traversal returns each authorized resource exactly once without duplicates", async () => {
    // Collect all pages for workspaces with page[size]=1
    const collectedWorkspaceIds: string[] = [];
    let pageNum = 1;
    let hasNext = true;

    while (hasNext) {
      const res = await request(
        `/api/v2/organizations/${orgName}/workspaces?page[number]=${pageNum}&page[size]=1`,
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      for (const item of json.data) {
        collectedWorkspaceIds.push(item.id);
      }
      hasNext = json.meta.pagination["next-page"] !== null;
      pageNum += 1;
    }

    expect(collectedWorkspaceIds).toHaveLength(2);
    expect(new Set(collectedWorkspaceIds).size).toBe(2);
    expect(collectedWorkspaceIds.sort()).toEqual([...workspaceIds].sort());
    expect(collectedWorkspaceIds).not.toContain(privateWorkspaceId);
  });

  it("included relationships never bypass authorization or cross tenant boundaries", async () => {
    const res = await request(
      `/api/v2/organizations/${orgName}/runs?include=workspace&page[size]=10`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Data must only contain authorized runs
    const returnedRunIds = body.data.map((r: any) => r.id);
    expect(returnedRunIds).not.toContain(privateRunId);

    // Included resources must only belong to the authorized organization
    if (Array.isArray(body.included)) {
      const includedWorkspaceIds = body.included
        .filter((item: any) => item.type === "workspaces")
        .map((item: any) => item.id);
      expect(includedWorkspaceIds).not.toContain(privateWorkspaceId);
      for (const wsId of includedWorkspaceIds) {
        expect(workspaceIds).toContain(wsId);
      }
    }
  });

  it("pagination metadata stays consistent with query filters", async () => {
    // Filter matching a single workspace "alpha"
    const res = await request(
      `/api/v2/organizations/${orgName}/workspaces?q=alpha&page[number]=1&page[size]=10`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].attributes.name).toBe("alpha");
    expect(body.meta.pagination).toEqual({
      "current-page": 1,
      "page-size": 10,
      "prev-page": null,
      "next-page": null,
      "total-pages": 1,
      "total-count": 1,
    });

    // Filter matching nothing
    const noMatchRes = await request(
      `/api/v2/organizations/${orgName}/workspaces?q=nonexistent-query-string&page[number]=1&page[size]=10`,
    );
    expect(noMatchRes.status).toBe(200);
    const noMatchBody = await noMatchRes.json();
    expect(noMatchBody.data).toHaveLength(0);
    expect(noMatchBody.meta.pagination).toEqual({
      "current-page": 1,
      "page-size": 10,
      "prev-page": null,
      "next-page": null,
      "total-pages": 1,
      "total-count": 0,
    });
  });
});