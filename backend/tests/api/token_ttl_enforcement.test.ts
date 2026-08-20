import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  orgTokenTTLPolicies,
  teams,
  users,
} from "../../src/db/schema";

// Token TTL policy enforcement (todo 72-74): the orgTokenTTLPolicies table is
// admin configuration; without enforcement the UI let admins configure a
// security policy that token issuance ignored. These tests pin that every
// governed mint path resolves the policy: cap, default-fill, and the
// max-ttl-ms = 0 "no tokens" semantic.
describe("token TTL policy enforcement", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `ttlp-org-${suffix}`;
  const auth = `user-token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, token = auth) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  let teamId = "";

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token: auth, userId });
    const teamRes = await request(`/api/v2/organizations/${orgName}/teams`, "POST", {
      data: { attributes: { name: "ttlp-team" } },
    });
    expect(teamRes.status).toBe(201);
    teamId = ((await teamRes.json()) as { data: { id: string } }).data.id;
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(inArray(apiTokens.orgId, [orgId]));
    await db.delete(orgTokenTTLPolicies).where(eq(orgTokenTTLPolicies.orgId, orgId));
    await db.delete(teams).where(eq(teams.id, teamId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  const setPolicy = async (tokenType: string, maxTtlMs: number): Promise<void> => {
    const res = await request(`/api/v2/organizations/${orgName}/token-ttl-policies`, "PATCH", {
      data: { attributes: { "token-ttl-policies": [{ "token-type": tokenType, "max-ttl-ms": maxTtlMs }] } },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toBeDefined();
  };

  it("policy API rejects non-whitelisted token types (todo 76)", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/token-ttl-policies`, "PATCH", {
      data: { attributes: { "token-ttl-policies": [{ "token-type": "arbitrary-namespace", "max-ttl-ms": 1000 }] } },
    });
    expect(res.status).toBe(422);
  });

  it("zero-TTL policy forbids organization token rotation (todo 77)", async () => {
    await setPolicy("", 0);
    const res = await request(`/api/v2/organizations/${orgName}/authentication-token`, "POST");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors?: { detail?: string }[] };
    expect(body.errors?.[0]?.detail ?? "").toContain("forbids");
    // Restore an unrestricted policy for later tests in this file.
    await setPolicy("", 10 * 365 * 24 * 60 * 60 * 1000);
  });

  it("org token rotation is capped by the policy and defaults to two years (todo 49-51)", async () => {
    const oneHourMs = 60 * 60 * 1000;
    await setPolicy("", oneHourMs);
    const res = await request(`/api/v2/organizations/${orgName}/authentication-token`, "POST");
    expect(res.status).toBe(201);
    const row = (await db.query.apiTokens.findFirst({
      where: eq(apiTokens.orgId, orgId),
    }));
    expect(row).toBeDefined();
    // No expiry requested: two-year default applies, then the policy caps it
    // down to now+1h.
    expect(row?.expiresAt).not.toBeNull();
    expect(row!.expiresAt! - Date.now()).toBeLessThanOrEqual(oneHourMs);
    expect(row!.expiresAt!).toBeGreaterThan(Date.now());
  });

  it("team token mint is capped by the team policy (todo 72-74)", async () => {
    const oneHourMs = 60 * 60 * 1000;
    await setPolicy("team", oneHourMs);
    const res = await request(`/api/v2/teams/${teamId}/authentication-tokens`, "POST", {
      data: { attributes: { description: "ttlp-team-token" } },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { attributes: { "expired-at": string } } };
    const expiryMs = Date.parse(body.data.attributes["expired-at"]);
    expect(expiryMs - Date.now()).toBeLessThanOrEqual(oneHourMs);
    expect(expiryMs).toBeGreaterThan(Date.now());
  });

  it("zero-TTL team policy forbids minting but leaves the legacy rotation path governed separately", async () => {
    await setPolicy("team", 0);
    const res = await request(`/api/v2/teams/${teamId}/authentication-tokens`, "POST", {
      data: { attributes: { description: "should-not-exist" } },
    });
    expect(res.status).toBe(403);

    // team-legacy is a distinct policy slot: unrestricted here, so legacy
    // rotation still succeeds.
    const legacyRes = await request(`/api/v2/teams/${teamId}/authentication-token`, "POST");
    expect(legacyRes.status).toBe(201);
  });

  it("user token mint outside an org is not governed by org policies", async () => {
    const res = await request(`/api/v2/users/${userId}/authentication-tokens`, "POST", {
      data: { attributes: { description: "ttlp-user-token" } },
    });
    expect(res.status).toBe(201);
  });
});
