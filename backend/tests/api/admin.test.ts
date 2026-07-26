import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  users,
  workspaces,
} from "../../src/db/schema";

describe("Admin Operations API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `adminuser-${suffix}`;
  const orgId = `adminorg-${suffix}`;
  const orgName = `admin-org-${suffix}`;
  const token = `admin-token-${suffix}`;
  const workspaceId = `admin-ws-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused", isSiteAdmin: true }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    // Token stored as hash
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token: tokenHash, userId }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId }]);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.delete(apiTokens).where(eq(apiTokens.token, tokenHash));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("lists all users, orgs, workspaces, and runs via site admin endpoints", async () => {
    // 1. Admin Users list
    const getUsersRes = await request("/api/v2/admin/users");
    expect(getUsersRes.status).toBe(200);
    const getUsersBody = await getUsersRes.json();
    expect(getUsersBody.data.some((u: any) => u.id === userId)).toBeTrue();

    // 2. Admin Single User show
    const getUserRes = await request(`/api/v2/admin/users/${userId}`);
    expect(getUserRes.status).toBe(200);
    const getUserBody = await getUserRes.json();
    expect(getUserBody.data.attributes.username).toBe(userId);

    // 3. Admin Organizations list
    const getOrgsRes = await request("/api/v2/admin/organizations");
    expect(getOrgsRes.status).toBe(200);
    const getOrgsBody = await getOrgsRes.json();
    expect(getOrgsBody.data.some((o: any) => o.id === orgId)).toBeTrue();

    // 4. Admin Workspaces list
    const getWsRes = await request("/api/v2/admin/workspaces");
    expect(getWsRes.status).toBe(200);
    const getWsBody = await getWsRes.json();
    expect(getWsBody.data.some((w: any) => w.id === workspaceId)).toBeTrue();

    // 5. Admin Terraform versions
    const getTfVerRes = await request("/api/v2/admin/terraform-versions");
    expect(getTfVerRes.status).toBe(200);
    const getTfVerBody = await getTfVerRes.json();
    expect(getTfVerBody.data.length).toBeGreaterThan(0);
  });
});
