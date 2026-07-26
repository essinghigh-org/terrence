import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";
import { oauthPlugin } from "../../src/oauth";

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

async function authorize(overrides: Record<string, string> = {}) {
  const body = new URLSearchParams({
    ...await authorizationParameters(),
    username,
    password,
    ...overrides,
  });
  return oauthApp.handle(new Request("http://localhost/oauth/authorization", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }));
}

describe("Terraform login OAuth", () => {
  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      username,
      passwordHash: await bcrypt.hash(password, 10),
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

  it("renders an accessible, escaped login form", async () => {
    const parameters = await authorizationParameters(
      "http://127.0.0.1:10010/login",
      `state"><script>alert(1)</script>`,
    );
    const response = await oauthApp.handle(new Request(
      `http://localhost/oauth/authorization?${new URLSearchParams(parameters)}`,
    ));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<label for="username">Username</label>');
    expect(html).toContain('<label for="password">Password</label>');
    expect(html).not.toContain("<script>alert(1)</script>");
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

    const missingChallengeParams = { ...baseParams };
    delete (missingChallengeParams as any).code_challenge;
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

  it("rejects invalid credentials without redirecting", async () => {
    const response = await authorize({ password: "wrong-password" });
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Invalid username or password.");
  });

  it("authenticates, verifies S256 PKCE, and issues a single-use user token", async () => {
    const authorization = await authorize();
    expect(authorization.status).toBe(302);

    const callback = new URL(authorization.headers.get("location")!);
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
      where: eq(apiTokens.token, token.access_token),
    })).toMatchObject({
      userId,
      description: "Terraform CLI login",
    });

    const replay = await tokenRequest();
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
  });

  it("consumes a code after a failed PKCE verification", async () => {
    const authorization = await authorize();
    const code = new URL(authorization.headers.get("location")!).searchParams.get("code")!;
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
});
