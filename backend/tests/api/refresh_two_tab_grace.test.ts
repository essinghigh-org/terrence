import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { refreshSessions, users } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

// Two-tab simultaneous refresh (todo 124-127): two tabs presenting the SAME
// old refresh cookie must not trigger family revocation. The second request
// lands inside the concurrency grace window and receives a fresh access
// token for the successor session. Replay outside the window still revokes.
describe("refresh token two-tab concurrency grace", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const password = "grace-password-123";

  const login = (): Promise<Response> =>
    app.handle(new Request("http://terrence.test/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { attributes: { username: userId, password, "browser-session": true } } }),
    }));

  const refresh = (cookie: string): Promise<Response> =>
    app.handle(new Request("http://terrence.test/api/v2/users/refresh", {
      method: "POST",
      headers: { Cookie: cookie },
    }));

  const cookieFrom = (res: Response, name = "terrence_refresh"): string => {
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = new RegExp(`${name}=([^;]*)`).exec(setCookie);
    return match === null ? "" : `${name}=${match[1]}`;
  };

  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      username: userId,
      passwordHash: await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 }),
    });
  });

  afterAll(async () => {
    await db.delete(refreshSessions).where(eq(refreshSessions.userId, userId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("two tabs presenting the same old cookie both succeed; family survives", async () => {
    const loginRes = await login();
    expect(loginRes.status).toBe(200);
    const originalCookie = cookieFrom(loginRes);
    expect(originalCookie).not.toBe("");

    // Both tabs fire concurrently with the SAME old cookie.
    const [tabA, tabB] = await Promise.all([
      refresh(originalCookie),
      refresh(originalCookie),
    ]);
    expect(tabA.status).toBe(200);
    expect(tabB.status).toBe(200);

    const bodyA = (await tabA.json()) as { data: { attributes: Record<string, unknown> } };
    const bodyB = (await tabB.json()) as { data: { attributes: Record<string, unknown> } };
    expect(bodyA.data.attributes.token).toBeTruthy();
    expect(bodyB.data.attributes.token).toBeTruthy();

    // The family survives: exactly two live sessions (successor + grace
    // session reuse does not create a new family), none revoked.
    const sessions = await db.query.refreshSessions.findMany({ where: eq(refreshSessions.userId, userId) });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.every((s) => s.revokedAt === null)).toBe(true);

    // The successor cookie from tab A still refreshes normally afterwards.
    const successorCookie = cookieFrom(tabA);
    if (successorCookie !== "") {
      const later = await refresh(successorCookie);
      expect(later.status).toBe(200);
    }
  });

  it("replay of a rotated token outside the grace window still revokes the family", async () => {
    // Distinct user so the family query below only sees this test's sessions.
    const replayUserId = `user-replay-${suffix}`;
    const replayPassword = "replay-password-123";
    await db.insert(users).values({
      id: replayUserId,
      username: replayUserId,
      passwordHash: await Bun.password.hash(replayPassword, { algorithm: "bcrypt", cost: 4 }),
    });
    const loginRes = await app.handle(new Request("http://terrence.test/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { attributes: { username: replayUserId, password: replayPassword, "browser-session": true } } }),
    }));
    expect(loginRes.status).toBe(200);
    const originalCookie = cookieFrom(loginRes);

    const first = await refresh(originalCookie);
    expect(first.status).toBe(200);

    // Simulate the grace window expiring: backdate rotatedAtMs on the
    // presented (now rotated) session.
    const presentedHash = hashAuthenticationToken(originalCookie.split("=")[1] ?? "");
    await db.update(refreshSessions)
      .set({ rotatedAtMs: Date.now() - 10 * 60 * 1000 })
      .where(eq(refreshSessions.tokenHash, presentedHash));

    const replay = await refresh(originalCookie);
    expect(replay.status).toBe(401);

    // The whole family is revoked.
    const sessions = await db.query.refreshSessions.findMany({ where: eq(refreshSessions.userId, replayUserId) });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    await db.delete(refreshSessions).where(eq(refreshSessions.userId, replayUserId));
    await db.delete(users).where(eq(users.username, replayUserId));
  });
});
