import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { apiTokens, user2FA, users } from "./db/schema";
import { hashAuthenticationToken } from "./lib/token-service";
import { peekOAuthHandshakeState, putOAuthHandshakeState, takeOAuthHandshakeState } from "./lib/oauth-handshake";
import { browserSessionDetails } from "./routes/accounts";

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

// Terraform CLI OAuth state is persisted in the oauth_handshake_states table
// (todo 338-342): pending authorizations and one-time authorization codes are
// stored durably so any replica can serve any step of the handshake. IDs are
// namespaced so the single table serves all three handshake kinds (VCS,
// pending-auth, auth-code). Atomic consume (DELETE ... RETURNING WHERE
// expiresAt > now) gives single-use semantics and eliminates sticky routing.
const PENDING_AUTH_PREFIX = "tf-pending:";
const AUTH_CODE_PREFIX = "tf-code:";

type StoredAuthCode = {
  codeChallenge: string;
  expiresAt: number;
  redirectUri: string;
  userId: string;
};
type StoredPendingAuth = {
  authorization: AuthorizationRequest;
  expiresAt: number;
};

async function putPendingAuth(id: string, value: StoredPendingAuth): Promise<void> {
  await putOAuthHandshakeState(PENDING_AUTH_PREFIX + id, value.expiresAt, value as unknown as Record<string, unknown>);
}
async function takePendingAuth(id: string): Promise<StoredPendingAuth | undefined> {
  return takeOAuthHandshakeState<StoredPendingAuth>(PENDING_AUTH_PREFIX + id);
}
async function peekPendingAuth(id: string): Promise<StoredPendingAuth | undefined> {
  const row = await peekOAuthHandshakeState(PENDING_AUTH_PREFIX + id);
  return row?.payload as StoredPendingAuth | undefined;
}
async function putAuthCode(id: string, value: StoredAuthCode): Promise<void> {
  await putOAuthHandshakeState(AUTH_CODE_PREFIX + id, value.expiresAt, value as unknown as Record<string, unknown>);
}
async function takeAuthCode(id: string): Promise<StoredAuthCode | undefined> {
  return takeOAuthHandshakeState<StoredAuthCode>(AUTH_CODE_PREFIX + id);
}
// Lightweight prune of expired heap entries is now handled by the periodic GC
// on the table; approveForUser still no-ops quickly without a DB round-trip.

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
 * callback.
 */
async function approveForUser(
  authorization: Readonly<AuthorizationRequest>,
  userId: string,
): Promise<Response> {
  const now = Date.now();
  const code = crypto.randomUUID();
  await putAuthCode(code, {
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
      "Set-Cookie": `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
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
    // if the account enforces MFA, the session must have satisfied MFA.
    const details = await browserSessionDetails(request);
    if (details !== null) {
      const mfa = await db.query.user2FA.findFirst({
        where: eq(user2FA.userId, details.user.id),
      });
      const mfaEnforced = mfa?.enabled === true;
      if (!mfaEnforced || details.session.mfaVerified) {
        return await approveForUser(authorization, details.user.id);
      }
    }

    // No usable session: hand off to the SPA login page. Stash the PKCE
    // request under an opaque state id (set as an HttpOnly cookie so the SPA
    // cannot tamper with it) and redirect to /login with that id in the URL
    // so the SPA knows to complete the OAuth handshake after login.
    const stateId = crypto.randomUUID();
    await putPendingAuth(stateId, { authorization, expiresAt: Date.now() + CODE_TTL_MS });

    // Secure flag under HTTPS (todo 135): the state cookie is a bearer
    // capability for the OAuth handshake and must not cross plaintext HTTP.
    // Share the HTTPS policy with accounts.ts / oidc.ts: PUBLIC_URL is
    // authoritative when configured; forwarded headers only matter behind a
    // trusted proxy; otherwise the request's own protocol is used.
    const secure = await (async (): Promise<boolean> => {
      const publicUrl = process.env["PUBLIC_URL"];
      if (typeof publicUrl === "string" && publicUrl !== "") {
        try { const proto = new URL(publicUrl).protocol; if (proto === "https:") return true; if (proto !== "") return false; } catch {}
      }
      const { syncedTrustedClientIp } = await import("./lib/client-ip");
      if (syncedTrustedClientIp(request) !== null) {
        const forwarded = request?.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
        if (forwarded !== undefined && forwarded !== "") return forwarded === "https";
      }
      return request !== undefined && new URL(request.url).protocol === "https:";
    })();
    const cookie = `${OAUTH_STATE_COOKIE}=${stateId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(CODE_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
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

    // Peek without consuming: the unauthenticated probe (no session)
    // should not consume the pending state needed by the subsequent
    // authenticated request. Only consume after a session is confirmed.
    const peekPending = await peekPendingAuth(oauthState);
    if (peekPending === undefined || peekPending.expiresAt <= Date.now()) {
      // Consume if present but expired, so the stale row does not linger.
      const stale = await takePendingAuth(oauthState);
      void stale;
      return plainError("OAuth authorization expired. Please run 'terraform login' again.");
    }

    const details = await browserSessionDetails(request);
    if (details === null) {
      // The SPA should have established a session before calling this. Send
      // the user back to login to recover.
      return new Response(null, {
        status: 302,
        headers: { "Cache-Control": "no-store", Location: "/login" },
      });
    }

    const mfa = await db.query.user2FA.findFirst({
      where: eq(user2FA.userId, details.user.id),
    });
    if (mfa?.enabled === true && !details.session.mfaVerified) {
      return plainError("Multi-factor authentication required. Please run 'terraform login' again.");
    }

    const pending = await takePendingAuth(oauthState);
    if (pending === undefined) {
      return plainError("OAuth authorization expired. Please run 'terraform login' again.");
    }
    return await approveForUser(pending.authorization, details.user.id);
  })
  .post("/oauth/token", async ({ body, request, set }): Promise<Record<string, string>> => {
    if (
      field(body, "grant_type") !== "authorization_code"
      || tokenClientId(body, request) !== CLIENT_ID
    ) {
      return oauthError(set, "invalid_request");
    }

    const code = field(body, "code");
    const entry = await takeAuthCode(code);
    if (entry === undefined) return oauthError(set, "invalid_grant");

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
        token: hashAuthenticationToken(accessToken),
        userId: user.id,
        description: "Terraform CLI login",
        createdAt: Date.now(),
        expiresAt: Date.now() + defaultTtl,
      });
    } else {
      await db.insert(apiTokens).values({
        id: crypto.randomUUID(),
        token: hashAuthenticationToken(accessToken),
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
