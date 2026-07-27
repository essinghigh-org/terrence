import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { db } from "./db";
import { apiTokens, users } from "./db/schema";
import { createHash } from "node:crypto";

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

function loginPage(request: Readonly<AuthorizationRequest> | null, error = "", username = ""): string {
  const hidden = request !== null
    ? [
        ["client_id", request.clientId],
        ["code_challenge", request.codeChallenge],
        ["code_challenge_method", "S256"],
        ["redirect_uri", request.redirectUri],
        ["response_type", request.responseType],
        ["state", request.state],
      ].map(([name, value]: readonly [string, string]): string =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
      ).join("")
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Terraform Login</title>
</head>
<body>
  <main>
    <h1>Terraform Login</h1>
    ${request !== null ? `<p>Sign in to authorize Terraform CLI.</p>
    ${error !== "" ? `<p id="login-error" role="alert">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/oauth/authorization">
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
    </form>` : `<p role="alert">Invalid authorization request.</p>`}
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
  mutableSet.headers["Pragma"] = "no-cache";
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
  .get("/oauth/authorization", ({ query }: QueryCtx): Response => {
    const request = parseAuthorizationRequest(query);
    return htmlResponse(loginPage(request), request !== null ? 200 : 400);
  })
  .post("/oauth/authorization", async ({ body }: BodyCtx): Promise<Response> => {
    const authorization = parseAuthorizationRequest(body);
    if (authorization === null) return htmlResponse(loginPage(null), 400);

    const username = field(body, "username");
    const password = field(body, "password");
    const user = username !== ""
      ? await db.query.users.findFirst({ where: eq(users.username, username) })
      : null;

    if (user === null || user === undefined || password === "" || !(await bcrypt.compare(password, user.passwordHash))) {
      return htmlResponse(loginPage(authorization, "Invalid username or password.", username), 401);
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
    mutableSet.headers["Pragma"] = "no-cache";
    return { access_token: accessToken, token_type: "bearer" };
  });
