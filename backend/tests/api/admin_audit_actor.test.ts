import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, auditLogs, organizationMemberships, organizations, users } from "../../src/db/schema";

describe("admin audit actor identity", () => {
  const suffix = crypto.randomUUID();
  const userId = `admin-audit-user-${suffix}`;
  const orgId = `admin-audit-org-${suffix}`;
  const token = `admin-audit-token-${suffix}`;
  const auditId = `admin-audit-entry-${suffix}`;

  const request = (path: string, authToken: string | null = token): Promise<Response> => app.handle(new Request(`http://terrence.test${path}`, {
    headers: authToken === null ? {} : { Authorization: ["Bearer", authToken].join(" ") },
  }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, email: `${userId}@example.com`, passwordHash: "unused", isSiteAdmin: true });
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token: createHash("sha256").update(token).digest("hex"), userId });
    await db.insert(auditLogs).values({ id: auditId, orgId, userId, action: "admin-test", resourceType: "users", resourceId: userId, details: null, createdAt: Date.now() });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("includes username and email for the audit actor", async () => {
    const response = await request("/api/v2/admin/audit-logs");
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { id: string; attributes: Record<string, unknown> }[] };
    expect(body.data.find(({ id }) => id === auditId)).toMatchObject({
      attributes: {
        "actor-username": userId,
        "actor-email": `${userId}@example.com`,
      },
    });
  });

  it("uses one resource type and paginates every audit-log collection", async () => {
    await db.insert(auditLogs).values([
      { id: `admin-audit-page-1-${auditId}`, orgId, userId, action: "page-1", resourceType: "runs", resourceId: "run-1", details: null, createdAt: Date.now() + 3 },
      { id: `admin-audit-page-2-${auditId}`, orgId, userId, action: "page-2", resourceType: "runs", resourceId: "run-2", details: null, createdAt: Date.now() + 2 },
      { id: `admin-audit-page-3-${auditId}`, orgId, userId, action: "page-3", resourceType: "runs", resourceId: "run-3", details: null, createdAt: Date.now() + 1 },
    ]);
    const paths = [
      "/api/v2/admin/audit-logs",
      `/api/v2/organizations/${orgId}/audit-logs`,
      "/api/v2/organization-audit-trailers",
      "/api/v2/audit-trails",
    ];
    for (const path of paths) {
      const response = await request(`${path}?page[number]=1&page[size]=1`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        data: { type: string }[];
        links?: { next?: unknown };
        meta?: { pagination?: Record<string, unknown> };
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.type).toBe("audit-logs");
      expect(body.links?.next).toBeTypeOf("string");
      expect(body.meta?.pagination).toMatchObject({ "current-page": 1, "page-size": 1 });
      expect(Number(body.meta?.pagination?.["total-count"] ?? 0)).toBeGreaterThanOrEqual(3);
    }
  });

  it("returns 401 rather than a resource-not-found response without credentials", async () => {
    const paths = [
      "/api/v2/admin/audit-logs",
      `/api/v2/organizations/${orgId}/audit-logs`,
      "/api/v2/organization-audit-trailers",
      "/api/v2/audit-trails",
    ];
    for (const path of paths) expect((await request(path, null)).status).toBe(401);
  });
});
