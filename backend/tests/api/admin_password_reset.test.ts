import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, refreshSessions, user2FA, users } from "../../src/db/schema";
import { hashPassword, passwordMatches } from "../../src/lib/password-hashing";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { issueMfaChallenge, consumeMfaChallenge } from "../../src/lib/mfa-challenge";

const suffix = crypto.randomUUID();
const adminId = `reset-admin-${suffix}`;
const memberId = `reset-member-${suffix}`;
const ssoId = `reset-sso-${suffix}`;
const deletedId = `reset-deleted-${suffix}`;
const adminToken = `reset-admin-token-${suffix}`;
const memberToken = `reset-member-token-${suffix}`;
const oldPassword = "Old-Lab-Password-832!";
const newPassword = "Temporary-Lab-Password-946!";
const request = (id: string, token = adminToken, attributes: unknown = { password: newPassword, "password-confirmation": newPassword }) =>
  app.handle(new Request(`http://terrence.test/api/v2/admin/users/${id}/actions/reset_password`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({ data: { type: "users", attributes } }),
  }));

beforeAll(async () => {
  const passwordHash = await hashPassword(oldPassword);
  await db.insert(users).values([
    { id: adminId, username: adminId, passwordHash, isSiteAdmin: true },
    { id: memberId, username: memberId, passwordHash },
    { id: ssoId, username: ssoId, passwordHash: "$disabled$sso", ssoProvider: "oidc", ssoSubject: suffix },
    { id: deletedId, username: deletedId, passwordHash, deletedAt: Date.now() },
  ]);
  await db.insert(apiTokens).values([
    { id: `reset-at-${suffix}`, userId: adminId, token: hashAuthenticationToken(adminToken) },
    { id: `reset-mt-${suffix}`, userId: memberId, token: hashAuthenticationToken(memberToken) },
  ]);
  await db.insert(refreshSessions).values({
    id: `reset-refresh-${suffix}`, familyId: `reset-family-${suffix}`, userId: memberId,
    tokenHash: `reset-refresh-hash-${suffix}`, accessTokenId: `reset-mt-${suffix}`, expiresAt: Date.now() + 60_000,
  });
  await db.insert(user2FA).values({ userId: memberId, secret: "test-only-secret", enabled: true });
});

afterAll(async () => {
  const ids = [adminId, memberId, ssoId, deletedId];
  await db.delete(apiTokens).where(inArray(apiTokens.userId, ids));
  await db.delete(refreshSessions).where(inArray(refreshSessions.userId, ids));
  await db.delete(user2FA).where(inArray(user2FA.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
});

test("password recovery is admin-only and does not convert external identities or reset the current admin", async () => {
  expect((await request(adminId, memberToken)).status).toBe(404);
  expect((await request(memberId, "unknown-token")).status).toBe(404);
  expect((await request(adminId)).status).toBe(422);
  expect((await request(ssoId)).status).toBe(422);
  expect((await request(deletedId)).status).toBe(404);
  expect((await request("missing-user")).status).toBe(404);
});

test("password policy, malformed attributes, and confirmation are checked before modifying access", async () => {
  expect((await request(memberId, adminToken, { password: "short", "password-confirmation": "short" })).status).toBe(422);
  expect((await request(memberId, adminToken, { password: newPassword, "password-confirmation": "different" })).status).toBe(422);
  expect((await request(memberId, adminToken, null)).status).toBe(422);
  const unchanged = await db.query.users.findFirst({ where: eq(users.id, memberId) });
  expect(await passwordMatches(oldPassword, unchanged?.passwordHash)).toBe(true);
  expect((await db.query.apiTokens.findMany({ where: eq(apiTokens.userId, memberId) })).length).toBe(1);
});

test("reset requires a new password, revokes sessions and API tokens, invalidates pending MFA login, and preserves MFA", async () => {
  const challenge = await issueMfaChallenge(memberId);
  const res = await request(memberId);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.attributes["must-change-password"]).toBe(true);
  expect(JSON.stringify(body)).not.toContain(newPassword);
  const updated = await db.query.users.findFirst({ where: eq(users.id, memberId) });
  expect(await passwordMatches(newPassword, updated?.passwordHash)).toBe(true);
  expect(await passwordMatches(oldPassword, updated?.passwordHash)).toBe(false);
  expect(await db.query.apiTokens.findMany({ where: eq(apiTokens.userId, memberId) })).toHaveLength(0);
  expect((await db.query.refreshSessions.findFirst({ where: eq(refreshSessions.userId, memberId) }))?.revokedAt).not.toBeNull();
  expect((await db.query.user2FA.findFirst({ where: eq(user2FA.userId, memberId) }))?.enabled).toBe(true);
  expect(await consumeMfaChallenge(challenge)).toBeNull();
  expect((await request(adminId, memberToken)).status).toBe(404);
});
