import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../../src/app";
import { resetOidcCaches } from "../../src/routes/oidc";
import { db } from "../../src/db";
import { adminSettings, apiTokens, users } from "../../src/db/schema";

function base64Url(value: Buffer | string): string {
  return Buffer.isBuffer(value) ? value.toString("base64url") : Buffer.from(value).toString("base64url");
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  dsaEncoding?: "ieee-p1363",
): string {
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput), dsaEncoding === undefined
    ? privateKey
    : { key: privateKey, dsaEncoding });
  return `${signingInput}.${base64Url(signature)}`;
}

describe("OIDC SSO flow", () => {
  const suffix = crypto.randomUUID();
  const adminId = `usr-oidc-admin-${suffix}`;
  const localUserId = `usr-oidc-local-${suffix}`;
  const adminToken = `oidc-admin-token-${suffix}`;

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;

  // EC keypair used to regression-test ES* verification. Options keys with
  // algorithm overrides; the mock IdP signs tokens accordingly.
  const { publicKey: ecPublicKey, privateKey: ecPrivateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecPublicJwk = ecPublicKey.export({ format: "jwk" }) as Record<string, unknown> as Record<string, string>;

  // Signing algorithm the mock IdP uses when issuing the ID token.
  let mockAlg: "RS256" | "HS256" | "HS384" | "HS512" | "ES256" = "RS256";

  // Claim overrides let each test determine who the mock IdP says the user is.
  let mockSubject = `oidc-sub-${suffix}`;
  let mockEmail = `oidc-alice-${suffix}@example.com`;
  let mockUsername = `oidc-alice-${suffix}`;
  let mockNonce: string | null = null;
  const authorizeParams = new Map<string, { nonce: string }>();

  let server: ReturnType<typeof Bun.serve> | undefined;
  const baseUrl = (): string => `http://127.0.0.1:${server?.port ?? 0}`;

  /** Drive one full browser SSO sequence: /oidc/auth -> IdP authorize -> SP callback. */
  async function completeFlow(): Promise<{ response: Response; state: string }> {
    const authResponse = await app.handle(new Request("http://terrence.test/users/oidc/auth"));
    expect(authResponse.status).toBe(302);
    // The auth response sets the state cookie that binds this browser to the
    // flow; the callback must present it (same-origin browser behavior).
    const stateCookie = authResponse.headers.get("Set-Cookie") ?? "";
    const cookie = stateCookie.split(";")[0] ?? "";
    expect(cookie).toContain("terrence_oidc_state=");
    const authorizeUrl = authResponse.headers.get("Location") ?? "";
    const idpResponse = await fetch(authorizeUrl, { redirect: "manual" }); // real HTTP to the mock IdP
    expect(idpResponse.status).toBe(302);
    const callbackUrl = idpResponse.headers.get("Location") ?? "";
    const callback = new URL(callbackUrl);
    const response = await app.handle(new Request(callback.toString(), {
      headers: { Cookie: cookie },
    }));
    return { response, state: callback.searchParams.get("state") ?? "" };
  }

  beforeAll(async () => {
    resetOidcCaches();
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(innerRequest: Request): Promise<Response> {
        const url = new URL(innerRequest.url);
        if (url.pathname === "/.well-known/openid-configuration") {
          return Response.json({
            issuer: baseUrl(),
            authorization_endpoint: `${baseUrl()}/authorize`,
            token_endpoint: `${baseUrl()}/token`,
            jwks_uri: `${baseUrl()}/jwks`,
          });
        }
        if (url.pathname === "/jwks") {
          if (mockAlg === "ES256") {
            // Deliberately no kid: exercises the EC fallback by key type.
            return Response.json({ keys: [{ ...ecPublicJwk, use: "sig", alg: "ES256" }] });
          }
          if (mockAlg.startsWith("HS")) {
            return Response.json({ keys: [] });
          }
          return Response.json({ keys: [{ ...publicJwk, kid: "test-key", use: "sig", alg: "RS256" }] });
        }
        if (url.pathname === "/authorize") {
          const state = url.searchParams.get("state") ?? "";
          authorizeParams.set(state, { nonce: url.searchParams.get("nonce") ?? "" });
          const redirect = new URL(url.searchParams.get("redirect_uri") ?? "http://terrence.test/users/oidc/callback");
          redirect.searchParams.set("code", `test-code-${state}`);
          redirect.searchParams.set("state", state);
          return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
        }
        if (url.pathname === "/token") {
          const form = await innerRequest.formData();
          const codeParam = form.get("code");
          const code = typeof codeParam === "string" ? codeParam : "";
          const state = code.replace("test-code-", "");
          const now = Math.floor(Date.now() / 1000);
          const payload = {
            iss: baseUrl(),
            sub: mockSubject,
            aud: "test-client",
            exp: now + 300,
            iat: now,
            nonce: mockNonce ?? authorizeParams.get(state)?.nonce ?? "",
            email: mockEmail,
            email_verified: true,
            preferred_username: mockUsername,
          };
          let idToken: string;
          if (mockAlg.startsWith("HS")) {
            const header = { alg: mockAlg, typ: "JWT" };
            const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
            const hash = mockAlg === "HS256" ? "sha256" : mockAlg === "HS384" ? "sha384" : "sha512";
            idToken = `${input}.${base64Url(createHmac(hash, "test-secret").update(input).digest())}`;
          } else if (mockAlg === "ES256") {
            idToken = signJwt({ alg: "ES256", typ: "JWT" }, payload, ecPrivateKey, "ieee-p1363");
          } else {
            idToken = signJwt({ alg: "RS256", kid: "test-key", typ: "JWT" }, payload, privateKey);
          }
          return Response.json({ access_token: "mock-access-token", token_type: "Bearer", id_token: idToken });
        }
        return new Response("not found", { status: 404 });
      },
    });

    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: localUserId, username: `local-${suffix}`, email: `local-${suffix}@example.com`, passwordHash: "unused" },
    ]);
    await db.insert(apiTokens).values({
      id: `api-oidc-${suffix}`,
      token: createHash("sha256").update(adminToken).digest("hex"),
      userId: adminId,
    });
    const oidcValues = {
      enabled: true,
      issuer: `http://127.0.0.1:${server.port}`,
      "client-id": "test-client",
      "client-secret": "test-secret",
      scopes: "openid profile email",
      "pkce-method": "S256",
    };
    await db.insert(adminSettings).values({ id: "oidc", values: oidcValues, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: adminSettings.id, set: { values: oidcValues, updatedAt: Date.now() } });
  });

  afterAll(async () => {
    await server?.stop(true);
    // The suite provisions users through the flow (oidc-alice-, hs384-,
    // es256-, etc.) as well as inserting usr-oidc-other- directly; delete
    // every row whose id carries this suite's suffix.
    const provisioned = await db.query.users.findMany({ where: like(users.username, `%-${suffix}`) });
    const ids = [adminId, localUserId, ...provisioned.map((row): string => row.id)];
    await db.delete(adminSettings).where(eq(adminSettings.id, "oidc"));
    await db.delete(apiTokens).where(inArray(apiTokens.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  });

  test("redirects to the provider authorization endpoint with PKCE parameters", async () => {
    const response = await app.handle(new Request("http://terrence.test/users/oidc/auth"));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(`${baseUrl()}/authorize`);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe("test-client");
    expect(location.searchParams.get("scope")).toBe("openid profile email");
    expect(location.searchParams.get("state")).not.toBe("");
    expect(location.searchParams.get("nonce")).not.toBe("");
    expect(location.searchParams.get("code_challenge")).not.toBe("");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("completes the callback, verifies the ID token, and provisions a user", async () => {
    const { response } = await completeFlow();
    expect(response.status).toBe(200);
    expect(response.headers.has("Set-Cookie")).toBe(true);
    expect(await response.text()).toContain("You are signed in");

    const created = await db.query.users.findFirst({ where: eq(users.username, `oidc-alice-${suffix}`) });
    expect(created).not.toBeUndefined();
    expect(created?.ssoProvider).toBe("oidc");
    expect(created?.ssoSubject).toBe(`oidc-sub-${suffix}`);
    expect(created?.email).toBe(`oidc-alice-${suffix}@example.com`);

    const cookie = response.headers.get("Set-Cookie") ?? "";
    const refreshToken = cookie.split(";")[0]?.split("=")[1] ?? "";
    const refreshResponse = await app.handle(new Request("http://terrence.test/api/v2/users/refresh", {
      method: "POST",
      headers: { Cookie: `terrence_refresh=${refreshToken}` },
    }));
    expect(refreshResponse.status).toBe(200);
  });

  test("links an existing local account by matching email", async () => {
    mockSubject = `oidc-sub-link-${suffix}`;
    mockEmail = `local-${suffix}@example.com`;
    mockUsername = `local-${suffix}`;
    const { response } = await completeFlow();
    expect(response.status).toBe(200);
    const linked = await db.query.users.findFirst({ where: eq(users.id, localUserId) });
    expect(linked?.ssoProvider).toBe("oidc");
    expect(linked?.ssoSubject).toBe(`oidc-sub-link-${suffix}`);
  });

  test("blocks provisioning when the username collides with a local account", async () => {
    await db.insert(users).values({
      id: `usr-oidc-other-${suffix}`,
      username: `occupied-${suffix}`,
      email: `occupied-${suffix}@example.com`,
      passwordHash: "unused",
    });
    mockSubject = `oidc-sub-conflict-${suffix}`;
    mockEmail = `different-${suffix}@example.com`;
    mockUsername = `occupied-${suffix}`;
    const { response } = await completeFlow();
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("already in use");
  });

  test("rejects an ID token with a mismatched nonce", async () => {
    mockSubject = `oidc-sub-nonce-${suffix}`;
    mockUsername = `nonce-${suffix}`;
    mockEmail = `nonce-${suffix}@example.com`;
    mockNonce = "attacker-nonce";
    const { response } = await completeFlow();
    mockNonce = null;
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("nonce");
  });

  test("rejects a callback with an unknown state", async () => {
    const response = await app.handle(new Request("http://terrence.test/users/oidc/callback?code=whatever&state=definitely-not-real"));
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/invalid|expired/);
  });

  test("rejects a callback from the provider with an error parameter", async () => {
    const authResponse = await app.handle(new Request("http://terrence.test/users/oidc/auth"));
    const state = new URL(authResponse.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    const stateCookie = (authResponse.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const response = await app.handle(new Request(
      `http://terrence.test/users/oidc/callback?error=access_denied&error_description=User+cancelled&state=${state}`,
      { headers: { Cookie: stateCookie } },
    ));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("refused");
  });

  test("verifies HS384 ID tokens with the matching digest algorithm", async () => {
    resetOidcCaches();
    mockSubject = `oidc-sub-hs384-${suffix}`;
    mockUsername = `hs384-${suffix}`;
    mockEmail = `hs384-${suffix}@example.com`;
    mockAlg = "HS384";
    try {
      const { response } = await completeFlow();
      expect(response.status).toBe(200);
    } finally {
      mockAlg = "RS256";
    }
  });

  test("verifies ES256 ID tokens when the JWKS omits kid", async () => {
    resetOidcCaches();
    mockSubject = `oidc-sub-es256-${suffix}`;
    mockUsername = `es256-${suffix}`;
    mockEmail = `es256-${suffix}@example.com`;
    mockAlg = "ES256";
    try {
      const { response } = await completeFlow();
      expect(response.status).toBe(200);
      const created = await db.query.users.findFirst({ where: eq(users.username, `es256-${suffix}`) });
      expect(created?.ssoProvider).toBe("oidc");
    } finally {
      mockAlg = "RS256";
    }
  });
});