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

  const request = (path: string): Promise<Response> => app.handle(new Request(`http://terrence.test${path}`, {
    headers: { Authorization: `Bearer ${token}` },
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
});
