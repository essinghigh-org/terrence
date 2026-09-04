import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";
import { oauthPlugin, verifyPkceVerifier } from "../../src/oauth";

const userId = crypto.randomUUID();
const username = `oauth-user-${userId}`;
const password = "securepassword";
const verifier = "terraform-login-verifier-0123456789-abcdefghijk";
const oauthApp = new Elysia().use(oauthPlugin);

async function challenge(value = verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

async function authorizationParameters(redirectUri = "http://localhost:10000/login", state = "test-state") {
  return {
    client_id: "terraform-cli",
    code_challenge: await challenge(),
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  };
}

function parseCookie(response: Response, name: string): string | undefined {
  const header = response.headers.get("Set-Cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const [cookieName, ...rest] = part.trim().split("=");
    if (cookieName === name && rest.length > 0) return rest.join("=");
  }
  return undefined;
}

async function browserRefreshCookie(): Promise<string> {
  const login = await app.handle(new Request("http://localhost/api/v2/users/login", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      data: { attributes: { username, password, "browser-session": true } },
    }),
  }));
  expect(login.status).toBe(200);
  const refreshCookie = login.headers.get("Set-Cookie");
  expect(refreshCookie).not.toBeNull();
  return refreshCookie!;
}

/** Drive the full OAuth handshake: GET redirects to /login and stashes state
 *  in an HttpOnly cookie; a browser session (terrence_refresh) then completes
 *  it via /oauth/authorization/complete. */
async function fullHandshake() {
  const params = await authorizationParameters();
  const begin = await oauthApp.handle(new Request(
    `http://localhost/oauth/authorization?${new URLSearchParams(params)}`,
  ));
  expect(begin.status).toBe(302);
  const oauthState = parseCookie(begin, "terraform_oauth_state");
  expect(oauthState).toBeDefined();

  // Establish a browser session the way the SPA login would (no MFA here).
  const refreshCookie = await browserRefreshCookie();
  const cookies = `terraform_oauth_state=${oauthState}; ${refreshCookie}`;

  const complete = await oauthApp.handle(new Request(
    `http://localhost/oauth/authorization/complete?oauth_state=${oauthState}`,
    { headers: { Cookie: cookies } },
  ));
  return { begin, complete, oauthState: oauthState! };
}

