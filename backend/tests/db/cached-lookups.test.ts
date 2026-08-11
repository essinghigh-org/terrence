/**
 * cached-lookups.test.ts — per-request memoization of immutable identifier
 * lookups (kanban 10.13).
 *
 * The request-scoped cache (request-scope.ts) lives inside an
 * AsyncLocalStorage store that is (re)initialized by setRequestTokenScopes.
 * These tests use reference identity to prove dedup: two lookups with the
 * same key inside one request must return the SAME row object (one query),
 * and a fresh request scope must NOT reuse the previous request's objects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations } from "../../src/db/schema";
import { cachedOrgById, cachedOrgByName } from "../../src/lib/cached-lookups";
import { setRequestTokenScopes, withRequestScope } from "../../src/lib/request-scope";

const suffix = crypto.randomUUID();
const orgId = `org-cached-lookup-${suffix}`;
const orgName = `cached-lookup-${suffix}`;

describe("cached-lookups (10.13)", () => {
  beforeAll(async () => {
    await db.insert(organizations).values({ id: orgId, name: orgName });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("same-request by-name lookups return the identical row object", async () => {
    setRequestTokenScopes(null); // fresh request-scoped cache
    const first = await cachedOrgByName(orgName);
    const second = await cachedOrgByName(orgName);
    const third = await cachedOrgByName(orgName);
    // reference identity: one query, one memoized promise
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first?.id).toBe(orgId);
  });

  test("same-request by-id lookups return the identical row object", async () => {
    setRequestTokenScopes(null);
    const first = await cachedOrgById(orgId);
    const second = await cachedOrgById(orgId);
    expect(first).toBe(second);
    expect(first?.name).toBe(orgName);
  });

  test("concurrent same-request lookups share one in-flight promise", async () => {
    setRequestTokenScopes(null);
    const [a, b, c] = await Promise.all([
      cachedOrgByName(orgName),
      cachedOrgByName(orgName),
      cachedOrgByName(orgName),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a?.id).toBe(orgId);
  });

  test("unknown names and ids resolve to undefined without poisoning", async () => {
    setRequestTokenScopes(null);
    expect(await cachedOrgByName(`no-such-org-${suffix}`)).toBeUndefined();
    expect(await cachedOrgById(`no-such-id-${suffix}`)).toBeUndefined();
    // the known org still resolves in the same request after a miss
    expect((await cachedOrgByName(orgName))?.id).toBe(orgId);
  });

  test("a fresh request scope never reuses the previous request's objects", async () => {
    const before = await withRequestScope(() => cachedOrgByName(orgName));
    const after = await withRequestScope(() => cachedOrgByName(orgName));
    expect(after).not.toBe(before);
    expect(after?.id).toBe(orgId);
    // distinct keys stay distinct within one request
    const otherId = `org-other-${suffix}`;
    await db.insert(organizations).values({ id: otherId, name: `${orgName}-other` });
    try {
      const [one, two] = await withRequestScope(async () => [
        await cachedOrgByName(orgName),
        await cachedOrgByName(`${orgName}-other`),
      ]);
      expect(one?.id).toBe(orgId);
      expect(two?.id).toBe(otherId);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, otherId));
    }
  });
});
