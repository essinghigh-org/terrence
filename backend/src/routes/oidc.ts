// OpenID Connect relying-party endpoints: SP-initiated redirect (PKCE), the
// callback that exchanges the code and validates the ID token against the
// provider's JWKS, and account provisioning. Configuration lives in the admin
// "oidc" settings group.
import { Elysia } from "elysia";
import { constants, createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { getSettings } from "../lib/settings";
import { auditLog } from "../lib/utils";
import {
  appendSetCookies,
  provisionSsoUser,
  sanitizeUsername,
  ssoHtmlPage,
  ssoHtmlResponse,
  ssoBaseUrl,
  SsoConflictError,
  validEmail,
} from "../lib/sso";
import { clearSsoChallenges, consumeSsoChallenge, storeSsoChallenge } from "../lib/sso-challenges";
import { issueSsoLogin } from "../lib/sso-login";
import { isUserLoginBlocked } from "./accounts";
import { fetchResolvedExternalUrl, resolveExternalUrl, type ResolvedExternalUrl } from "../lib/url-safety";
import { secureRequest } from "../lib/secure-request";

type HeaderValue = string | number | readonly string[];
type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, HeaderValue>> }>;
type RequestInfo = Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>;

type OidcSettings = Readonly<{
  enabled: boolean;
  allowEmailLinking: boolean;
  issuer: string | null;
  clientId: string | null;
  clientSecret: string | null;
  scopes: string;
  pkceMethod: "S256" | null;
  configuredAlg: string | null;
}>;

type OidcDiscovery = Readonly<{
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  signingAlgorithms?: readonly string[];
  pkceMethods?: readonly string[];
}>;

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 120;
const FETCH_TIMEOUT_MS = 5_000;
const JWKS_TTL_MS = 10 * 60 * 1000;
// Accept only well-known algorithms, each bound to its signing-key family.
// A provider that unexpectedly signs with a different alg is a sign of a
// rolled key set, not something to silently accept.
const ALLOWED_ALGS: ReadonlySet<string> = new Set([
  "HS256", "HS384", "HS512",
  "RS256", "RS384", "RS512",
  "ES256", "ES384", "ES512",
  "PS256", "PS384", "PS512",
]);

const discoveryCache = new Map<string, { config: OidcDiscovery; fetchedAt: number }>();
const discoveryInFlight = new Map<string, Promise<OidcDiscovery>>();
const jwksCache = new Map<string, { keys: Record<string, unknown>[]; fetchedAt: number }>();
const jwksInFlight = new Map<string, Promise<Record<string, unknown>[]>>();
const jwksRefreshes = new Map<string, number>();
const OIDC_STATE_COOKIE = "terrence_oidc_state";
const JWKS_REFRESH_MIN_INTERVAL_MS = 30 * 1000;
const OIDC_CHALLENGE_KIND = "oidc-login";

function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Resolve OIDC network targets once so DNS rebinding cannot change the peer. */
async function resolveOidcEndpoint(value: string): Promise<ResolvedExternalUrl> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OIDC endpoint is invalid");
  }
  // Local HTTP IdPs are supported for development and the loopback test
  // provider. Public/private HTTPS endpoints still require the normal
  // outbound allowlist when their resolved address is private.
  const allowPrivate = parsed.protocol === "http:" && loopbackHost(parsed.hostname);
  const resolved = await resolveExternalUrl(value, allowPrivate);
  if ("error" in resolved) throw new Error(resolved.error);
  return resolved.target;
}

/** Test hook: clear the discovery/JWKS caches between scenarios. */
export async function resetOidcCaches(): Promise<void> {
  discoveryCache.clear();
  discoveryInFlight.clear();
  jwksCache.clear();
  jwksInFlight.clear();
  jwksRefreshes.clear();
  await clearSsoChallenges(OIDC_CHALLENGE_KIND);
}

