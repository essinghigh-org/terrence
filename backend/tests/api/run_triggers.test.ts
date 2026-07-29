import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
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

describe("Workspace Run Triggers & Cost Estimates API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `rt-org-${suffix}`;
  const token = `user-token-${suffix}`;
  const targetWsId = `ws-target-${suffix}`;
  const sourceWsId = `ws-source-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token, userId }]);
    await db.insert(workspaces).values([
      { id: targetWsId, name: `target-${suffix}`, orgId },
      { id: sourceWsId, name: `source-${suffix}`, orgId },
    ]);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, targetWsId));
    await db.delete(workspaces).where(eq(workspaces.id, sourceWsId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("attaches, lists, and detaches run triggers on a workspace", async () => {
    // 1. Attach run trigger
    const attachRes = await request(`/api/v2/workspaces/${targetWsId}/relationships/run-triggers`, "POST", {
      data: [{ id: sourceWsId, type: "workspaces" }],
    });
    expect(attachRes.status).toBe(204);

    // 2. List run triggers
    const listRes = await request(`/api/v2/workspaces/${targetWsId}/run-triggers`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.some((t: any) => t.relationships["sourceable-workspace"].data.id === sourceWsId)).toBeTrue();

    // 3. Detach run trigger
    const detachRes = await request(`/api/v2/workspaces/${targetWsId}/relationships/run-triggers`, "DELETE", {
      data: [{ id: sourceWsId, type: "workspaces" }],
    });
    expect(detachRes.status).toBe(204);

    const listAfterRes = await request(`/api/v2/workspaces/${targetWsId}/run-triggers`);
    const listAfterBody = await listAfterRes.json();
    expect(listAfterBody.data.length).toBe(0);
  });

  it("returns cost estimates for a run", async () => {
    const runId = `run-ce-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId: targetWsId,
      status: "applied",
      createdAt: Date.now(),
    });

    const ceRes = await request(`/api/v2/runs/${runId}/cost-estimate`);
    expect(ceRes.status).toBe(200);
    const ceBody = await ceRes.json();
    expect(ceBody.data.attributes.status).toBe("finished");

    await db.delete(runs).where(eq(runs.id, runId));
  });
});
