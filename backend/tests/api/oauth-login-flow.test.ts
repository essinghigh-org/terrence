import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { user2FA } from "../../src/db/schema";
import { generateTotpCode } from "../../src/lib/totp";

type CookieJar = Record<string, string>;

function parseCookies(res: Response): CookieJar {
  const jar: CookieJar = {};
  const setCookie = res.headers.get("Set-Cookie");
  if (setCookie) {
    for (const part of setCookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== undefined && rest.length) jar[name] = rest.join("=");
    }
  }
  return jar;
}

function cookieHeader(jar: CookieJar, names: string[]): string {
  return names.map((n) => `${n}=${jar[n] ?? ""}`).join("; ");
}

async function bootstrapSession(): Promise<{ jar: CookieJar; userId: string; username: string }> {
  const username = `tfuser-${crypto.randomUUID().slice(0, 8)}`;
  const password = "Sup3rS3cret!pass";
  const register = await app.handle(
    new Request("http://localhost/api/v2/users", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: {
          type: "users",
          attributes: { username, password, email: "tfuser@example.test" },
        },
      }),
    }),
  );
  expect(register.status).toBe(201);
  const userId = (await register.json()).data.id as string;

  const login = await app.handle(
    new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { attributes: { username, password, "browser-session": true } },
      }),
    }),
  );
  expect(login.status).toBe(200);
  return { jar: parseCookies(login), userId, username };
}

// A valid PKCE S256 pair: verifier (54 chars) -> challenge (43 chars, base64url(sha256)).
const CODE_VERIFIER = "1yQ_5r6WfSi0vYjM2iB8YJn3k4v5x6z7w8a9b0c1d2e3f4g5h6i7j8";
const CODE_CHALLENGE = "Dp9vmwEa1tgqNwqxEUYnh-u6ZyVojZJx8h9f6xhE18A";

const AUTHZ =
  "/oauth/authorization?response_type=code&client_id=terraform-cli" +
  `&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256` +
  "&redirect_uri=http://localhost:10000/login&state=st-12345";

