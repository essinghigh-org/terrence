import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { db } from "./db";
import { apiTokens, users } from "./db/schema";
import { createHash } from "node:crypto";
import { authenticateLdapWithCircuitBreaker } from "./lib/ldap";
import { ldapSettings, provisionSsoUser, ssoSettingsSnapshot, SsoConflictError } from "./lib/sso";

const CLIENT_ID = "terraform-cli";
const MIN_PORT = 10000;
const MAX_PORT = 10010;
const CODE_TTL_MS = 5 * 60 * 1000;

type AuthorizationRequest = {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  responseType: string;
  state: string;
};

/**
 * In-memory authorization code store for OAuth PKCE flow.
 * SINGLE-INSTANCE DEPLOYMENT CONSTRAINT: Authorization codes are held in-memory with a short TTL.
 * Multi-instance deployments require sticky routing (session affinity) or a shared persistence store
 * so /oauth/authorization and /oauth/token requests reach the same node instance.
 */
const authorizationCodes = new Map<string, {
  codeChallenge: string;
  expiresAt: number;
  redirectUri: string;
  userId: string;
}>();

function field(input: unknown, name: string): string {
  const value = (input as Record<string, unknown> | null)?.[name] as string | undefined;
  return typeof value === "string" ? value : "";
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && port >= MIN_PORT
      && port <= MAX_PORT
      && url.pathname === "/login"
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function parseAuthorizationRequest(input: unknown): AuthorizationRequest | null {
  const request = {
    clientId: field(input, "client_id"),
    codeChallenge: field(input, "code_challenge"),
    redirectUri: field(input, "redirect_uri"),
    responseType: field(input, "response_type"),
    state: field(input, "state"),
  };

  if (
    request.clientId !== CLIENT_ID
    || request.responseType !== "code"
    || field(input, "code_challenge_method") !== "S256"
    || !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)
    || request.state === ""
    || !validRedirectUri(request.redirectUri)
  ) {
    return null;
  }

  return request;
}

function escapeHtml(value: string): string {
  const charMap: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character: string): string => charMap[character] ?? character);
}

type SsoInfo = Readonly<{ saml: boolean; oidc: boolean; ldap: boolean; localAuthEnabled: boolean }>;

