import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, emailVerificationTokens, users } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

const suffix = crypto.randomUUID();
const userId = `email-verify-user-${suffix}`;
const username = `email-verify-${suffix}`;
const email = `${username}@example.com`;
const apiToken = `email-verify-api-${suffix}`;

const request = (path: string, init: RequestInit = {}): Promise<Response> => app.handle(new Request(`http://terrence.test${path}`, init));

beforeAll(async () => {
  await db.insert(users).values({ id: userId, username, email, passwordHash: "unused" });
  await db.insert(apiTokens).values({ id: `email-verify-token-${suffix}`, token: hashAuthenticationToken(apiToken), userId });
});

afterAll(async () => {
  await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

test("requires configured SMTP before issuing an email verification token", async () => {
  const response = await request("/api/v2/account/email/verification", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  expect(response.status).toBe(503);
  const body = await response.json() as { errors: [{ title: string; detail: string }] };
  expect(body.errors[0]).toMatchObject({ title: "Service Unavailable", detail: "Email delivery is not configured" });
});

test("verifies an email token once and rejects replay or changed addresses", async () => {
  const rawToken = `email-verify-${crypto.randomUUID()}`;
  const now = Date.now();
  await db.insert(emailVerificationTokens).values({
    id: `email-verification-${suffix}`,
    userId,
    email,
    tokenHash: hashAuthenticationToken(rawToken),
    expiresAt: now + 60_000,
    createdAt: now,
  });

  const first = await request(`/api/v2/account/email/verify?token=${encodeURIComponent(rawToken)}`);
  expect(first.status).toBe(200);
  expect((await first.json()).data.attributes.verified).toBe(true);
  const verified = await db.query.users.findFirst({ where: eq(users.id, userId) });
  expect(verified?.emailVerifiedAt).toBeTypeOf("number");
  const claimed = await db.query.emailVerificationTokens.findFirst({ where: eq(emailVerificationTokens.userId, userId) });
  expect(claimed?.usedAt).toBeTypeOf("number");

  const replay = await request(`/api/v2/account/email/verify?token=${encodeURIComponent(rawToken)}`);
  expect(replay.status).toBe(404);

  const changedToken = `email-verify-changed-${crypto.randomUUID()}`;
  await db.update(users).set({ email: `changed-${email}`, emailVerifiedAt: null }).where(eq(users.id, userId));
  await db.insert(emailVerificationTokens).values({
    id: `email-verification-changed-${suffix}`,
    userId,
    email,
    tokenHash: hashAuthenticationToken(changedToken),
    expiresAt: now + 60_000,
    createdAt: now,
  });
  const changed = await request(`/api/v2/account/email/verify?token=${encodeURIComponent(changedToken)}`);
  expect(changed.status).toBe(409);
  expect((await changed.json()).errors[0].title).toBe("Conflict");
  await db.update(users).set({ email, emailVerifiedAt: null }).where(eq(users.id, userId));
  await db.delete(emailVerificationTokens).where(and(eq(emailVerificationTokens.userId, userId), eq(emailVerificationTokens.tokenHash, hashAuthenticationToken(changedToken))));
});

test("does not verify an email for a suspended account", async () => {
  const rawToken = `email-verify-suspended-${crypto.randomUUID()}`;
  await db.insert(emailVerificationTokens).values({
    id: `email-verification-suspended-${suffix}`,
    userId,
    email,
    tokenHash: hashAuthenticationToken(rawToken),
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
  });
  await db.update(users).set({ isSuspended: true, emailVerifiedAt: null }).where(eq(users.id, userId));
  try {
    const response = await request(`/api/v2/account/email/verify?token=${encodeURIComponent(rawToken)}`);
    expect(response.status).toBe(403);
  } finally {
    await db.update(users).set({ isSuspended: false }).where(eq(users.id, userId));
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.tokenHash, hashAuthenticationToken(rawToken)));
  }
});
