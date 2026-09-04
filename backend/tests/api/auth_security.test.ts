import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import { clearLoginFailures, LOGIN_FAILURE_WINDOW_MS, recordFailedLogin } from "../../src/lib/login-lockout";

const userId = `lockout-user-${crypto.randomUUID()}`;
const username = `lockout-user-${crypto.randomUUID()}`;
const guardedUserId = `lockout-guarded-user-${crypto.randomUUID()}`;
const password = "lockout-password";

function loginRequest(passwordValue: string, ip: string): Request {
  return new Request("http://localhost/api/v2/users/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.api+json",
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify({
      data: { attributes: { username, password: passwordValue } },
    }),
  });
}

beforeAll(async () => {
  const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });
  await db.insert(users).values({
    id: userId,
    username,
    passwordHash,
  });
  await db.insert(users).values({
    id: guardedUserId,
    username: `${username}-guarded`,
    passwordHash,
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, guardedUserId));
});

describe("account login lockout", () => {
  it("does not clear a lock that is set while password validation is in flight", async () => {
    const now = Date.now();
    await db.update(users).set({
      loginFailedAttempts: 5,
      loginFailureWindowStartedAt: now - 1_000,
      loginLockedUntil: now + 60_000,
    }).where(eq(users.id, guardedUserId));

    expect(await clearLoginFailures(guardedUserId, now)).toBe(false);
    const stillLocked = await db.query.users.findFirst({ where: eq(users.id, guardedUserId) });
    expect(stillLocked).toMatchObject({
      loginFailedAttempts: 5,
      loginLockedUntil: now + 60_000,
    });

    await db.update(users).set({ loginLockedUntil: now - 1 }).where(eq(users.id, guardedUserId));
    expect(await clearLoginFailures(guardedUserId, now)).toBe(true);
    const cleared = await db.query.users.findFirst({ where: eq(users.id, guardedUserId) });
    expect(cleared).toMatchObject({
      loginFailedAttempts: 0,
      loginFailureWindowStartedAt: null,
      loginLockedUntil: null,
    });
  });

  it("tracks failures per account across client IPs and blocks the valid password", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.handle(loginRequest("wrong-password", `198.51.100.${String(attempt + 1)}`));
      expect(response.status).toBe(401);
    }

    const locked = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(locked?.loginFailedAttempts).toBe(5);
    expect(locked?.loginFailureWindowStartedAt).toBeGreaterThan(0);
    expect(locked?.loginLockedUntil).toBeGreaterThan(Date.now());

    const blockedValidLogin = await app.handle(loginRequest(password, "203.0.113.99"));
    expect(blockedValidLogin.status).toBe(401);
  });

  it("preserves an active lock when a delayed failure arrives after the failure window", async () => {
    const now = Date.now();
    const lockedUntil = now + 60_000;
    await db.update(users).set({
      loginFailedAttempts: 5,
      loginFailureWindowStartedAt: now - LOGIN_FAILURE_WINDOW_MS - 1,
      loginLockedUntil: lockedUntil,
    }).where(eq(users.id, guardedUserId));

    const result = await recordFailedLogin(guardedUserId, now);
    expect(result.lockedUntil).toBe(lockedUntil);
    const stillLocked = await db.query.users.findFirst({ where: eq(users.id, guardedUserId) });
    expect(stillLocked?.loginLockedUntil).toBe(lockedUntil);
  });
});