function loginPage(
  request: Readonly<AuthorizationRequest> | null,
  error = "",
  username = "",
  sso: SsoInfo = { saml: false, oidc: false, ldap: false, localAuthEnabled: true },
): string {
  const hidden = request !== null
    ? ([
        ["client_id", request.clientId],
        ["code_challenge", request.codeChallenge],
        ["code_challenge_method", "S256"],
        ["redirect_uri", request.redirectUri],
        ["response_type", request.responseType],
        ["state", request.state],
      ] as const).map(([name, value]): string =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
      ).join("")
    : "";

  const ssoButtons = request !== null && (sso.saml || sso.oidc)
    ? `<p class="sso">${
        sso.saml ? `<a href="/users/saml/auth?RelayState=api">Sign in with SAML SSO</a>` : ""
      }${
        sso.oidc ? `<a href="/users/oidc/auth">Sign in with OpenID Connect</a>` : ""
      }</p>`
    : "";
  const localBlocked = !sso.localAuthEnabled
    ? `<p id="local-auth-disabled">Local password sign-in is disabled by your administrator. Use single sign-on instead.</p>`
    : "";
  const intro = request !== null
    ? `<p>Sign in to authorize Terraform CLI.</p>${error !== "" ? `<p id="login-error" role="alert">${escapeHtml(error)}</p>` : ""}`
    : "";
  const form = request !== null && sso.localAuthEnabled
    ? `<form method="post" action="/oauth/authorization">
      ${hidden}
      <p>
        <label for="username">Username</label>
        <input id="username" name="username" value="${escapeHtml(username)}" autocomplete="username" required autofocus>
      </p>
      <p>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required${error !== "" ? ' aria-describedby="login-error"' : ""}>
      </p>
      <button type="submit">Sign in</button>
    </form>`
    : request === null
      ? `<p role="alert">Invalid authorization request.</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Terraform Login</title>
  <style>body{font-family:system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem}form p{margin:.6rem 0}label{display:block;font-size:.9rem;margin-bottom:.2rem}input{width:100%;padding:.4rem;box-sizing:border-box}.sso a{display:block;margin:.4rem 0;color:#2563eb}#local-auth-disabled{color:#b91c1c}</style>
</head>
<body>
  <main>
    <h1>Terraform Login</h1>
    ${intro}
    ${localBlocked}
    ${ssoButtons}
    ${form}
  </main>
</body>
</html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

type SetObj = Readonly<{ headers: Readonly<Record<string, string | number>>; status?: number | string }>;

function oauthError(set: SetObj, error: string): { error: string } {
  const mutableSet = set as { status?: number | string; headers: Record<string, string | number> };
  mutableSet.status = 400;
  mutableSet.headers["Cache-Control"] = "no-store";
  mutableSet.headers.Pragma = "no-cache";
  return { error };
}

type RequestWithHeaders = Readonly<{ readonly headers: { readonly get: (name: string) => string | null } }>;

function tokenClientId(body: unknown, request: RequestWithHeaders): string {
  const bodyClientId = field(body, "client_id");
  if (bodyClientId !== "") return bodyClientId;

  const authorization = request.headers.get("authorization");
  if (typeof authorization !== "string" || !authorization.startsWith("Basic ")) return "";

  try {
    return Buffer.from(authorization.slice(6), "base64").toString("utf8") === `${CLIENT_ID}:`
      ? CLIENT_ID
      : "";
  } catch {
    return "";
  }
}

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

type QueryCtx = { readonly query: Readonly<Record<string, unknown>> };
type BodyCtx = { readonly body: unknown };
type TokenCtx = {
  readonly body: unknown;
  readonly request: RequestWithHeaders;
  readonly set: SetObj;
};

export const oauthPlugin = new Elysia({ name: "terraform-login-oauth" })
  .get("/oauth/authorization", async ({ query }: QueryCtx): Promise<Response> => {
    const request = parseAuthorizationRequest(query);
    const sso = await ssoSettingsSnapshot();
    return htmlResponse(loginPage(request, "", "", {
      saml: sso.samlEnabled,
      oidc: sso.oidcEnabled,
      ldap: sso.ldapEnabled,
      localAuthEnabled: sso.localAuthEnabled,
    }), request !== null ? 200 : 400);
  })
  .post("/oauth/authorization", async ({ body }: BodyCtx): Promise<Response> => {
    const authorization = parseAuthorizationRequest(body);
    if (authorization === null) return htmlResponse(loginPage(null), 400);

    const sso = await ssoSettingsSnapshot();
    const username = field(body, "username");
    const password = field(body, "password");
    let user: typeof users.$inferSelect | null = null;
    if (sso.ldapEnabled && username !== "" && password !== "") {
      const ldap = await ldapSettings();
      const authenticated = await authenticateLdapWithCircuitBreaker(ldap, username, password);
      if (authenticated.user !== null) {
        try {
          user = (await provisionSsoUser({
            provider: "ldap",
            subject: authenticated.user.dn,
            username: authenticated.user.username,
            email: authenticated.user.email,
            emailVerified: true,
          })).user;
        } catch (error: unknown) {
          if (error instanceof SsoConflictError) {
            return htmlResponse(loginPage(authorization, "This account cannot be provisioned from the directory.", username, {
              saml: sso.samlEnabled,
              oidc: sso.oidcEnabled,
              ldap: sso.ldapEnabled,
              localAuthEnabled: sso.localAuthEnabled,
            }), 401);
          }
          throw error;
        }
      }
    }

    if (user === null && sso.localAuthEnabled && username !== "") {
      user = await db.query.users.findFirst({ where: eq(users.username, username) }) ?? null;
      if (user !== null && (password === "" || !(await bcrypt.compare(password, user.passwordHash)))) user = null;
    }

    if (user === null) {
      // Preserve the SSO state so a user who mistypes a local password can
      // still reach the identity-provider links without restarting.
      const message = sso.localAuthEnabled || sso.ldapEnabled
        ? "Invalid username or password."
        : "Local password sign-in is disabled. Use single sign-on.";
      return htmlResponse(loginPage(authorization, message, username, {
        saml: sso.samlEnabled,
        oidc: sso.oidcEnabled,
        ldap: sso.ldapEnabled,
        localAuthEnabled: sso.localAuthEnabled,
      }), 401);
    }

    const now = Date.now();
    for (const [code, entry] of authorizationCodes) {
      if (entry.expiresAt <= now) authorizationCodes.delete(code);
    }

    const code = crypto.randomUUID();
    authorizationCodes.set(code, {
      codeChallenge: authorization.codeChallenge,
      expiresAt: now + CODE_TTL_MS,
      redirectUri: authorization.redirectUri,
      userId: user.id,
    });

    const redirect = new URL(authorization.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", authorization.state);
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: redirect.toString(),
      },
    });
  })
  .post("/oauth/token", async ({ body, request, set }: TokenCtx): Promise<Record<string, string>> => {
    if (
      field(body, "grant_type") !== "authorization_code"
      || tokenClientId(body, request) !== CLIENT_ID
    ) {
      return oauthError(set, "invalid_request");
    }

    const code = field(body, "code");
    const entry = authorizationCodes.get(code);
    if (entry === undefined) return oauthError(set, "invalid_grant");
    authorizationCodes.delete(code);

    const verifier = field(body, "code_verifier");
    if (
      entry.expiresAt <= Date.now()
      || field(body, "redirect_uri") !== entry.redirectUri
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
      || await s256(verifier) !== entry.codeChallenge
    ) {
      return oauthError(set, "invalid_grant");
    }

    const user = await db.query.users.findFirst({ where: eq(users.id, entry.userId) });
    if (user === undefined) return oauthError(set, "invalid_grant");


    const accessToken = `user-${crypto.randomUUID()}`;
    const cliTokenTtlMs = Number(process.env.CLI_TOKEN_TTL_MS);


    if (!Number.isFinite(cliTokenTtlMs) || cliTokenTtlMs <= 0) {
      // Fall back to 30-day default when parse produces NaN, infinity, zero, or negative
      const defaultTtl = 30 * 24 * 60 * 60 * 1000;
      await db.insert(apiTokens).values({
        id: crypto.randomUUID(),
        token: createHash("sha256").update(accessToken).digest("hex"),
        userId: user.id,
        description: "Terraform CLI login",
        createdAt: Date.now(),
        expiresAt: Date.now() + defaultTtl,
      });
    } else {
      await db.insert(apiTokens).values({
        id: crypto.randomUUID(),
        token: createHash("sha256").update(accessToken).digest("hex"),
        userId: user.id,
        description: "Terraform CLI login",
        createdAt: Date.now(),
        expiresAt: Date.now() + cliTokenTtlMs,
      });
    }

    const mutableSet = set as { headers: Record<string, string | number> };
    mutableSet.headers["Cache-Control"] = "no-store";
    mutableSet.headers.Pragma = "no-cache";
    return { access_token: accessToken, token_type: "bearer" };
  });
