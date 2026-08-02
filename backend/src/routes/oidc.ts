// OpenID Connect relying-party endpoints: SP-initiated redirect (PKCE), the
// callback that exchanges the code and validates the ID token against the
// provider's JWKS, and account provisioning. Configuration lives in the admin
// "oidc" settings group.
import { Elysia } from "elysia";
import { createHash, createHmac, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { getSettings } from "./admin";
import { auditLog } from "../lib/utils";
import {
  provisionSsoUser,
  sanitizeUsername,
  ssoHtmlPage,
  ssoHtmlResponse,
  SsoConflictError,
  validEmail,
} from "../lib/sso";
import { issueSsoLogin } from "./saml";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
type RequestInfo = Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>;

type OidcSettings = Readonly<{
  enabled: boolean;
  issuer: string | null;
  clientId: string | null;
  clientSecret: string | null;
  scopes: string;
  pkceMethod: "S256" | null;
}>;

type OidcDiscovery = Readonly<{
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}>;

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 120;

const discoveryCache = new Map<string, { config: OidcDiscovery; fetchedAt: number }>();
const pendingLogins = new Map<string, { nonce: string; verifier: string | null; expiresAt: number }>();

async function oidcSettings(): Promise<OidcSettings> {
  const raw = await getSettings("oidc");
  const pkce = raw["pkce-method"] === "S256" ? "S256" : null;
  return {
    enabled: raw.enabled === true,
    issuer: typeof raw.issuer === "string" && raw.issuer !== "" ? raw.issuer : null,
    clientId: typeof raw["client-id"] === "string" && raw["client-id"] !== "" ? raw["client-id"] : null,
    clientSecret: typeof raw["client-secret"] === "string" && raw["client-secret"] !== "" ? raw["client-secret"] : null,
    scopes: typeof raw.scopes === "string" && raw.scopes !== "" ? raw.scopes : "openid profile email",
    pkceMethod: pkce,
  };
}

function callbackUrl(request: RequestInfo): string {
  return new URL("/users/oidc/callback", request.url).toString();
}

async function discovery(providerIssuer: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(providerIssuer);
  if (cached !== undefined && cached.fetchedAt + DISCOVERY_TTL_MS > Date.now()) return cached.config;
  const endpoint = `${providerIssuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const response = await fetch(endpoint, { redirect: "follow" });
  if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
  const config = await response.json() as Partial<Record<string, unknown>>;
  const discoveredIssuer = typeof config.issuer === "string" && config.issuer !== "" ? config.issuer : null;
  const authorizationEndpoint = typeof config.authorization_endpoint === "string" && config.authorization_endpoint !== "" ? config.authorization_endpoint : null;
  const tokenEndpoint = typeof config.token_endpoint === "string" && config.token_endpoint !== "" ? config.token_endpoint : null;
  const jwksUri = typeof config.jwks_uri === "string" && config.jwks_uri !== "" ? config.jwks_uri : null;
  if (discoveredIssuer === null || authorizationEndpoint === null || tokenEndpoint === null || jwksUri === null) {
    throw new Error("OIDC discovery document is missing required endpoints");
  }
  const discovered: OidcDiscovery = { issuer: discoveredIssuer, authorizationEndpoint, tokenEndpoint, jwksUri };
  discoveryCache.set(discoveredIssuer, { config: discovered, fetchedAt: Date.now() });
  return discovered;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function parseJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signature: string; signingInput: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("ID token is not a JWT");
  const [headerPart, payloadPart, signature] = parts;
  const header = JSON.parse(base64UrlDecode(headerPart ?? "")) as Record<string, unknown>;
  const payload = JSON.parse(base64UrlDecode(payloadPart ?? "")) as Record<string, unknown>;
  if (typeof header.alg !== "string" || header.alg === "") throw new Error("ID token header has no algorithm");
  return { header, payload, signature: signature ?? "", signingInput: `${headerPart}.${payloadPart}` };
}

function derEncodeEsSignature(signature: Buffer): Buffer {
  const half = signature.length / 2;
  const r = signature.subarray(0, half);
  const s = signature.subarray(half);
  const encodeInt = (value: Buffer): Buffer => {
    let bytes = value;
    while (bytes.length > 0 && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes.length === 0) bytes = Buffer.from([0]);
    if (((bytes[0] ?? 0) & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const rEncoded = encodeInt(r);
  const sEncoded = encodeInt(s);
  return Buffer.concat([Buffer.from([0x30, rEncoded.length + sEncoded.length]), rEncoded, sEncoded]);
}

async function verifyJwtSignature(
  header: Readonly<Record<string, unknown>>,
  signingInput: string,
  signature: string,
  settings: OidcSettings,
): Promise<void> {
  const alg = String(header.alg);
  const signatureBuffer = Buffer.from(signature, "base64url");
  const data = Buffer.from(signingInput, "utf8");

  if (alg.startsWith("HS")) {
    if (settings.clientSecret === null) throw new Error("ID token uses a symmetric algorithm but no client secret is configured");
    const hsHash: Record<string, string> = { HS256: "sha256", HS384: "sha384", HS512: "sha512" };
    const hash = hsHash[alg];
    if (hash === undefined) throw new Error(`Unsupported ID token algorithm: ${alg}`);
    const expected = createHmac(hash, settings.clientSecret).update(data).digest();
    if (expected.length !== signatureBuffer.length) throw new Error("ID token signature is invalid");
    if (!expected.equals(signatureBuffer)) throw new Error("ID token signature is invalid");
    return;
  }

  const hashName: Record<string, string> = {
    RS256: "sha256", RS384: "sha384", RS512: "sha512",
    ES256: "sha256", ES384: "sha384", ES512: "sha512",
  };
  const hash = hashName[alg];
  if (hash === undefined) throw new Error(`Unsupported ID token algorithm: ${alg}`);

  const discoveryConfig = await discovery(String(settings.issuer));
  const jwksResponse = await fetch(discoveryConfig.jwksUri, { redirect: "follow" });
  if (!jwksResponse.ok) throw new Error("Failed to fetch the OIDC provider JWKS");
  const jwks = await jwksResponse.json() as { keys?: Record<string, unknown>[] };
  const keys = jwks.keys ?? [];
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  // Prefer a key whose kty matches the token's algorithm family; JWKs that
  // explicitly declare `use: "sig"` win over encryption-only keys.
  const algFamily = alg.startsWith("ES") ? "EC" : "RSA";
  const key = kid === undefined
    ? keys.find((candidate): boolean =>
        candidate.kty === algFamily && (candidate.use === undefined || candidate.use === "sig"))
      ?? keys.find((candidate): boolean =>
        candidate.kty === "RSA" || candidate.kty === "EC")
    : keys.find((candidate): boolean => candidate.kid === kid);
  if (key === undefined) throw new Error("No matching key found in the OIDC provider JWKS");

  const publicKey = createPublicKey({ key, format: "jwk" });
  const verifiable = alg.startsWith("ES")
    ? derEncodeEsSignature(signatureBuffer)
    : signatureBuffer;
  const valid = verifySignature(hash, data, publicKey, verifiable);
  if (!valid) throw new Error("ID token signature is invalid");
}

function verifyClaims(
  payload: Readonly<Record<string, unknown>>,
  settings: OidcSettings,
  nonce: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now - CLOCK_SKEW_S) throw new Error("ID token has expired");
  if (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_S) throw new Error("ID token was issued in the future");
  if (payload.iss !== settings.issuer) throw new Error("ID token issuer does not match");
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (settings.clientId === null || !audience.includes(settings.clientId)) throw new Error("ID token audience does not match");
  if (typeof payload.nonce !== "string" || payload.nonce !== nonce) throw new Error("ID token nonce does not match");
}

export const oidcRoutes = new Elysia({ name: "oidc-sso" })
  .get("/users/oidc/auth", async ({ request }: { request: RequestInfo }): Promise<unknown> => {
    const settings = await oidcSettings();
    if (!settings.enabled || settings.issuer === null || settings.clientId === null) {
      return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", "OpenID Connect sign-in is not enabled."), 404);
    }
    let config: OidcDiscovery;
    try {
      config = await discovery(settings.issuer);
    } catch (error: unknown) {
      return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", `OIDC discovery failed: ${error instanceof Error ? error.message : "unknown error"}`), 502);
    }

    let verifier: string | null = null;
    let challenge: string | null = null;
    if (settings.pkceMethod === "S256") {
      verifier = base64Url(randomBytes(32).toString("base64")).slice(0, 128);
      challenge = createHash("sha256").update(verifier).digest("base64url");
    }

    const state = base64Url(randomBytes(24).toString("base64"));
    const nonce = base64Url(randomBytes(24).toString("base64"));
    pendingLogins.set(state, { nonce, verifier, expiresAt: Date.now() + PENDING_TTL_MS });
    for (const [key, entry] of pendingLogins) {
      if (entry.expiresAt <= Date.now()) pendingLogins.delete(key);
    }

    const authorize = new URL(config.authorizationEndpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", settings.clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl(request));
    authorize.searchParams.set("scope", settings.scopes);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("nonce", nonce);
    if (settings.pkceMethod === "S256" && verifier !== null && challenge !== null) {
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
    }
    return new Response(null, {
      status: 302,
      headers: { "Cache-Control": "no-store", Location: authorize.toString() },
    });
  })
  .get("/users/oidc/callback", async ({ query, request, set, server }: {
    query: Readonly<Record<string, unknown>>;
    request: RequestInfo;
    set: SetObj;
    server?: unknown;
  }): Promise<unknown> => {
    return handleCallback(query, request, set, server);
  })
  .post("/users/oidc/callback", async ({ body, query, request, set, server }: {
    body: unknown;
    query: Readonly<Record<string, unknown>>;
    request: RequestInfo;
    set: SetObj;
    server?: unknown;
  }): Promise<unknown> => {
    const form = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    return handleCallback({ ...query, ...form }, request, set, server);
  });

async function handleCallback(
  params: Readonly<Record<string, unknown>>,
  request: RequestInfo,
  set: SetObj,
  server: unknown,
): Promise<unknown> {
  const settings = await oidcSettings();
  if (!settings.enabled || settings.issuer === null || settings.clientId === null) {
    (set as { status: number }).status = 404;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", "OpenID Connect sign-in is not enabled."), 404);
  }

  const state = typeof params.state === "string" ? params.state : "";
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (pending === undefined || pending.expiresAt <= Date.now()) {
    (set as { status: number }).status = 400;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", "The sign-in request has expired or is invalid. Please try again."), 400);
  }

  const error = typeof params.error === "string" ? params.error : "";
  if (error !== "") {
    const description = typeof params.error_description === "string" ? params.error_description : error;
    (set as { status: number }).status = 400;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", `The identity provider refused sign-in: ${description.replaceAll("<", "&lt;")}`), 400);
  }

  const code = typeof params.code === "string" ? params.code : "";
  if (code === "") {
    (set as { status: number }).status = 400;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", "The identity provider did not return an authorization code."), 400);
  }

  let config: OidcDiscovery;
  try {
    config = await discovery(settings.issuer);
  } catch (error: unknown) {
    (set as { status: number }).status = 502;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", `OIDC discovery failed: ${error instanceof Error ? error.message : "unknown error"}`), 502);
  }

  // Exchange the authorization code at the token endpoint.
  const tokenBody = new URLSearchParams();
  tokenBody.set("grant_type", "authorization_code");
  tokenBody.set("code", code);
  tokenBody.set("redirect_uri", callbackUrl(request));
  tokenBody.set("client_id", settings.clientId);
  if (pending.verifier !== null) tokenBody.set("code_verifier", pending.verifier);
  const tokenHeaders: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (settings.clientSecret !== null) {
    tokenHeaders.Authorization = `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")}`;
  }
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: tokenHeaders,
      body: tokenBody.toString(),
      redirect: "follow",
    });
  } catch (error: unknown) {
    (set as { status: number }).status = 502;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", `Token exchange failed: ${error instanceof Error ? error.message : "network error"}`), 502);
  }
  const tokenData = await tokenResponse.json().catch((): Record<string, unknown> => ({})) as Record<string, unknown>;
  if (!tokenResponse.ok || typeof tokenData.id_token !== "string") {
    const detail = typeof tokenData.error_description === "string"
      ? tokenData.error_description
      : typeof tokenData.error === "string"
        ? tokenData.error
        : String(tokenResponse.status);
    (set as { status: number }).status = 502;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", `Token exchange failed: ${detail.replaceAll("<", "&lt;")}`), 502);
  }

  // Validate the ID token.
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    const jwt = parseJwt(tokenData.id_token);
    header = jwt.header;
    payload = jwt.payload;
    verifyClaims(payload, settings, pending.nonce);
    await verifyJwtSignature(header, jwt.signingInput, jwt.signature, settings);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "ID token validation failed";
    await auditLog("sso-failure", "oidc", null, null, null, { reason: message });
    (set as { status: number }).status = 400;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", message), 400);
  }

  const subject = typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
  if (subject === null) {
    (set as { status: number }).status = 400;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", "The ID token contains no subject."), 400);
  }
  const email = validEmail(typeof payload.email === "string" ? payload.email : null);
  const username = sanitizeUsername(
    typeof payload.preferred_username === "string" ? payload.preferred_username
      : email !== null ? email.split("@")[0] ?? email
        : `oidc-${subject.slice(0, 24)}`,
  );
  if (username === null) {
    (set as { status: number }).status = 400;
    return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", "The ID token contains no usable username claim."), 400);
  }

  let result: Awaited<ReturnType<typeof provisionSsoUser>>;
  try {
    result = await provisionSsoUser({
      provider: "oidc",
      subject,
      username,
      email,
    });
  } catch (error: unknown) {
    if (error instanceof SsoConflictError) {
      await auditLog("sso-conflict", "oidc", null, null, null, { username: error.username });
      (set as { status: number }).status = 409;
      return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", error.message), 409);
    }
    throw error;
  }
  await auditLog("sso-login", "oidc", result.user.id, result.user.id, null, { username: result.user.username });
  await issueSsoLogin(result.user, { set, request, server }, { wantsToken: false });
  // Attach the browser-session refresh cookie written by issueLoginSession.
  const cookie = (set.headers as Record<string, string | number>)["Set-Cookie"];
  const response = ssoHtmlResponse(ssoHtmlPage("OpenID Connect", "You are signed in.", { redirectUrl: "/app" }));
  if (cookie !== undefined) response.headers.set("Set-Cookie", String(cookie));
  return response;
}