describe("Terraform login OAuth", () => {
  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      username,
      passwordHash: await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 }),
    });
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("advertises the Terraform login.v1 protocol", async () => {
    const response = await app.handle(new Request("http://localhost/.well-known/terraform.json"));
    const discovery = await response.json();

    expect(discovery["login.v1"]).toEqual({
      client: "terraform-cli",
      grant_types: ["authz_code"],
      authz: "/oauth/authorization",
      token: "/oauth/token",
      ports: [10000, 10010],
    });
  });

  it("redirects unauthenticated browsers to the SPA login with an opaque state", async () => {
    const parameters = await authorizationParameters(
      "http://127.0.0.1:10010/login",
      `state"><script>alert(1)</script>`,
    );
    const response = await oauthApp.handle(new Request(
      `http://localhost/oauth/authorization?${new URLSearchParams(parameters)}`,
    ));

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/login?oauth_state=");
    // The state id is opaque (a UUID), so the echoed application state is
    // never reflected into the response; an XSS payload in `state` cannot
    // reach the browser through this endpoint.
    expect(location).not.toContain("<script>");
    expect(location).not.toContain("%3Cscript%3E");
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie.toLowerCase()).toContain("terraform_oauth_state=");
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("rejects redirects outside the configured loopback range", async () => {
    for (const redirectUri of [
      "https://example.com/login",
      "http://localhost.evil.example:10000/login",
      "http://localhost:9999/login",
      "http://localhost:10000/other",
    ]) {
      const parameters = await authorizationParameters(redirectUri);
      const response = await oauthApp.handle(new Request(
        `http://localhost/oauth/authorization?${new URLSearchParams(parameters)}`,
      ));
      expect(response.status).toBe(400);
    }
  });

  it("rejects PKCE downgrade attempts (missing code_challenge or method plain)", async () => {
    const baseParams = await authorizationParameters();

    const missingChallengeParams = { ...baseParams } as Record<string, string>;
    delete missingChallengeParams["code_challenge"];
    const missingRes = await oauthApp.handle(new Request(
      `http://localhost/oauth/authorization?${new URLSearchParams(missingChallengeParams)}`,
    ));
    expect(missingRes.status).toBe(400);

    const plainMethodParams = { ...baseParams, code_challenge_method: "plain" };
    const plainRes = await oauthApp.handle(new Request(
      `http://localhost/oauth/authorization?${new URLSearchParams(plainMethodParams)}`,
    ));
    expect(plainRes.status).toBe(400);
  });

  it("rejects a mismatched oauth_state at completion", async () => {
    const params = await authorizationParameters();
    const begin = await oauthApp.handle(new Request(
      `http://localhost/oauth/authorization?${new URLSearchParams(params)}`,
    ));
    const oauthState = parseCookie(begin, "terraform_oauth_state");
    expect(oauthState).toBeDefined();

    // No session cookie at all -> the handshake cannot be verified.
    const noCookie = await oauthApp.handle(new Request(
      `http://localhost/oauth/authorization/complete?oauth_state=${oauthState}`,
    ));
    expect(noCookie.status).toBe(400);

    // Wrong state value -> hard error.
    const wrong = await oauthApp.handle(new Request(
      "http://localhost/oauth/authorization/complete?oauth_state=not-the-right-value",
    ));
    expect(wrong.status).toBe(400);
  });

  it("authenticates via the SPA handoff, verifies S256 PKCE, and issues a single-use user token", async () => {
    const { complete } = await fullHandshake();
    expect(complete.status).toBe(302);

    const callback = new URL(complete.headers.get("Location")!);
    expect(callback.origin + callback.pathname).toBe("http://localhost:10000/login");
    expect(callback.searchParams.get("state")).toBe("test-state");
    const code = callback.searchParams.get("code")!;

    const tokenRequest = () => oauthApp.handle(new Request("http://localhost/oauth/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa("terraform-cli:")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "http://localhost:10000/login",
      }),
    }));

    const tokenResponse = await tokenRequest();
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json();
    expect(token.token_type).toBe("bearer");
    expect(token.access_token).toStartWith("user-");
    expect(await db.query.apiTokens.findFirst({
      where: eq(apiTokens.token, hashAuthenticationToken(token.access_token)),
    })).toMatchObject({
      userId,
      description: "Terraform CLI login",
    });

    const replay = await tokenRequest();
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
  });

  it("does not exchange an authorization code for a blocked account", async () => {
    const { complete } = await fullHandshake();
    const callback = new URL(complete.headers.get("Location")!);
    const code = callback.searchParams.get("code")!;
    const before = await db.query.apiTokens.findMany({ where: eq(apiTokens.userId, userId) });
    await db.update(users).set({ isSuspended: true }).where(eq(users.id, userId));

    try {
      const tokenResponse = await oauthApp.handle(new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${btoa("terraform-cli:")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: "http://localhost:10000/login",
        }),
      }));
      expect(tokenResponse.status).toBe(400);
      expect(await tokenResponse.json()).toEqual({ error: "invalid_grant" });
      expect((await db.query.apiTokens.findMany({ where: eq(apiTokens.userId, userId) })).length).toBe(before.length);
    } finally {
      await db.update(users).set({ isSuspended: false }).where(eq(users.id, userId));
    }
  });

  it("does not auto-approve OAuth from a cross-site browser navigation", async () => {
    const params = await authorizationParameters();
    const refreshCookie = await browserRefreshCookie();

    const response = await oauthApp.handle(new Request(
      `http://localhost/oauth/authorization?${new URLSearchParams(params)}`,
      {
        headers: {
          Cookie: refreshCookie,
          "Sec-Fetch-Site": "cross-site",
        },
      },
    ));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toStartWith("/login?oauth_state=");
  });

  it("does not auto-approve OAuth without browser provenance", async () => {
    const params = await authorizationParameters();
    const refreshCookie = await browserRefreshCookie();
    const response = await oauthApp.handle(new Request(
      `http://localhost/oauth/authorization?${new URLSearchParams(params)}`,
      { headers: { Cookie: refreshCookie } },
    ));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toStartWith("/login?oauth_state=");
  });

  it("consumes a code after a failed PKCE verification", async () => {
    const { complete } = await fullHandshake();
    const code = new URL(complete.headers.get("Location")!).searchParams.get("code")!;
    const exchange = (codeVerifier: string) => oauthApp.handle(new Request("http://localhost/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "terraform-cli",
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: "http://localhost:10000/login",
      }),
    }));

    expect((await exchange("wrong-verifier-that-is-long-enough-012345678901")).status).toBe(400);
    const retry = await exchange(verifier);
    expect(retry.status).toBe(400);
    expect(await retry.json()).toEqual({ error: "invalid_grant" });
  });

  it("uses a constant-time comparison for valid and mismatched PKCE challenges", async () => {
    const expected = await challenge();
    expect(await verifyPkceVerifier(verifier, expected)).toBe(true);
    expect(await verifyPkceVerifier("wrong-verifier-that-is-long-enough-012345678901", expected)).toBe(false);
  });

  it("rejects malformed and out-of-range PKCE verifier boundaries before comparing", async () => {
    const validVerifier = "a".repeat(43);
    const expected = await challenge(validVerifier);

    expect(await verifyPkceVerifier("a".repeat(42), expected)).toBe(false);
    expect(await verifyPkceVerifier(`${"a".repeat(42)}!`, expected)).toBe(false);
    expect(await verifyPkceVerifier("a".repeat(129), expected)).toBe(false);
    expect(await verifyPkceVerifier(validVerifier, "a".repeat(42))).toBe(false);
  });

  it("does not exchange an authorization code for a provisional account", async () => {
    const { complete } = await fullHandshake();
    const callback = new URL(complete.headers.get("Location")!);
    const code = callback.searchParams.get("code")!;
    await db.update(users).set({ isProvisional: true }).where(eq(users.id, userId));

    try {
      const tokenResponse = await oauthApp.handle(new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${btoa("terraform-cli:")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: "http://localhost:10000/login",
        }),
      }));
      expect(tokenResponse.status).toBe(400);
      expect(await tokenResponse.json()).toEqual({ error: "invalid_grant" });
    } finally {
      await db.update(users).set({ isProvisional: false }).where(eq(users.id, userId));
    }
  });
});
