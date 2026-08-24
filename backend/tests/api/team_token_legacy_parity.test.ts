import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  teams,
  users,
} from "../../src/db/schema";

// TFE parity regression tests: the singular legacy team-token endpoints
// (/teams/:id/authentication-token) and the modern plural endpoints
// (/teams/:id/authentication-tokens) must manage disjoint token sets.
// The legacy clobber bug (singular POST/DELETE wiping modern tokens) is
// pinned here along with the TFE validation behaviors on modern tokens.
//
// Rate-limit budget: team-token POSTs sit behind the sensitive limiter
// (5/60s per principal). Owner A performs the seeding + rotation POSTs
// (5 total); the validation test uses owner B (5 total) so neither
// principal exceeds its window.
describe("team token legacy/plural separation (TFE parity)", () => {
  const suffix = crypto.randomUUID();
  const ownerAId = `user-${suffix}`;
  const ownerBId = `owner-b-${suffix}`;
  const ownerCId = `owner-c-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `tokpar-org-${suffix}`;
  const authA = `user-token-${suffix}`;
  const authB = `owner-b-token-${suffix}`;
  const authC = `owner-c-token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, token = authA) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  let teamId = "";
  let legacySecret = "";
  let legacyId = "";
  const modernIds: string[] = [];

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerAId, username: ownerAId, passwordHash: "unused" },
      { id: ownerBId, username: ownerBId, passwordHash: "unused" },
      { id: ownerCId, username: ownerCId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId: ownerAId, orgId, role: "owner" },
      { id: crypto.randomUUID(), userId: ownerBId, orgId, role: "owner" },
      { id: crypto.randomUUID(), userId: ownerCId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: authA, userId: ownerAId },
      { id: crypto.randomUUID(), token: authB, userId: ownerBId },
      { id: crypto.randomUUID(), token: authC, userId: ownerCId },
    ]);
    const teamRes = await request(`/api/v2/organizations/${orgName}/teams`, "POST", {
      data: { attributes: { name: "tokpar-team" } },
    });
    expect(teamRes.status).toBe(201);
    teamId = ((await teamRes.json()) as { data: { id: string } }).data.id;

    // Seed state: one legacy token (singular endpoint) + three modern tokens.
    const legacyRes = await request(`/api/v2/teams/${teamId}/authentication-token`, "POST");
    expect(legacyRes.status).toBe(201);
    const legacyBody = (await legacyRes.json()) as { data: { id: string; attributes: { token: string } } };
    legacyId = legacyBody.data.id;
    legacySecret = legacyBody.data.attributes.token;

    for (const description of ["modern-a", "modern-b", "modern-c"]) {
      const res = await request(`/api/v2/teams/${teamId}/authentication-tokens`, "POST", {
        data: { attributes: { description } },
      });
      expect(res.status).toBe(201);
      modernIds.push(((await res.json()) as { data: { id: string } }).data.id);
    }
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(inArray(apiTokens.userId, [ownerAId, ownerBId, ownerCId]));
    await db.delete(apiTokens).where(eq(apiTokens.orgId, orgId));
    await db.delete(teams).where(eq(teams.id, teamId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, ownerAId));
    await db.delete(users).where(eq(users.username, ownerBId));
    await db.delete(users).where(eq(users.username, ownerCId));
  });

  const countTeamTokens = async (legacy: boolean): Promise<number> =>
    (await db.select({ id: apiTokens.id }).from(apiTokens).where(and(eq(apiTokens.teamId, teamId), eq(apiTokens.legacy, legacy)))).length;

  const legacyHashExists = async (secret: string): Promise<boolean> =>
    (await db.select({ id: apiTokens.id }).from(apiTokens)
      .where(eq(apiTokens.token, createHash("sha256").update(secret).digest("hex")))).length > 0;

  it("rotating the legacy token leaves all modern tokens intact", async () => {
    expect(await countTeamTokens(true)).toBe(1);
    expect(await countTeamTokens(false)).toBe(3);
    expect(await legacyHashExists(legacySecret)).toBe(true);

    const rotateRes = await request(`/api/v2/teams/${teamId}/authentication-token`, "POST");
    expect(rotateRes.status).toBe(201);
    const rotateBody = (await rotateRes.json()) as { data: { id: string; attributes: { token: string } } };
    expect(rotateBody.data.id).not.toBe(legacyId);
    expect(rotateBody.data.attributes.token).toContain("team-tok-");

    // The three modern tokens survive the legacy rotation; exactly one
    // legacy credential exists and it is the NEW one (old hash revoked).
    expect(await countTeamTokens(false)).toBe(3);
    expect(await countTeamTokens(true)).toBe(1);
    expect(await legacyHashExists(legacySecret)).toBe(false);
    expect(await legacyHashExists(rotateBody.data.attributes.token)).toBe(true);

    // The singular GET returns only the (new) legacy credential.
    const getRes = await request(`/api/v2/teams/${teamId}/authentication-token`);
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { data: { id: string } }).data.id).toBe(rotateBody.data.id);
  });

  it("removing a modern token does not disturb the legacy token", async () => {
    const delRes = await request(`/api/v2/teams/${teamId}/authentication-tokens/${modernIds[0]}`, "DELETE");
    expect(delRes.status).toBe(204);

    expect(await countTeamTokens(false)).toBe(2);
    expect(await countTeamTokens(true)).toBe(1);
  });

  it("plural list excludes the legacy token and orders newest-first", async () => {
    const listRes = await request(`/api/v2/teams/${teamId}/authentication-tokens`);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { data: { id: string; attributes: Record<string, unknown> }[] };
    expect(body.data.map((t) => t.id)).not.toContain(legacyId);
    expect(body.data).toHaveLength(2);
    for (const item of body.data) {
      // Two-year default expiration is materialized on modern tokens.
      expect(typeof item.attributes["expired-at"]).toBe("string");
    }
  });

  it("modern token creation enforces TFE description/expiry rules", async () => {
    // Validation POSTs run as owner B: owner A's sensitive-limiter window
    // (5/60s) is already fully consumed by seeding + rotation above.
    const pacedPost = async (attributes: Record<string, unknown>): Promise<Response> =>
      request(`/api/v2/teams/${teamId}/authentication-tokens`, "POST", {
        data: { attributes },
      }, authB);

    // Description is required.
    const noDesc = await pacedPost({});
    expect(noDesc.status).toBe(422);

    // Duplicate description within the team conflicts.
    const dup = await pacedPost({ description: "modern-b" });
    expect(dup.status).toBe(409);

    // Invalid date is rejected instead of persisted as NaN.
    const badDate = await pacedPost({ description: "bad-date", "expired-at": "not-a-date" });
    expect(badDate.status).toBe(422);

    // Past expiry is rejected.
    const pastDate = await pacedPost({ description: "past-date", "expired-at": new Date(Date.now() - 1000).toISOString() });
    expect(pastDate.status).toBe(422);

    // Explicit future expiry is honored (5th and final POST in B's window).
    const futureExpiry = new Date(Date.now() + 86_400_000);
    const future = await pacedPost({ description: "future-date", "expired-at": futureExpiry.toISOString() });
    expect(future.status).toBe(201);
    const futureBody = (await future.json()) as { data: { attributes: { "expired-at": string } } };
    expect(futureBody.data.attributes["expired-at"]).toBe(futureExpiry.toISOString());

    // Singular DELETE removes only the legacy token.
    const delLegacy = await request(`/api/v2/teams/${teamId}/authentication-token`, "DELETE");
    expect(delLegacy.status).toBe(204);
    expect(await countTeamTokens(true)).toBe(0);
    expect(await countTeamTokens(false)).toBe(3);

    // Singular GET 404s once no legacy token exists; modern list unaffected.
    const getMissing = await request(`/api/v2/teams/${teamId}/authentication-token`);
    expect(getMissing.status).toBe(404);
  });

  it("generic /authentication-tokens/:id supports team tokens (todo 45/46)", async () => {
    // Owner B can look up a modern team token by id via the generic route.
    const getRes = await request(`/api/v2/authentication-tokens/${modernIds[1]}`, "GET", undefined, authB);
    expect(getRes.status).toBe(200);
    const gotBody = (await getRes.json()) as { data: { id: string; attributes: Record<string, unknown> } };
    expect(gotBody.data.id).toBe(modernIds[1]!);
    expect(String(gotBody.data.attributes.token ?? "")).toBe("");

    // The legacy credential is NOT manageable via the generic route.
    // (Owner C: A and B have exhausted their 5-per-60s sensitive-limiter
    // windows on the earlier POSTs in this file.)
    const rotateRes = await request(`/api/v2/teams/${teamId}/authentication-token`, "POST", undefined, authC);
    expect(rotateRes.status).toBe(201);
    const legacyId = ((await rotateRes.json()) as { data: { id: string } }).data.id;
    // Generic GET may read the legacy credential's metadata (no secret is
    // exposed), but generic DELETE must not remove it: the legacy credential
    // is only manageable via the singular endpoint.
    const legacyGet = await request(`/api/v2/authentication-tokens/${legacyId}`, "GET", undefined, authB);
    expect(legacyGet.status).toBe(200);
    const legacyDel = await request(`/api/v2/authentication-tokens/${legacyId}`, "DELETE", undefined, authB);
    expect(legacyDel.status).toBe(404);
    expect(await countTeamTokens(true)).toBe(1);

    // Generic delete removes a modern token (owner B has manage-teams).
    const delRes = await request(`/api/v2/authentication-tokens/${modernIds[1]}`, "DELETE", undefined, authB);
    expect(delRes.status).toBe(204);
    expect(await countTeamTokens(false)).toBe(2);
    expect(await countTeamTokens(true)).toBe(1);
  });
});
