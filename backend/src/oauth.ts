import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { apiTokens, user2FA, users } from "./db/schema";
import { createHash } from "node:crypto";
import { browserSessionUser } from "./routes/accounts";

const CLIENT_ID = "terraform-cli";
const MIN_PORT = 10000;
const MAX_PORT = 10010;
const CODE_TTL_MS = 5 * 60 * 1000;
const OAUTH_STATE_COOKIE = "terraform_oauth_state";

type AuthorizationRequest = {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  responseType: string;
  state: string;
};

/**
 * In-memory stores. SINGLE-INSTANCE DEPLOYMENT CONSTRAINT: authorization codes
 * and pending authorization requests are held in-memory with a short TTL.
 * Multi-instance deployments require sticky routing (session affinity) or a
 * shared persistence store so the authorization, complete, and token requests
 * reach the same node instance.
 */
const authorizationCodes = new Map<string, {
  codeChallenge: string;
  expiresAt: number;
  redirectUri: string;
  userId: string;
}>();
const pendingAuthorizations = new Map<string, {
  authorization: AuthorizationRequest;
  expiresAt: number;
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

type RequestInfo = Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>;

type OAuthQueryCtx = Readonly<{
  readonly query: Record<string, unknown>;
  readonly request?: RequestInfo;
}>;

/** Read the opaque OAuth handshake state from the HttpOnly cookie. */
function readOauthStateCookie(request: RequestInfo | undefined): string | undefined {
  const header = request?.headers.get("cookie");
  if (header === null || header === undefined) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === OAUTH_STATE_COOKIE && rest.length > 0) return rest.join("=");
  }
  return undefined;
}

/**
 * Issue a PKCE authorization code for `userId` and redirect Terraform's local
 * callback. Reaps expired entries from both in-memory stores.
 */
function approveForUser(
  authorization: Readonly<AuthorizationRequest>,
  userId: string,
): Response {
  const now = Date.now();
  for (const [code, entry] of authorizationCodes) {
    if (entry.expiresAt <= now) authorizationCodes.delete(code);
  }
  for (const [id, entry] of pendingAuthorizations) {
    if (entry.expiresAt <= now) pendingAuthorizations.delete(id);
  }

  const code = crypto.randomUUID();
  authorizationCodes.set(code, {
    codeChallenge: authorization.codeChallenge,
    expiresAt: now + CODE_TTL_MS,
    redirectUri: authorization.redirectUri,
    userId,
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
}

function oauthError(set: { status?: number | string; headers: Record<string, string | number> }, error: string): { error: string } { // eslint-disable-line @typescript-eslint/prefer-readonly-parameter-types
  set.status = 400;
  set.headers["Cache-Control"] = "no-store";
  set.headers.Pragma = "no-cache";
  return { error };
}

function plainError(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export const oauthPlugin = new Elysia({ name: "terraform-login-oauth" })
  .get("/oauth/authorization", async ({ query, request }: OAuthQueryCtx): Promise<Response> => { // eslint-disable-line @typescript-eslint/prefer-readonly-parameter-types
    const authorization = parseAuthorizationRequest(query);
    if (authorization === null) {
      return plainError("Invalid authorization request.");
    }

    // Already logged into the browser? Skip the login form and approve --
    // unless the account enforces MFA, in which case the user must complete
    // the normal TOTP step first (handled by the SPA login flow).
    const sessionUser = await browserSessionUser(request);
    if (sessionUser !== null) {
      const mfa = await db.query.user2FA.findFirst({
        where: eq(user2FA.userId, sessionUser.id),
      });
      const mfaEnforced = mfa?.enabled === true;
      if (!mfaEnforced) return approveForUser(authorization, sessionUser.id);
    }

    // No usable session: hand off to the SPA login page. Stash the PKCE
    // request under an opaque state id (set as an HttpOnly cookie so the SPA
    // cannot tamper with it) and redirect to /login with that id in the URL
    // so the SPA knows to complete the OAuth handshake after login.
    const now = Date.now();
    for (const [id, entry] of pendingAuthorizations) {
      if (entry.expiresAt <= now) pendingAuthorizations.delete(id);
    }
    const stateId = crypto.randomUUID();
    pendingAuthorizations.set(stateId, { authorization, expiresAt: now + CODE_TTL_MS });

    const cookie = `${OAUTH_STATE_COOKIE}=${stateId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(CODE_TTL_MS / 1000)}`;
    const location = `/login?oauth_state=${encodeURIComponent(stateId)}`;
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": cookie,
        Location: location,
      },
    });
  })
  .get("/oauth/authorization/complete", async ({ query, request }: OAuthQueryCtx): Promise<Response> => { // eslint-disable-line @typescript-eslint/prefer-readonly-parameter-types
    const oauthState = field(query, "oauth_state");
    const cookieState = readOauthStateCookie(request);
    if (oauthState === "" || cookieState === undefined || oauthState !== cookieState) {
      return plainError("OAuth authorization state mismatch. Please run 'terraform login' again.");
    }

    const pending = pendingAuthorizations.get(oauthState);
    if (pending === undefined || pending.expiresAt <= Date.now()) {
      pendingAuthorizations.delete(oauthState);
      return plainError("OAuth authorization expired. Please run 'terraform login' again.");
    }

    const sessionUser = await browserSessionUser(request);
    if (sessionUser === null) {
      // The SPA should have established a session before calling this. Send
      // the user back to login to recover.
      return new Response(null, {
        status: 302,
        headers: { "Cache-Control": "no-store", Location: "/login" },
      });
    }

    // Defensive: an MFA-enforced account must have completed its TOTP step
    // before the browser session was issued; if not, refuse and re-login.
    const mfa = await db.query.user2FA.findFirst({
      where: eq(user2FA.userId, sessionUser.id),
    });
    if (mfa?.enabled === true) {
      return plainError("Multi-factor authentication required. Please run 'terraform login' again.");
    }

    pendingAuthorizations.delete(oauthState);
    return approveForUser(pending.authorization, sessionUser.id);
  })
  .post("/oauth/token", async ({ body, request, set }): Promise<Record<string, string>> => {
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

    set.headers["Cache-Control"] = "no-store";
    set.headers.Pragma = "no-cache";
    return { access_token: accessToken, token_type: "bearer" };
  });
