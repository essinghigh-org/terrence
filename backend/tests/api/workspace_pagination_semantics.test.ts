import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, organizationMemberships, organizations, users, workspaces,
} from "../../src/db/schema";

/**
 * NOT-013: Optional pagination semantics parity.
 *
 * the reference format list endpoints treat absent pagination params as "first page, default
 * size" rather than "return every row". Terrence mirrors this via
 * pageRequest (src/lib/utils.ts:1127): absent -> { number: 1, size: 20 },
 * with `page[size]` clamped to a maximum of 100. These tests pin that
 * contract through the real workspace-list endpoint so a refactor that
 * silently changes the default size or drops the cap is caught.
 */
describe("Workspace list pagination semantics (NOT-013)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `pagsem-${suffix}`;
  const token = `token-${suffix}`;
  const workspaceIds: string[] = [];

  const request = (path: string) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));

  const createdNames = Array.from({ length: 45 }, (_, i) => `ws-${String(i).padStart(2, "0")}-${suffix}`);

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token, userId });
    for (const name of createdNames) {
      const id = `ws-${suffix}-${name}`;
      workspaceIds.push(id);
      await db.insert(workspaces).values({ id, name, orgId });
    }
  });

  afterAll(async () => {
    await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("absent pagination params return the default first page of 20 (not all rows)", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(20);
    expect(body.meta.pagination).toMatchObject({
      "current-page": 1,
      "page-size": 20,
      "total-count": 45,
      "total-pages": 3,
    });
    // next-page must be present (more pages exist); prev must be null on page 1.
    expect(body.meta.pagination["next-page"]).toBe(2);
    expect(body.meta.pagination["prev-page"]).toBe(null);
  });

  it("honors an explicit page[size] and returns the matching slice", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces?page%5Bnumber%5D=1&page%5Bsize%5D=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(10);
    expect(body.meta.pagination["page-size"]).toBe(10);
    expect(body.meta.pagination["total-pages"]).toBe(5);

    // Page 2 must return a disjoint slice and report the requested page in meta.
    const page2 = await request(`/api/v2/organizations/${orgName}/workspaces?page%5Bnumber%5D=2&page%5Bsize%5D=10`);
    expect(page2.status).toBe(200);
    const page2Body = await page2.json();
    const page1Ids = body.data.map((w: { id: string }) => w.id);
    const page2Ids = page2Body.data.map((w: { id: string }) => w.id);
    expect(page2Body.data).toHaveLength(10);
    expect(page2Body.meta.pagination["current-page"]).toBe(2);
    expect(page2Ids).not.toEqual(page1Ids);
    expect(page2Ids.some((id: string) => page1Ids.includes(id))).toBe(false);
  });

  it("clamps page[size] to the 100 maximum", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces?page%5Bsize%5D=500`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // 45 rows total, requested 500 -> clamped to 100 but capped by total count.
    expect(body.meta.pagination["page-size"]).toBe(100);
    expect(body.data).toHaveLength(45);
  });

  it("returns an empty page with correct meta when page[number] exceeds total pages", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces?page%5Bnumber%5D=99&page%5Bsize%5D=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(0);
    expect(body.meta.pagination["current-page"]).toBe(99);
    expect(body.meta.pagination["total-pages"]).toBe(5);
    expect(body.meta.pagination["next-page"]).toBe(null);
  });

  it("falls back to defaults for non-positive / non-numeric pagination values", async () => {
    const nonPositive = await request(`/api/v2/organizations/${orgName}/workspaces?page%5Bnumber%5D=0&page%5Bsize%5D=-5`);
    expect(nonPositive.status).toBe(200);
    const body = await nonPositive.json();
    expect(body.data).toHaveLength(20);
    expect(body.meta.pagination["current-page"]).toBe(1);
    expect(body.meta.pagination["page-size"]).toBe(20);

    // Non-numeric values must also fall back to the defaults rather than 5xx.
    const nonNumeric = await request(`/api/v2/organizations/${orgName}/workspaces?page%5Bnumber%5D=abc&page%5Bsize%5D=xyz`);
    expect(nonNumeric.status).toBe(200);
    const body2 = await nonNumeric.json();
    expect(body2.meta.pagination["current-page"]).toBe(1);
    expect(body2.meta.pagination["page-size"]).toBe(20);
  });
});
