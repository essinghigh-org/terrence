import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, refreshSessions, users } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

describe("browser refresh sessions", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-refresh-${suffix}`;
  const username = `refresh-${suffix}`;
  const otherUserId = `user-refresh-other-${suffix}`;
  const otherUsername = `refresh-other-${suffix}`;
  const password = "correct horse battery staple";

  const request = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> => app.handle(new Request(`http://terrence.test${path}`, {
    method: "POST",
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

  const loginAs = (
    loginUsername: string,
    browserSession: boolean,
    headers: Record<string, string> = {},
  ): Promise<Response> => request("/api/v2/users/login", {
    data: {
      type: "users",
      attributes: {
        username: loginUsername,
        password,
        ...(browserSession ? { "browser-session": true } : {}),
      },
    },
  }, headers);
  const login = (browserSession: boolean): Promise<Response> => loginAs(username, browserSession);

  const cookie = (response: Readonly<Response>): string => {
    const header = response.headers.get("set-cookie");
    if (header === null) throw new Error("Expected refresh cookie");
    return header.split(";", 1)[0] ?? "";
  };

  const rawCookieToken = (value: string): string => value.slice(value.indexOf("=") + 1);

  const accountStatus = (token: string): Promise<Response> => app.handle(new Request(
    "http://terrence.test/api/v2/account/details",
    { headers: { Authorization: `Bearer ${token}` } },
  ));

  const authenticatedRequest = (
    path: string,
    token: string,
    method = "GET",
  ): Promise<Response> => app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  }));

  beforeAll(async () => {
    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
    await db.insert(users).values([
      { id: userId, username, passwordHash },
      { id: otherUserId, username: otherUsername, passwordHash },
    ]);
  });

  afterAll(async () => {
    await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
  });

  test("keeps API login tokens unchanged", async () => {
    const response = await login(false);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const document = await response.json() as {
      data: { id: string; attributes: { token: string; "expired-at"?: string } };
    };
    expect(document.data.attributes["expired-at"]).toBeUndefined();
    const stored = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, document.data.id),
    });
    expect(stored).toMatchObject({
      token: hashAuthenticationToken(document.data.attributes.token),
      expiresAt: null,
    });
    expect(await accountStatus(document.data.attributes.token).then((result): number => result.status)).toBe(200);
  });

  test("rotates once, detects reuse, and revokes the token family", async () => {
    const startedAt = Date.now();
    const loginResponse = await login(true);
    expect(loginResponse.status).toBe(200);
    const loginCookieHeader = loginResponse.headers.get("set-cookie") ?? "";
    expect(loginCookieHeader).toContain("HttpOnly");
    expect(loginCookieHeader).toContain("SameSite=Lax");
    expect(loginCookieHeader).toContain("Path=/");
    const firstCookie = cookie(loginResponse);
    const firstRefreshToken = rawCookieToken(firstCookie);
    const loginDocument = await loginResponse.json() as {
      data: { id: string; attributes: { token: string; "expired-at": string; refreshable: boolean } };
    };
    const firstAccessToken = loginDocument.data.attributes.token;
    const accessExpiry = Date.parse(loginDocument.data.attributes["expired-at"]);
    expect(loginDocument.data.attributes.refreshable).toBeTrue();
    expect(accessExpiry).toBeGreaterThan(startedAt + (14 * 60 * 1000));
    expect(accessExpiry).toBeLessThan(Date.now() + (16 * 60 * 1000));

    const firstSession = await db.query.refreshSessions.findFirst({
      where: eq(
        refreshSessions.tokenHash,
        hashAuthenticationToken(firstRefreshToken),
      ),
    });
    expect(firstSession).toMatchObject({
      userId,
      accessTokenId: loginDocument.data.id,
      rotatedAt: null,
      revokedAt: null,
    });
    expect(firstSession?.tokenHash).not.toBe(firstRefreshToken);
    expect(firstSession?.tokenHash).toHaveLength(64);
    expect(await accountStatus(firstAccessToken).then((result): number => result.status)).toBe(200);

    const refreshResponse = await request("/api/v2/users/refresh", undefined, {
      Cookie: firstCookie,
    });
    expect(refreshResponse.status).toBe(200);
    const secondCookie = cookie(refreshResponse);
    expect(secondCookie).not.toBe(firstCookie);
    const refreshDocument = await refreshResponse.json() as {
      data: { id: string; attributes: { token: string; "expired-at": string } };
    };
    const secondAccessToken = refreshDocument.data.attributes.token;
    expect(secondAccessToken).not.toBe(firstAccessToken);
    expect(await accountStatus(firstAccessToken).then((result): number => result.status)).toBe(401);
    expect(await accountStatus(secondAccessToken).then((result): number => result.status)).toBe(200);

    const familyBeforeReuse = await db.query.refreshSessions.findMany({
      where: eq(refreshSessions.familyId, firstSession?.familyId ?? ""),
    });
    expect(familyBeforeReuse).toHaveLength(2);
    expect(familyBeforeReuse.find((session) => session.id === firstSession?.id)?.rotatedAt).not.toBeNull();
    expect(familyBeforeReuse.find((session) => session.id !== firstSession?.id)?.revokedAt).toBeNull();

    // Immediate reuse of the just-rotated token is the two-tab concurrency
    // case: inside REFRESH_GRACE_MS the second tab gets a grace access token
    // (200) instead of a reuse revocation. See refresh_two_tab_grace.test.ts.
    const graceResponse = await request("/api/v2/users/refresh", undefined, {
      Cookie: firstCookie,
    });
    expect(graceResponse.status).toBe(200);
    expect((await db.query.refreshSessions.findMany({
      where: eq(refreshSessions.familyId, firstSession?.familyId ?? ""),
    })).every((session): boolean => session.revokedAt === null)).toBeTrue();

    // Outside the grace window the same presented token is genuine reuse:
    // family revocation + 401.
    const presentedHash = hashAuthenticationToken(rawCookieToken(firstCookie));
    await db.update(refreshSessions)
      .set({ rotatedAtMs: Date.now() - 10 * 60 * 1000 })
      .where(eq(refreshSessions.tokenHash, presentedHash));
    const reuseResponse = await request("/api/v2/users/refresh", undefined, {
      Cookie: firstCookie,
    });
    expect(reuseResponse.status).toBe(401);
    expect(reuseResponse.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await reuseResponse.json()).toEqual({
      errors: [{
        status: "401",
        title: "Unauthorized",
        detail: "Refresh token reuse detected",
      }],
    });
    expect(await accountStatus(secondAccessToken).then((result): number => result.status)).toBe(401);
    expect((await db.query.refreshSessions.findMany({
      where: eq(refreshSessions.familyId, firstSession?.familyId ?? ""),
    })).every((session): boolean => session.revokedAt !== null)).toBeTrue();
  });

  test("logout clears the cookie and revokes its family", async () => {
    const loginResponse = await login(true);
    const refreshCookie = cookie(loginResponse);
    const session = await db.query.refreshSessions.findFirst({
      where: eq(
        refreshSessions.tokenHash,
        hashAuthenticationToken(rawCookieToken(refreshCookie)),
      ),
    });
    const loginDocument = await loginResponse.json() as {
      data: { attributes: { token: string } };
    };
    const accessToken = loginDocument.data.attributes.token;
    expect(await accountStatus(accessToken).then((result): number => result.status)).toBe(200);

    const logoutResponse = await request("/api/v2/users/logout", undefined, {
      Cookie: refreshCookie,
    });
    expect(logoutResponse.status).toBe(204);
    expect(logoutResponse.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await accountStatus(accessToken).then((result): number => result.status)).toBe(401);
    expect((await db.query.refreshSessions.findMany({
      where: eq(refreshSessions.familyId, session?.familyId ?? ""),
    })).every((row): boolean => row.revokedAt !== null)).toBeTrue();
  });

  test("lists only safe own-session metadata and revokes whole families", async () => {
    type TokenDocument = {
      data: { id: string; attributes: { token: string } };
    };

    const firstLogin = await loginAs(username, true, {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "X-Forwarded-For": "203.0.113.42, 10.0.0.1",
    });
    const firstCookie = cookie(firstLogin);
    const firstDocument = await firstLogin.json() as TokenDocument;
    const secondLogin = await login(true);
    const secondDocument = await secondLogin.json() as TokenDocument;
    const otherLogin = await loginAs(otherUsername, true);
    const otherDocument = await otherLogin.json() as TokenDocument;

    const firstSession = await db.query.refreshSessions.findFirst({
      where: eq(refreshSessions.accessTokenId, firstDocument.data.id),
    });
    const secondSession = await db.query.refreshSessions.findFirst({
      where: eq(refreshSessions.accessTokenId, secondDocument.data.id),
    });
    const otherSession = await db.query.refreshSessions.findFirst({
      where: eq(refreshSessions.accessTokenId, otherDocument.data.id),
    });
    if (firstSession === undefined || secondSession === undefined || otherSession === undefined) {
      throw new Error("Expected browser session families");
    }

    const rotationResponse = await request("/api/v2/users/refresh", undefined, {
      Cookie: firstCookie,
    });
    const rotatedDocument = await rotationResponse.json() as TokenDocument;
    const listResponse = await authenticatedRequest(
      "/api/v2/account/sessions",
      rotatedDocument.data.attributes.token,
    );
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("cache-control")).toBe("no-store");
    const listDocument = await listResponse.json() as {
      data: {
        id: string;
        type: string;
        attributes: Record<string, unknown>;
      }[];
    };
    expect(listDocument.data.map((session): string => session.id).sort()).toEqual(
      [firstSession.familyId, secondSession.familyId].sort(),
    );
    expect(listDocument.data).not.toContainEqual(expect.objectContaining({ id: otherSession.familyId }));
    expect(listDocument.data.find((session): boolean => session.id === firstSession.familyId)).toMatchObject({
      type: "browser-sessions",
      attributes: {
        current: true,
        "created-at": expect.any(String),
        "last-rotated-at": expect.any(String),
        "expires-at": expect.any(String),
        "ip-address": null,
        "user-agent": expect.stringContaining("Chrome/126.0.0.0"),
      },
    });
    expect(listDocument.data.find((session): boolean => session.id === secondSession.familyId)).toMatchObject({
      type: "browser-sessions",
      attributes: {
        current: false,
        "last-rotated-at": null,
        "ip-address": null,
        "user-agent": null,
      },
    });
    for (const session of listDocument.data) {
      expect(Object.keys(session.attributes).sort()).toEqual([
        "created-at",
        "current",
        "expires-at",
        "ip-address",
        "last-rotated-at",
        "user-agent",
      ]);
    }
    const serialized = JSON.stringify(listDocument);
    for (const stored of await db.query.refreshSessions.findMany()) {
      expect(serialized).not.toContain(stored.tokenHash);
      expect(serialized).not.toContain(stored.accessTokenId);
      expect(serialized).not.toContain(stored.id);
    }

    const nullDescriptionTokenId = `null-description-${suffix}`;
    await db.insert(apiTokens).values({
      id: nullDescriptionTokenId,
      token: `unused-${suffix}`,
      userId,
      description: null,
    });
    const personalTokensResponse = await authenticatedRequest(
      `/api/v2/users/${userId}/authentication-tokens`,
      rotatedDocument.data.attributes.token,
    );
    expect(personalTokensResponse.status).toBe(200);
    const personalTokensDocument = await personalTokensResponse.json() as {
      data: { id: string; attributes: { description: string | null } }[];
      meta: { pagination: { "total-count": number } };
    };
    expect(personalTokensDocument.data.map((token): string => token.id)).toContain(nullDescriptionTokenId);
    expect(personalTokensDocument.data.map((token): string => token.id)).not.toContain(secondDocument.data.id);
    expect(personalTokensDocument.data.map((token): string => token.id)).not.toContain(rotatedDocument.data.id);
    expect(personalTokensDocument.data.map((token) => token.attributes.description))
      .not.toContain("Browser session access token");
    expect(personalTokensDocument.meta.pagination["total-count"]).toBe(personalTokensDocument.data.length);

    const crossUserRevoke = await authenticatedRequest(
      `/api/v2/account/sessions/${otherSession.familyId}`,
      rotatedDocument.data.attributes.token,
      "DELETE",
    );
    expect(crossUserRevoke.status).toBe(404);
    expect(await accountStatus(otherDocument.data.attributes.token).then((response): number => response.status)).toBe(200);
    expect((await db.query.refreshSessions.findMany({
      where: eq(refreshSessions.familyId, otherSession.familyId),
    })).every((session): boolean => session.revokedAt === null)).toBeTrue();

    const revokeOtherSession = await authenticatedRequest(
      `/api/v2/account/sessions/${secondSession.familyId}`,
      rotatedDocument.data.attributes.token,
      "DELETE",
    );
    expect(revokeOtherSession.status).toBe(204);
    expect(revokeOtherSession.headers.get("set-cookie")).toBeNull();
    expect(await accountStatus(secondDocument.data.attributes.token).then((response): number => response.status)).toBe(401);
    expect(await accountStatus(rotatedDocument.data.attributes.token).then((response): number => response.status)).toBe(200);
    expect((await db.query.refreshSessions.findMany({
      where: eq(refreshSessions.familyId, secondSession.familyId),
    })).every((session): boolean => session.revokedAt !== null)).toBeTrue();
    expect(await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, secondDocument.data.id),
    })).toBeUndefined();

    const currentFamily = await db.query.refreshSessions.findMany({
      where: eq(refreshSessions.familyId, firstSession.familyId),
    });
    const revokeCurrent = await authenticatedRequest(
      `/api/v2/account/sessions/${firstSession.familyId}`,
      rotatedDocument.data.attributes.token,
      "DELETE",
    );
    expect(revokeCurrent.status).toBe(204);
    expect(revokeCurrent.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await accountStatus(rotatedDocument.data.attributes.token).then((response): number => response.status)).toBe(401);
    expect((await db.query.refreshSessions.findMany({
      where: eq(refreshSessions.familyId, firstSession.familyId),
    })).every((session): boolean => session.revokedAt !== null)).toBeTrue();
    expect(await db.query.apiTokens.findMany({
      where: inArray(apiTokens.id, currentFamily.map((session): string => session.accessTokenId)),
    })).toHaveLength(0);
    expect(await accountStatus(otherDocument.data.attributes.token).then((response): number => response.status)).toBe(200);
  });

  test("concurrent use of one refresh token succeeds for both tabs within the grace window", async () => {
    // Two-tab race: the second request lands inside REFRESH_GRACE_MS and is
    // served a grace access token instead of revoking the family (todo 124).
    const loginResponse = await login(true);
    const refreshCookie = cookie(loginResponse);
    const responses = await Promise.all([
      request("/api/v2/users/refresh", undefined, { Cookie: refreshCookie }),
      request("/api/v2/users/refresh", undefined, { Cookie: refreshCookie }),
    ]);
    expect(responses.map((response): number => response.status).sort()).toEqual([200, 200]);
    for (const response of responses) {
      const document = await response.json() as { data: { attributes: { token: string } } };
      expect(await accountStatus(document.data.attributes.token).then((result): number => result.status)).toBe(200);
    }
    // The family survives the race.
    const presentedHash = hashAuthenticationToken(rawCookieToken(refreshCookie));
    const presented = await db.query.refreshSessions.findFirst({ where: eq(refreshSessions.tokenHash, presentedHash) });
    const family = await db.query.refreshSessions.findMany({
      where: eq(refreshSessions.familyId, presented?.familyId ?? ""),
    });
    expect(family.length).toBeGreaterThanOrEqual(2);
    expect(family.every((session): boolean => session.revokedAt === null)).toBeTrue();
  });

  test("suspending a user invalidates refresh rotation", async () => {
    const loginResponse = await login(true);
    expect(loginResponse.status).toBe(200);
    const refreshCookie = cookie(loginResponse);
    try {
      await db.update(users).set({ isSuspended: true }).where(eq(users.id, userId));
      const response = await request("/api/v2/users/refresh", undefined, { Cookie: refreshCookie });
      expect(response.status).toBe(401);
      expect((await db.query.refreshSessions.findMany({ where: eq(refreshSessions.userId, userId) })).every((row) => row.revokedAt !== null)).toBeTrue();
    } finally {
      await db.update(users).set({ isSuspended: false }).where(eq(users.id, userId));
    }
  });
});