describe("terraform login.v1 OAuth flow", () => {
  let jar: CookieJar;
  let userId: string;
  let username: string;

  beforeAll(async () => {
    ({ jar, userId, username } = await bootstrapSession());
  }, 30_000);

  test("discovery document advertises login.v1", async () => {
    const res = await app.handle(
      new Request("http://localhost/.well-known/terraform.json"),
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { "login.v1"?: Record<string, unknown> };
    expect(doc["login.v1"]).toBeDefined();
    expect((doc["login.v1"]!).authz).toBe(
      "/oauth/authorization",
    );
    expect((doc["login.v1"]!).token).toBe(
      "/oauth/token",
    );
  });

  test("unauthenticated browser is redirected to the SPA login page", async () => {
    const res = await app.handle(new Request(`http://localhost${AUTHZ}`));
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("/login?oauth_state=");
    // The handshake request is stashed in an HttpOnly cookie.
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie.toLowerCase()).toContain("terraform_oauth_state=");
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  test("completing the handshake with a session issues the code", async () => {
    const redirect = await app.handle(new Request(`http://localhost${AUTHZ}`));
    const location = new URL(redirect.headers.get("Location") ?? "", "http://localhost");
    const oauthState = location.searchParams.get("oauth_state") ?? "";
    expect(oauthState).not.toBe("");
    const cookieHeader = redirect.headers.get("Set-Cookie") ?? "";

    const complete = await app.handle(
      new Request(`http://localhost/oauth/authorization/complete?oauth_state=${oauthState}`, {
        headers: { Cookie: cookieHeader },
      }),
    );
    // No session yet -> bounced back to /login.
    expect(complete.status).toBe(302);
    expect(complete.headers.get("Location")).toBe("/login");

    const completeWithSession = await app.handle(
      new Request(`http://localhost/oauth/authorization/complete?oauth_state=${oauthState}`, {
        headers: { Cookie: `${cookieHeader}; ${Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ")}` },
      }),
    );
    expect(completeWithSession.status).toBe(302);
    const cb = new URL(completeWithSession.headers.get("Location") ?? "");
    expect(cb.host).toBe("localhost:10000");
    expect(cb.pathname).toBe("/login");
    expect(cb.searchParams.get("code")).not.toBeNull();
  });

  test("authenticated browser skips login and is redirected with a code", async () => {
    const res = await app.handle(
      new Request(`http://localhost${AUTHZ}`, {
        headers: { Cookie: cookieHeader(jar, ["terrence_refresh"]) },
      }),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    const url = new URL(location);
    expect(url.host).toBe("localhost:10000");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("state")).toBe("st-12345");
    expect(url.searchParams.get("code")).not.toBeNull();
    expect(url.searchParams.get("code")!.length).toBeGreaterThan(0);
  });

  test("token endpoint exchanges the authorization code for a Terraform token", async () => {
    // Obtain a fresh code via the authenticated redirect.
    const redirect = await app.handle(
      new Request(`http://localhost${AUTHZ}`, {
        headers: { Cookie: cookieHeader(jar, ["terrence_refresh"]) },
      }),
    );
    const code = new URL(redirect.headers.get("Location")!).searchParams.get(
      "code",
    )!;

    const tokenRes = await app.handle(
      new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: CODE_VERIFIER,
          redirect_uri: "http://localhost:10000/login",
          client_id: "terraform-cli",
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const json = (await tokenRes.json()) as {
      access_token?: string;
      token_type?: string;
    };
    expect(json.token_type?.toLowerCase()).toBe("bearer");
    expect(json.access_token).toBeTruthy();
  });

  test("MFA-enabled user with a browser session is NOT auto-approved (redirected to login)", async () => {
    // Enroll + enable MFA for this session's user using the API login token.
    const loginBody = await (
      await app.handle(
        new Request("http://localhost/api/v2/users/login", {
          method: "POST",
          headers: { "Content-Type": "application/vnd.api+json" },
          body: JSON.stringify({
            data: { attributes: { username, password: "Sup3rS3cret!pass" } },
          }),
        }),
      )
    ).json();
    const apiToken = loginBody.data.attributes.token as string;
    const enroll = await app.handle(
      new Request("http://localhost/api/v2/account/mfa/enroll", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}` },
      }),
    );
    expect(enroll.status).toBe(200);
    const secret = (await enroll.json()).data.attributes.secret as string;
    const code = generateTotpCode(secret);
    const verify = await app.handle(
      new Request("http://localhost/api/v2/account/mfa/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({ data: { attributes: { code } } }),
      }),
    );
    expect(verify.status).toBe(200);

    // With a browser session cookie, an MFA-gated account must still be sent
    // through the normal login/MFA flow rather than silently auto-approved.
    const res = await app.handle(
      new Request(`http://localhost${AUTHZ}`, {
        headers: { Cookie: cookieHeader(jar, ["terrence_refresh"]) },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/login?oauth_state=");
  });

  test("MFA-enabled user completes MFA login and receives OAuth authorization code", async () => {
    // 1. Initiate OAuth authorization
    const authRes = await app.handle(new Request(`http://localhost${AUTHZ}`));
    expect(authRes.status).toBe(302);
    const location = new URL(authRes.headers.get("Location") ?? "", "http://localhost");
    const oauthState = location.searchParams.get("oauth_state") ?? "";
    expect(oauthState).not.toBe("");
    const oauthCookies = parseCookies(authRes);

    // 2. Submit primary credentials
    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username, password: "Sup3rS3cret!pass", "browser-session": true } },
        }),
      }),
    );
    expect(loginRes.status).toBe(200);
    const loginJson = (await loginRes.json()) as {
      data: { attributes: { "mfa-required"?: boolean; "mfa-challenge-token"?: string } };
    };
    expect(loginJson.data.attributes["mfa-required"]).toBe(true);
    const challengeToken = loginJson.data.attributes["mfa-challenge-token"];
    expect(challengeToken).toBeDefined();

    // 3. Obtain the TOTP secret and generate code
    const mfaRow = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, userId) });
    expect(mfaRow).toBeDefined();
    const totpCode = generateTotpCode(mfaRow!.secret);

    // 4. Submit MFA challenge
    const mfaRes = await app.handle(
      new Request("http://localhost/api/v2/users/login/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: {
            attributes: {
              "challenge-token": challengeToken,
              code: totpCode,
              "browser-session": true,
            },
          },
        }),
      }),
    );
    expect(mfaRes.status).toBe(200);
    const sessionCookies = parseCookies(mfaRes);

    // 5. Complete OAuth authorization with both oauth_state cookie and session cookie
    const completeRes = await app.handle(
      new Request(`http://localhost/oauth/authorization/complete?oauth_state=${oauthState}`, {
        headers: {
          Cookie: `${cookieHeader(oauthCookies, ["terraform_oauth_state"])}; ${cookieHeader(sessionCookies, ["terrence_refresh"])}`,
        },
      }),
    );
    expect(completeRes.status).toBe(302);
    const callback = new URL(completeRes.headers.get("Location") ?? "");
    expect(callback.host).toBe("localhost:10000");
    expect(callback.pathname).toBe("/login");
    expect(callback.searchParams.get("state")).toBe("st-12345");
    const code = callback.searchParams.get("code");
    expect(code).not.toBeNull();

    // 6. Exchange code for token
    const tokenRes = await app.handle(
      new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          code_verifier: CODE_VERIFIER,
          redirect_uri: "http://localhost:10000/login",
          client_id: "terraform-cli",
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tokenData = (await tokenRes.json()) as { access_token?: string; token_type?: string };
    expect(tokenData.token_type?.toLowerCase()).toBe("bearer");
    expect(tokenData.access_token).toBeTruthy();
  });

  test("MFA-enabled user cannot complete OAuth authorization with an unverified MFA session", async () => {
    // 1. Initiate OAuth authorization
    const authRes = await app.handle(new Request(`http://localhost${AUTHZ}`));
    expect(authRes.status).toBe(302);
    const location = new URL(authRes.headers.get("Location") ?? "", "http://localhost");
    const oauthState = location.searchParams.get("oauth_state") ?? "";
    expect(oauthState).not.toBe("");
    const oauthCookies = parseCookies(authRes);

    // 2. Attempt to complete with the old session (which has mfaVerified: false)
    const completeRes = await app.handle(
      new Request(`http://localhost/oauth/authorization/complete?oauth_state=${oauthState}`, {
        headers: {
          Cookie: `${cookieHeader(oauthCookies, ["terraform_oauth_state"])}; ${cookieHeader(jar, ["terrence_refresh"])}`,
        },
      }),
    );
    expect(completeRes.status).toBe(400);
    const text = await completeRes.text();
    expect(text).toBe("Multi-factor authentication required. Please run 'terraform login' again.");
  });

  test("MFA-enabled user with an MFA-verified browser session skips login and is redirected with a code", async () => {
    // 1. Submit login and MFA to establish an MFA-verified browser session
    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username, password: "Sup3rS3cret!pass", "browser-session": true } },
        }),
      }),
    );
    const challengeToken = ((await loginRes.json()) as { data: { attributes: { "mfa-challenge-token": string } } }).data.attributes["mfa-challenge-token"];
    const mfaRow = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, userId) });
    const totpCode = generateTotpCode(mfaRow!.secret);
    const mfaRes = await app.handle(
      new Request("http://localhost/api/v2/users/login/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: {
            attributes: {
              "challenge-token": challengeToken,
              code: totpCode,
              "browser-session": true,
            },
          },
        }),
      }),
    );
    const mfaSessionCookies = parseCookies(mfaRes);

    // 2. Hit /oauth/authorization with the MFA-verified session cookie
    const res = await app.handle(
      new Request(`http://localhost${AUTHZ}`, {
        headers: { Cookie: cookieHeader(mfaSessionCookies, ["terrence_refresh"]) },
      }),
    );
    expect(res.status).toBe(302);
    const callback = new URL(res.headers.get("Location") ?? "");
    expect(callback.host).toBe("localhost:10000");
    expect(callback.pathname).toBe("/login");
    expect(callback.searchParams.get("state")).toBe("st-12345");
    expect(callback.searchParams.get("code")).not.toBeNull();
  });

  afterAll(() => {
    void userId;
  });
});
