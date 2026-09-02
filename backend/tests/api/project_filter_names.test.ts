import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  users,
} from "../../src/db/schema";

describe("projects filter[names] (audit finding 11)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `filter-org-${suffix}`;
  const token = `user-token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  const createProject = (name: string) =>
    request(`/api/v2/organizations/${orgName}/projects`, "POST", {
      data: { attributes: { name } },
    });

  const namesOf = async (res: Response): Promise<string[]> => {
    const body = await res.json() as { data: { attributes: { name: string } }[] };
    return body.data.map((item): string => item.attributes.name);
  };

  beforeAll(async () => {
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token: hashAuthenticationToken(token), userId }]);
    for (const name of ["alpha", "beta", "gamma"]) {
      const res = await createProject(name);
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("returns only the named project for a single filter value", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/projects?filter[names]=beta`);
    expect(res.status).toBe(200);
    expect(await namesOf(res)).toEqual(["beta"]);
  });

  it("accepts comma-separated filter values", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/projects?filter[names]=alpha,gamma`);
    expect(res.status).toBe(200);
    expect(await namesOf(res)).toEqual(["alpha", "gamma"]);
  });

  it("accepts repeated filter params", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/projects?filter[names]=alpha&filter[names]=gamma`);
    expect(res.status).toBe(200);
    expect(await namesOf(res)).toEqual(["alpha", "gamma"]);
  });

  it("returns an empty page with zero total for unknown names", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/projects?filter[names]=missing`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { pagination: { "total-count": number } } };
    expect(body.data).toEqual([]);
    expect(body.meta.pagination["total-count"]).toBe(0);
  });

  it("lists everything without the filter", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/projects`);
    expect(res.status).toBe(200);
    const names = await namesOf(res);
    expect(names).toContain("alpha");
    expect(names).toContain("Default Project");
  });
});
