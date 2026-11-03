import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  policySets,
  policySetStacks,
  policySetTagSelectors,
  stacks,
  users,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

describe("provider stack policy scope persistence", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`,
    orgId = `org-${suffix}`,
    otherOrg = `other-${suffix}`,
    token = `token-${suffix}`;
  const stackId = `st-${suffix}`,
    otherStack = `other-st-${suffix}`;
  const included = `ps-inc-${suffix}`,
    excluded = `ps-exc-${suffix}`,
    sentinel = `ps-sentinel-${suffix}`;
  const request = (path: string, method = "GET", body?: unknown, auth = true) =>
    app.handle(
      new Request(`http://terrence.test${path}`, {
        method,
        headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/vnd.api+json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const scope = (ps: string, exclude = false) =>
    `/api/v2/policy-sets/${ps}/relationships/${exclude ? "stack-exclusions" : "stacks"}`;
  const payload = (...ids: string[]) => ({ data: ids.map((id) => ({ id, type: "stacks" })) });
  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values([
      { id: orgId, name: orgId },
      { id: otherOrg, name: otherOrg },
    ]);
    await db
      .insert(organizationMemberships)
      .values({ id: `mem-${suffix}`, orgId, userId, role: "owner", status: "active" });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, userId, token: hashAuthenticationToken(token) });
    await db.insert(stacks).values([
      { id: stackId, orgId, name: "included" },
      { id: otherStack, orgId: otherOrg, name: "foreign" },
    ]);
    await db.insert(policySets).values([
      { id: included, orgId, name: "included", kind: "tfpolicy" },
      { id: excluded, orgId, name: "excluded", kind: "tfpolicy", global: true },
      { id: sentinel, orgId, name: "sentinel", kind: "sentinel" },
    ]);
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrg));
    await db.delete(users).where(eq(users.id, userId));
  });
  it("persists inclusion and exclusion, is idempotent and reads provider relationship shape", async () => {
    for (const [ps, exclude] of [
      [included, false],
      [excluded, true],
    ] as const) {
      for (let i = 0; i < 2; i++)
        expect((await request(scope(ps, exclude), "POST", payload(stackId))).status).toBe(204);
      const rows = await db.query.policySetStacks.findMany({ where: eq(policySetStacks.policySetId, ps) });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.isExclude).toBe(exclude);
      const res = await request(`/api/v2/policy-sets/${ps}?include=stacks,stack-exclusions`);
      expect(res.status).toBe(200);
      const data = (await res.json()).data;
      expect(data.relationships[exclude ? "stack-exclusions" : "stacks"].data).toEqual([
        { id: stackId, type: "stacks" },
      ]);
      expect(data.relationships[exclude ? "stacks" : "stack-exclusions"].data).toEqual([]);
    }
  });
  it("enforces kind, global scope, foreign/missing stacks and malformed payloads", async () => {
    expect((await request(scope(sentinel), "POST", payload(stackId))).status).toBe(422);
    expect((await request(scope(excluded), "POST", payload(stackId))).status).toBe(422);
    expect((await request(scope(included, true), "POST", payload(stackId))).status).toBe(422);
    expect((await request(scope(included), "POST", payload(stackId, otherStack))).status).toBe(404);
    expect((await request(scope(included), "POST", payload("missing"))).status).toBe(404);
    expect((await request(scope(included), "POST", { data: [{ id: stackId, type: "projects" }] })).status).toBe(422);
    expect((await request(scope(included), "POST", {})).status).toBe(422);
  });
  it("does not let unauthenticated callers mutate links", async () => {
    const response = await request(scope(included), "DELETE", payload(stackId), false);
    expect([401, 404]).toContain(response.status);
    expect(
      await db.query.policySetStacks.findFirst({ where: eq(policySetStacks.policySetId, included) }),
    ).toBeDefined();
  });
  it("lists stack relationships and removes exclusions idempotently", async () => {
    const response = await request(`/api/v2/organizations/${orgId}/policy-sets`);
    expect(response.status).toBe(200);
    const document = await response.json();
    const row = document.data.find((item: { id: string }) => item.id === excluded);
    expect(row.relationships["stack-exclusions"].data).toEqual([{ id: stackId, type: "stacks" }]);
    for (let i = 0; i < 2; i++)
      expect((await request(scope(excluded, true), "DELETE", payload(stackId))).status).toBe(204);
    expect(
      await db.query.policySetStacks.findFirst({ where: eq(policySetStacks.policySetId, excluded) }),
    ).toBeUndefined();
    expect((await request(scope(excluded, true), "POST", payload(stackId))).status).toBe(204);
  });
  it("rejects conflicting legacy scope and atomically rejects mixed-organization batches", async () => {
    await db.update(policySets).set({ global: true }).where(eq(policySets.id, included));
    expect((await request(scope(included, true), "POST", payload(stackId))).status).toBe(422);
    await db.update(policySets).set({ global: false }).where(eq(policySets.id, included));
    expect((await request(scope(included), "DELETE", payload(stackId, otherStack))).status).toBe(404);
    expect(
      await db.query.policySetStacks.findFirst({ where: eq(policySetStacks.policySetId, included) }),
    ).toBeDefined();
    const foreignSet = `foreign-ps-${suffix}`;
    await db.insert(policySets).values({ id: foreignSet, orgId: otherOrg, name: "foreign", kind: "tfpolicy" });
    expect((await request(scope(foreignSet), "POST", payload(otherStack))).status).toBe(404);
  });
  it("rejects incompatible policy-set updates and reverse tag scope changes", async () => {
    for (const [ps, attributes] of [
      [included, { global: true }],
      [excluded, { global: false }],
      [included, { kind: "sentinel" }],
    ] as const) {
      expect(
        (await request(`/api/v2/policy-sets/${ps}`, "PATCH", { data: { type: "policy-sets", attributes } })).status,
      ).toBe(422);
    }
    expect(
      (
        await request(`/api/v2/policy-sets/${included}/tag-selectors`, "POST", {
          data: [{ "tag-key": "env", "tag-value": "prod" }],
        })
      ).status,
    ).toBe(422);
    expect(
      await db.query.policySetTagSelectors.findFirst({ where: eq(policySetTagSelectors.policySetId, included) }),
    ).toBeUndefined();
  });
  it("rejects tag selector scope and permits removal even after a policy kind changes", async () => {
    await db
      .insert(policySetTagSelectors)
      .values({ id: `tag-${suffix}`, policySetId: included, key: "env", value: "prod" });
    expect((await request(scope(included), "POST", payload(stackId))).status).toBe(422);
    await db.update(policySets).set({ kind: "sentinel" }).where(eq(policySets.id, included));
    for (let i = 0; i < 2; i++) expect((await request(scope(included), "DELETE", payload(stackId))).status).toBe(204);
    expect(
      await db.query.policySetStacks.findFirst({ where: eq(policySetStacks.policySetId, included) }),
    ).toBeUndefined();
  });
  it("cascades stack deletion and returns empty relationship arrays", async () => {
    await db.delete(stacks).where(eq(stacks.id, stackId));
    expect(
      await db.query.policySetStacks.findFirst({ where: eq(policySetStacks.policySetId, excluded) }),
    ).toBeUndefined();
    const doc = await (await request(`/api/v2/policy-sets/${excluded}`)).json();
    expect(doc.data.relationships["stack-exclusions"].data).toEqual([]);
  });
});