/** Read a same-site cookie value from a request. */
function cookieValue(request: RequestInfo, name: string): string | undefined {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function stateCookie(request: RequestInfo, state: string, maxAge: number): string {
  const secure = secureRequest(request);
  return `${OIDC_STATE_COOKIE}=${state}; Path=/users/oidc; HttpOnly; ${secure ? "SameSite=None; Secure" : "SameSite=Lax"}; Max-Age=${maxAge}`;
}

function callbackResponse(request: RequestInfo, set: SetObj, body: string, status: number): Response {
  const response = ssoHtmlResponse(body, status);
  appendSetCookies(response, set.headers["Set-Cookie"]);
  response.headers.append("Set-Cookie", stateCookie(request, "", 0));
  return response;
}

async function oidcSettings(): Promise<OidcSettings> {
  const raw = await getSettings("oidc");
  const configuredIssuer = typeof raw.issuer === "string" && raw.issuer !== "" ? raw.issuer : null;
  const clientSecret = typeof raw["client-secret"] === "string" && raw["client-secret"] !== "" ? raw["client-secret"] : null;
  const signingAlg = typeof raw["signing-alg"] === "string" ? raw["signing-alg"].trim() : "";
  const pkce = raw["pkce-method"] === "none" && clientSecret !== null ? null : "S256";
  return {
    enabled: raw.enabled === true,
    allowEmailLinking: raw["link-by-email"] === true,
    issuer: configuredIssuer === null ? null : normalizeIssuer(configuredIssuer),
    clientId: typeof raw["client-id"] === "string" && raw["client-id"] !== "" ? raw["client-id"] : null,
    clientSecret,
    scopes: typeof raw.scopes === "string" && raw.scopes !== "" ? raw.scopes : "openid profile email",
    pkceMethod: pkce,
    configuredAlg: ALLOWED_ALGS.has(signingAlg) ? signingAlg : null,
  };
}

function callbackUrl(request: RequestInfo): string {
  return new URL("/users/oidc/callback", ssoBaseUrl(request)).toString();
}

async function discovery(providerIssuer: string): Promise<OidcDiscovery> {
  const issuer = normalizeIssuer(providerIssuer);
  if (!secureOidcEndpoint(issuer)) throw new Error("OIDC issuer must be an https URL without embedded credentials");
  const cached = discoveryCache.get(issuer);
  if (cached !== undefined && cached.fetchedAt + DISCOVERY_TTL_MS > Date.now()) return cached.config;
  // Concurrent callers share one outbound discovery request; the winner
  // populates the cache and every caller gets the same result.
  const pending = discoveryInFlight.get(issuer);
  if (pending !== undefined) return pending;
  const request = (async (): Promise<OidcDiscovery> => {
    const endpoint = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const response = await fetchResolvedExternalUrl(await resolveOidcEndpoint(endpoint), {
      method: "GET",
      timeoutMs: FETCH_TIMEOUT_MS,
      maxResponseBytes: 1024 * 1024,
    });
    if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
    const config = await response.json() as Partial<Record<string, unknown>>;
    const discoveredIssuer = typeof config.issuer === "string" && config.issuer !== "" ? normalizeIssuer(config.issuer) : null;
    if (discoveredIssuer === null || discoveredIssuer !== issuer) {
      // RFC 8414: the document issuer must equal the configured issuer.
      throw new Error("OIDC discovery issuer does not match the configured issuer");
    }
    const authorizationEndpoint = typeof config.authorization_endpoint === "string" && config.authorization_endpoint !== "" ? config.authorization_endpoint : null;
    const tokenEndpoint = typeof config.token_endpoint === "string" && config.token_endpoint !== "" ? config.token_endpoint : null;
    const jwksUri = typeof config.jwks_uri === "string" && config.jwks_uri !== "" ? config.jwks_uri : null;
    if (authorizationEndpoint === null || tokenEndpoint === null || jwksUri === null
      || !secureOidcEndpoint(authorizationEndpoint, issuer)
      || !secureOidcEndpoint(tokenEndpoint, issuer)
      || !secureOidcEndpoint(jwksUri, issuer)) {
      throw new Error("OIDC discovery document is missing required endpoints");
    }
    const discovered: OidcDiscovery = {
      issuer: discoveredIssuer,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      ...(Array.isArray(config.id_token_signing_alg_values_supported)
        ? { signingAlgorithms: config.id_token_signing_alg_values_supported.filter((value): value is string => typeof value === "string") }
        : {}),
      ...(Array.isArray(config.code_challenge_methods_supported)
        ? { pkceMethods: config.code_challenge_methods_supported.filter((value): value is string => typeof value === "string") }
        : {}),
    };
    discoveryCache.set(issuer, { config: discovered, fetchedAt: Date.now() });
    return discovered;
  })();
  discoveryInFlight.set(issuer, request);
  try {
    return await request;
  } finally {
    if (discoveryInFlight.get(issuer) === request) discoveryInFlight.delete(issuer);
  }
}

function normalizeIssuer(value: string): string {
  // "https://idp.example.com/" and "https://idp.example.com" must compare
  // identically everywhere the issuer appears (config, discovery, iss claim).
  return value.trim().replace(/\/+$/, "");
}

/**
 * Validate an OIDC endpoint URL. With no issuer, https is always acceptable
 * and plain http only for loopback hosts. When an issuer is supplied (the
 * discovery document endpoints), HTTPS endpoints may live on any host — the
 * document is already authenticated by the verified issuer's TLS identity —
 * while plain HTTP stays restricted to loopback issuers and hosts.
 */
function secureOidcEndpoint(value: string, issuer?: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return false;
    if (issuer === undefined) {
      const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      return url.protocol === "https:" || (url.protocol === "http:" && loopbackHost(hostname));
    }
    const issuerUrl = new URL(issuer);
    const issuerHost = issuerUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    // The discovery document comes from the verified issuer over TLS, so
    // endpoints may live on a different host (for example Google publishes
    // its token endpoint and JWKS on separate hosts).
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    // Plain HTTP is only acceptable for loopback issuers (local testing).
    return issuerUrl.protocol === "http:" && loopbackHost(issuerHost) && loopbackHost(hostname);
  } catch {
    return false;
  }
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

async function verifyJwtSignature(
  header: Readonly<Record<string, unknown>>,
  signingInput: string,
  signature: string,
  settings: OidcSettings,
  discoveryConfig: OidcDiscovery,
): Promise<void> {
  const alg = String(header.alg);
  if (!ALLOWED_ALGS.has(alg)) {
    throw new Error("Unsupported ID token algorithm.");
  }
  if (settings.configuredAlg !== null && settings.configuredAlg !== alg) {
    throw new Error("ID token algorithm does not match the configured provider algorithm.");
  }
  if (settings.configuredAlg === null && alg.startsWith("HS")) {
    throw new Error("ID token symmetric algorithms require an explicit configuration.");
  }
  if (discoveryConfig.signingAlgorithms !== undefined && !discoveryConfig.signingAlgorithms.includes(alg)) {
    throw new Error("ID token algorithm is not allowed by the provider configuration.");
  }
  const signatureBuffer = Buffer.from(signature, "base64url");
  const data = Buffer.from(signingInput, "utf8");

  if (alg.startsWith("HS")) {
    if (settings.clientSecret === null) throw new Error("ID token uses a symmetric algorithm but no client secret is configured");
    const hsHash: Record<string, string> = { HS256: "sha256", HS384: "sha384", HS512: "sha512" };
    const hash = hsHash[alg];
    if (hash === undefined) throw new Error(`Unsupported ID token algorithm: ${alg}`);
    const expected = createHmac(hash, settings.clientSecret).update(data).digest();
    if (expected.length !== signatureBuffer.length) throw new Error("ID token signature is invalid");
    if (!timingSafeEqual(expected, signatureBuffer)) throw new Error("ID token signature is invalid");
    return;
  }

  const hashName: Record<string, string> = {
    RS256: "sha256", RS384: "sha384", RS512: "sha512",
    ES256: "sha256", ES384: "sha384", ES512: "sha512",
    PS256: "sha256", PS384: "sha384", PS512: "sha512",
  };
  const hash = hashName[alg];
  if (hash === undefined) throw new Error(`Unsupported ID token algorithm: ${alg}`);

  const keys = await resolveVerificationKey(alg, header, discoveryConfig.jwksUri);
  if (keys.length === 0) throw new Error("No matching key found in the OIDC provider JWKS");
  for (const key of keys) {
    try {
      const publicKey = createPublicKey({ key, format: "jwk" });
      const valid = alg.startsWith("PS")
        ? verifySignature(hash, data, {
          key: publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: Number(alg.slice(2, 5)) / 8,
        }, signatureBuffer)
        : alg.startsWith("ES")
          ? verifySignature(hash, data, { key: publicKey, dsaEncoding: "ieee-p1363" }, signatureBuffer)
          : verifySignature(hash, data, publicKey, signatureBuffer);
      if (valid) return;
    } catch {
      // Try the next compatible rotated key.
    }
  }
  throw new Error("ID token signature is invalid");
}

async function fetchJwks(jwksUri: string, forceRefresh = false): Promise<Record<string, unknown>[]> {
  const cached = jwksCache.get(jwksUri);
  const now = Date.now();
  if (!forceRefresh && cached !== undefined && cached.fetchedAt + JWKS_TTL_MS > now) return cached.keys;
  if (forceRefresh && cached !== undefined && (jwksRefreshes.get(jwksUri) ?? 0) + JWKS_REFRESH_MIN_INTERVAL_MS > now) {
    return cached.keys;
  }
  // Concurrent verifications share one refresh instead of each issuing its
  // own outbound request.
  const pending = jwksInFlight.get(jwksUri);
  if (pending !== undefined) return pending;
  if (forceRefresh) jwksRefreshes.set(jwksUri, now);
  const request = (async (): Promise<Record<string, unknown>[]> => {
    const response = await fetchResolvedExternalUrl(await resolveOidcEndpoint(jwksUri), {
      method: "GET",
      timeoutMs: FETCH_TIMEOUT_MS,
      maxResponseBytes: 1024 * 1024,
    });
    if (!response.ok) throw new Error("Failed to fetch the OIDC provider JWKS");
    const jwks = await response.json() as { keys?: unknown };
    const keys = Array.isArray(jwks.keys) ? jwks.keys.filter((key): key is Record<string, unknown> => (
      typeof key === "object" && key !== null && !Array.isArray(key)
    )) : [];
    if (keys.length === 0) {
      if (cached !== undefined) {
        // An empty JWKS is usually a rotation hiccup: keep serving the last
        // good key set and stop refetching on every call.
        jwksCache.set(jwksUri, { keys: cached.keys, fetchedAt: Date.now() });
        return cached.keys;
      }
      throw new Error("The OIDC provider JWKS contains no keys");
    }
    jwksCache.set(jwksUri, { keys, fetchedAt: Date.now() });
    return keys;
  })();
  jwksInFlight.set(jwksUri, request);
  try {
    return await request;
  } catch (error: unknown) {
    // A routine (non-forced) refresh failure is not fatal while a usable key
    // set is cached; forced refreshes keep rejecting so rotation problems
    // surface to the caller.
    if (cached !== undefined && !forceRefresh) return cached.keys;
    throw error;
  } finally {
    if (jwksInFlight.get(jwksUri) === request) jwksInFlight.delete(jwksUri);
  }
}

async function resolveVerificationKey(
  alg: string,
  header: Readonly<Record<string, unknown>>,
  jwksUri: string,
): Promise<Record<string, unknown>[]> {
  const keys = await fetchJwks(jwksUri);
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const algFamily = alg.startsWith("ES") ? "EC" : "RSA";
  const matches = (candidate: Record<string, unknown>): boolean =>
    candidate.kty === algFamily
    && (candidate.use === undefined || candidate.use === "sig")
    && (candidate.alg === undefined || candidate.alg === alg);
  if (kid === undefined) {
    return keys.filter(matches);
  }
  const matchesWithKid = keys.filter((candidate): boolean => candidate.kid === kid && matches(candidate));
  if (matchesWithKid.length > 0) return matchesWithKid;
  // A missing kid usually means rotation. Refresh once, but cap forced fetches
  // so attacker-controlled unknown kids cannot turn the JWKS endpoint into a
  // request amplifier.
  return (await fetchJwks(jwksUri, true)).filter((candidate): boolean => candidate.kid === kid && matches(candidate));
}

function verifyClaims(
  payload: Readonly<Record<string, unknown>>,
  settings: OidcSettings,
  nonce: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now - CLOCK_SKEW_S) throw new Error("ID token has expired");
  if (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_S) throw new Error("ID token was issued in the future");
  if (typeof payload.iss !== "string" || normalizeIssuer(payload.iss) !== settings.issuer) {
    throw new Error("ID token issuer does not match");
  }
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (settings.clientId === null || !audience.includes(settings.clientId) || audience.some((value): boolean => typeof value !== "string")) {
    throw new Error("ID token audience does not match");
  }
  if (audience.length > 1 && payload.azp !== settings.clientId) throw new Error("ID token authorized party does not match");
  if (payload.azp !== undefined && payload.azp !== settings.clientId) throw new Error("ID token authorized party does not match");
  if (typeof payload.nonce !== "string" || payload.nonce !== nonce) throw new Error("ID token nonce does not match");
}

