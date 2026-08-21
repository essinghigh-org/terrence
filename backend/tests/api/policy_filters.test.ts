import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, organizationMemberships, organizations, policies,
  policySets, users,
} from "../../src/db/schema";

/**
 * POL-001: filter[kind] and search[name] on policies + policy-sets list endpoints.
 *
 * the reference format list filters (policies.mdx / policy-sets.mdx):
 *   filter[kind]=sentinel|opa  — restricts to a policy-set kind.
 *   search[name]=<text>        — documented the reference format name search.
 * The legacy `q` alias is also supported for backward compatibility (matches
 * the workspaces list endpoint convention at workspaces.ts:372).
 * These tests pin the filters on the org-scoped policies and policy-sets
 * list endpoints (src/routes/policies.ts:350, 528) so they cannot regress.
 */
describe("Policy & policy-set list filters (POL-001)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `polfilter-${suffix}`;
  const token = `token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const sentinelPolicyId = `pol-sentinel-${suffix}`;
  const opaPolicyId = `pol-opa-${suffix}`;
  const sentinelSetId = `polset-sentinel-${suffix}`;
  const opaSetId = `polset-opa-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token, userId });
    await db.insert(policies).values({
      id: sentinelPolicyId, orgId, name: "Sentinel Policy Alpha", kind: "sentinel",
    });
    await db.insert(policies).values({
      id: opaPolicyId, orgId, name: "OPA Policy Beta", kind: "opa",
    });
    await db.insert(policySets).values({ id: sentinelSetId, orgId, name: "Sentinel Set", kind: "sentinel" });
    await db.insert(policySets).values({ id: opaSetId, orgId, name: "OPA Set", kind: "opa" });
  });

  afterAll(async () => {
    await db.delete(policies).where(eq(policies.orgId, orgId));
    await db.delete(policySets).where(eq(policySets.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("policies list returns all kinds without a filter", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/policies`);
    expect(res.status).toBe(200);
    const kinds = (await res.json()).data.map((p: { attributes: { kind: string } }) => p.attributes.kind).sort();
    expect(kinds).toEqual(["opa", "sentinel"]);
  });

  it("policies list honors filter[kind]", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/policies?filter%5Bkind%5D=opa`);
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.length).toBe(1);
    expect(data[0].attributes.kind).toBe("opa");
  });

  it("policies list honors reference-format-documented search[name]", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/policies?search%5Bname%5D=alpha`);
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.length).toBe(1);
    expect(data[0].attributes.name).toBe("Sentinel Policy Alpha");
  });

  it("policies list still honors the legacy q alias", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/policies?q=beta`);
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.length).toBe(1);
    expect(data[0].attributes.name).toBe("OPA Policy Beta");
  });

  it("policy-sets list returns all kinds without a filter", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/policy-sets`);
    expect(res.status).toBe(200);
    const kinds = (await res.json()).data.map((p: { attributes: { kind: string } }) => p.attributes.kind).sort();
    expect(kinds).toEqual(["opa", "sentinel"]);
  });

  it("policy-sets list honors filter[kind]", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/policy-sets?filter%5Bkind%5D=sentinel`);
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.length).toBe(1);
    expect(data[0].attributes.kind).toBe("sentinel");
  });

  it("policy-sets list honors reference-format-documented search[name]", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/policy-sets?search%5Bname%5D=opa`);
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.length).toBe(1);
    expect(data[0].attributes.name).toBe("OPA Set");
  });

  it("policy-sets list honors free-text q (legacy alias)", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/policy-sets?q=sentinel`);
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.length).toBe(1);
    expect(data[0].attributes.name).toBe("Sentinel Set");
  });

  it("policies list with an unrecognized filter[kind] returns all (no 500, no narrowing)", async () => {
    // The route only applies filter[kind] when the value is "sentinel" or "opa";
    // any other value is a no-op (no condition appended), so all policies are
    // returned rather than an empty set.
    const res = await request(`/api/v2/organizations/${orgName}/policies?filter%5Bkind%5D=invalid`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(2);
  });
});