// app.ts applies the sensitive-path rate limiter to both OIDC endpoints before
// these handlers create or consume authentication challenges.
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
      await auditLog("sso-failure", "oidc", null, null, null, { reason: error instanceof Error ? error.message : "discovery failed" });
      return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", "OIDC discovery failed. Please try again."), 502);
    }
    if (settings.pkceMethod === "S256" && config.pkceMethods !== undefined && !config.pkceMethods.includes("S256")) {
      await auditLog("sso-failure", "oidc", null, null, null, { reason: "OIDC provider does not advertise S256 PKCE" });
      return ssoHtmlResponse(ssoHtmlPage("OpenID Connect", "The OIDC provider does not support the required S256 PKCE method."), 502);
    }

    let verifier: string | null = null;
    let challenge: string | null = null;
    if (settings.pkceMethod === "S256") {
      verifier = randomBytes(32).toString("base64url");
      challenge = createHash("sha256").update(verifier).digest("base64url");
    }

    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    await storeSsoChallenge(OIDC_CHALLENGE_KIND, state, { nonce, verifier }, Date.now() + PENDING_TTL_MS);

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
    // Bind the flow to the browser that started it: the callback will only
    // be honored when the same cookie comes back with the state.
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: authorize.toString(),
        "Set-Cookie": stateCookie(request, state, Math.ceil(PENDING_TTL_MS / 1000)),
      },
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
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "OpenID Connect sign-in is not enabled."), 404);
  }

  const state = typeof params.state === "string" ? params.state : "";
  // The flow started in a specific browser; only accept the callback if the
  // same cookie accompanies it. This prevents an attacker who obtains a
  // valid code+state from delivering it to a victim's browser.
  if (state === "" || cookieValue(request, OIDC_STATE_COOKIE) !== state) {
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "The sign-in request is invalid. Please try again."), 400);
  }
  const pendingPayload = await consumeSsoChallenge(OIDC_CHALLENGE_KIND, state);
  const pending = pendingPayload !== undefined
    && typeof pendingPayload.nonce === "string"
    && (pendingPayload.verifier === null || typeof pendingPayload.verifier === "string")
    ? { nonce: pendingPayload.nonce, verifier: pendingPayload.verifier }
    : undefined;
  if (pending === undefined) {
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "The sign-in request has expired or is invalid. Please try again."), 400);
  }

  const error = typeof params.error === "string" ? params.error : "";
  if (error !== "") {
    const description = typeof params.error_description === "string" ? params.error_description : error;
    await auditLog("sso-failure", "oidc", null, null, null, { reason: error });
    // ssoHtmlPage escapes the message, so no ad-hoc escaping is needed here.
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", `The identity provider refused sign-in: ${description}`), 400);
  }

  const code = typeof params.code === "string" ? params.code : "";
  if (code === "") {
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "The identity provider did not return an authorization code."), 400);
  }

  let config: OidcDiscovery;
  try {
    config = await discovery(settings.issuer);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unknown error";
    await auditLog("sso-failure", "oidc", null, null, null, { reason: detail });
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "OIDC discovery failed. Please try again."), 502);
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
    // RFC 6749 §2.3.1: client_id and client_secret must be form-urlencoded
    // before the Basic credentials are base64-encoded.
    tokenHeaders.Authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`,
    ).toString("base64")}`;
  }
  let tokenResponse: Response;
  try {
    tokenResponse = await fetchResolvedExternalUrl(await resolveOidcEndpoint(config.tokenEndpoint), {
      method: "POST",
      headers: tokenHeaders,
      body: tokenBody.toString(),
      timeoutMs: FETCH_TIMEOUT_MS,
      maxResponseBytes: 1024 * 1024,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "network error";
    await auditLog("sso-failure", "oidc", null, null, null, { reason: detail });
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "Token exchange failed. Please try again."), 502);
  }
  const tokenData = await tokenResponse.json().catch((): Record<string, unknown> => ({})) as Record<string, unknown>;
  if (!tokenResponse.ok || typeof tokenData.id_token !== "string") {
    const detail = typeof tokenData.error_description === "string"
      ? tokenData.error_description
      : typeof tokenData.error === "string"
        ? tokenData.error
        : String(tokenResponse.status);
    await auditLog("sso-failure", "oidc", null, null, null, { reason: detail });
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "Token exchange failed. Please try again."), 502);
  }

  // Validate the ID token.
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    const jwt = parseJwt(tokenData.id_token);
    header = jwt.header;
    payload = jwt.payload;
    await verifyJwtSignature(header, jwt.signingInput, jwt.signature, settings, config);
    verifyClaims(payload, settings, pending.nonce);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "ID token validation failed";
    await auditLog("sso-failure", "oidc", null, null, null, { reason: detail });
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "The identity provider response could not be validated. Please try again."), 400);
  }

  const subject = typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
  if (subject === null) {
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "The ID token contains no subject."), 400);
  }
  const email = validEmail(typeof payload.email === "string" ? payload.email : null);
  const username = sanitizeUsername(
    typeof payload.preferred_username === "string" ? payload.preferred_username
      : email !== null ? email.split("@")[0] ?? email
        : `oidc-${subject.slice(0, 24)}`,
  );
  if (username === null) {
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "The ID token contains no usable username claim."), 400);
  }

  let result: Awaited<ReturnType<typeof provisionSsoUser>>;
  try {
    result = await provisionSsoUser({
      provider: "oidc",
      subject,
      username,
      email,
      // Only link to an existing account when the IdP issued an explicitly
      // verified email claim; otherwise the account is auto-provisioned.
      emailVerified: payload.email_verified === true && typeof payload.email === "string",
      allowEmailLinking: settings.allowEmailLinking,
    });
  } catch (error: unknown) {
    if (error instanceof SsoConflictError) {
      await auditLog("sso-conflict", "oidc", null, null, null, { username: error.username });
      return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", error.message), 409);
    }
    const detail = error instanceof Error ? error.message : "provisioning failed";
    await auditLog("sso-failure", "oidc", null, null, null, { reason: detail });
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "Sign-in could not be completed. Please try again."), 500);
  }
  if (isUserLoginBlocked(result.user)) {
    await auditLog("sso-failure", "oidc", result.user.id, result.user.id, null, { reason: "account is suspended or deleted" });
    return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "This account is not available."), 403);
  }
  await auditLog("sso-login", "oidc", result.user.id, result.user.id, null, { username: result.user.username });
  await issueSsoLogin(result.user, { set, request, server }, { wantsToken: false });
  return callbackResponse(request, set, ssoHtmlPage("OpenID Connect", "You are signed in.", { redirectUrl: "/app" }), 200);
}
