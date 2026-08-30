import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit, type Context as RateLimitContext } from "elysia-rate-limit";
import { join } from "path";
import { readFileSync } from "node:fs";
import { envEnabled } from "./lib/env";
import { authPlugin, authenticatedRateLimitKey } from "./auth";
import { distributedFixedWindowContext } from "./lib/distributed-rate-limit";
import { isPostgres } from "./db/driver";
import { trustedClientIpForPeer } from "./lib/client-ip";
import { oauthPlugin } from "./oauth";
import { applyLoggingSettings, log } from "./lib/log";
import { parseTokenScopes, type TokenScopes } from "./lib/token-scopes";
import { strongDocumentEtag } from "./lib/utils";
import { setRequestTokenScopes, setRequestSiteAdmin } from "./lib/request-scope";
import { applySecurityHeaders, HSTS_VALUE, shouldSendHsts, staticCacheControl, staticMimeFor } from "./lib/security-headers";
import openapiJson from "../openapi.json" with { type: "json" };
import { requestFinished, requestStarted } from "./lib/process-metrics";
import { API_BODY_LIMIT_BYTES, BodyTooLargeError, readTextWithLimit } from "./lib/body-limit";
// 464: per-endpoint security/rate/body/audit classifications live in endpoint-policy.ts; app.ts reuses that single registry.
import {
  isUploadPath,
  scimMappingPath,
  scimSettingsPath,
  sensitivePath,
  sensitiveSsoPath,
  serverEndpointPath,
  workspaceRunHistoryPath,
} from "./lib/endpoint-policy";

const FRONTEND_INDEX = join(import.meta.dir, "../../frontend/dist/index.html");
const FRONTEND_DIR = join(import.meta.dir, "../../frontend/dist");
const FRONTEND_404 = join(FRONTEND_DIR, "404.html");
const FRONTEND_PUBLIC_404 = join(import.meta.dir, "../../frontend/public/404.html");
const serveFrontend = (): ReturnType<typeof Bun.file> => Bun.file(FRONTEND_INDEX);

// Branded server-level error page (built from frontend/public/404.html).
// Loaded once at startup; unknown paths get a real 404 with this page instead
// of a silent 200 empty body. Falls back to public/404.html or plain text when dist is missing.
// NOTE: this must stay synchronous — a top-level await here leaves `app` in
// TDZ for importers in the module graph (broke every test importing app).
let frontend404Html: string | null = null;
try {
  frontend404Html = readFileSync(FRONTEND_404, "utf8");
} catch {
  try {
    frontend404Html = readFileSync(FRONTEND_PUBLIC_404, "utf8");
  } catch {
    frontend404Html = null;
  }
}

// Import route plugins
import { healthRoutes } from "./routes/health";
import { systemHealthRoutes } from "./routes/health";
import { operationsRoutes } from "./routes/operations";
import { accountRoutes } from "./routes/accounts";
import { userRoutes } from "./routes/users";
import { organizationRoutes } from "./routes/organizations";
import { varsetRoutes } from "./routes/varsets";
import { workspaceRoutes } from "./routes/workspaces";
import { runRoutes } from "./routes/runs";
import { stateVersionRoutes } from "./routes/state-versions";
import { configurationVersionRoutes } from "./routes/configuration-versions";
import { teamRoutes } from "./routes/teams";
import { projectRoutes } from "./routes/projects";
import { gpgKeyRoutes } from "./routes/gpg-keys";
import { registryRoutes } from "./routes/registry";
import { providerSetRoutes } from "./routes/provider-sets";
import { tokenTtlRoutes } from "./routes/token-ttl";
import { oidcConfigRoutes } from "./routes/oidc-configs";
import { hyokRoutes } from "./routes/hyok";
import { stackRoutes } from "./routes/stacks";
import { adminRoutes } from "./routes/admin";
import { scimAdminRoutes } from "./routes/scim-admin";
import { adminRegistrySharingRoutes } from "./routes/admin-registry-sharing";
import { systemAdminRoutes } from "./routes/system-admin";
import { policyRoutes } from "./routes/policies";
import { agentRoutes } from "./routes/agents";
import { agentApiRoutes } from "./routes/agent-api";
import { runTaskRoutes } from "./routes/run-tasks";
import { oauthClientRoutes } from "./routes/oauth-clients";
import { notificationRoutes } from "./routes/notifications";
import { mcpRoutes } from "./routes/mcp";
import { sshKeyRoutes } from "./routes/ssh-keys";
import { githubAppInstallationRoutes } from "./routes/github-app-installations";
import { miscRoutes } from "./routes/misc";
import { assessmentRoutes } from "./routes/assessments";
import { eventsRoutes } from "./routes/events";
import { policyEvaluationRoutes } from "./routes/policy-evaluations";
import { docsRoutes } from "./routes/docs";
import { workspaceTransferRoutes } from "./routes/workspace-transfers";
import { planExportRoutes } from "./routes/plan-exports";
import { cidrRangeRoutes } from "./routes/cidr-ranges";
import { avatarHandler } from "./routes/avatars";
import { scimRoutes } from "./routes/scim";
import { explorerRoutes } from "./routes/explorer";
import { teamProjectRoutes } from "./routes/team-projects";
import { organizationRoleRoutes } from "./routes/organization-roles";
import { organizationInvitationRoutes } from "./routes/organization-invitations";
import { emailVerificationRoutes } from "./routes/email-verification";
import { samlRoutes } from "./routes/saml";
import { oidcRoutes } from "./routes/oidc";
import { workloadIdentityRoutes } from "./routes/workload-identity";
import { providerIconRoutes } from "./routes/provider-icons";
import { actionsRoutes } from "./routes/actions";
import { registryComponentsRoutes } from "./routes/registry-components";
import { availableVersions } from "./binaryManager";

// Store request metadata without polluting the set object
const requestMeta = new WeakMap<Request, { startTime: number; method: string; path: string; correlationId: string }>();

/** Collapse high-cardinality path segments (uuids, names, numeric ids) into
 * a stable bucket for aggregation, e.g. /api/v2/workspaces/ws-a-1/runs/run-9
 * -> /api/v2/workspaces/:id/runs/:id. Trailing detail is preserved for
 * known low-cardinality verbs (healthz, metrics). */
function pathnameBucket(path: string): string {
  // A segment is "static" only when it is empty (leading slash), an API
  // version (v1/v2), or a short lowercase word with no digits (healthz,
  // workspaces, runs). Anything else (uuids, names, numeric ids, hashes)
  // collapses to ":id".
  return path
    .split("/")
    .map((segment): string =>
      segment === "" || /^v\d{1,2}$/.test(segment) || /^[a-z][a-z-]{0,30}$/.test(segment)
        ? segment
        : ":id",
    )
    .join("/");
}

type HeaderGetter = { readonly get: (name: string) => string | null };
type CustomRequest = Readonly<{
  readonly url: string;
  readonly method: string;
  readonly headers: HeaderGetter;
  readonly text: () => Promise<string>;
}>;

type SetObject = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type RequestContext = Readonly<{
  request: CustomRequest;
  set: SetObject;
}>;

type AfterHandleContext = Readonly<{
  request: CustomRequest;
  response: unknown;
  set: SetObject;
}>;

type ParseContext = Readonly<{
  request: CustomRequest;
  contentType: string;
}>;

type OptionsContext = Readonly<{
  set: unknown;
}>;

type ErrorContext = Readonly<{
  code: unknown;
  error: unknown;
  set: unknown;
}>;

export function handleAppError(context: ErrorContext & { request: { url: string } }): { errors: { status: string; title: string; detail?: string }[] } | string | undefined {
  const { code, error, set, request } = context;
  const mutableSet = set as { status?: number | string; headers: Record<string, string | number> };
  const pathname = new URL(request.url).pathname;
  // Elysia wraps onParse failures in its own ParseError; the original is
  // preserved as `cause` (elysia/dist/error.js ParseError).
  const isBodyTooLarge = error instanceof BodyTooLargeError
    || (code === "PARSE" && error instanceof Error && error.cause instanceof BodyTooLargeError);
  // Error path: the request never reached onAfterHandle, so settle the
  // in-flight counter here instead (same WeakMap consumption rule). The
  // status mirrors the branch logic below so 404/422/400/413 do not count
  // as 5xx.
  const errored = requestMeta.get(request as unknown as Request);
  if (errored !== undefined) {
    const status = code === "NOT_FOUND" ? 404
      : code === "VALIDATION" ? 422
        : code === "PARSE" || code === "INVALID_COOKIE_SIGNATURE" ? (isBodyTooLarge ? 413 : 400)
          : typeof mutableSet.status === "number" ? mutableSet.status : 500;
    requestFinished(status);
    requestMeta.delete(request as unknown as Request);
  }
  if (code === "NOT_FOUND") {
    if (!(pathname === "/api" || pathname.startsWith("/api/"))) {
      mutableSet.status = 404;
      mutableSet.headers["Content-Type"] = "text/html; charset=utf-8";
      return frontend404Html ?? "Not Found";
    }
    mutableSet.headers["Content-Type"] = "application/vnd.api+json";
    mutableSet.status = 404;
    return { errors: [{ status: "404", title: "Not Found" }] };
  }
  mutableSet.headers["Content-Type"] = "application/vnd.api+json";
  if (isBodyTooLarge) {
    mutableSet.status = 413;
    return {
      errors: [{
        status: "413",
        title: "Payload Too Large",
        detail: `Request body exceeds the ${API_BODY_LIMIT_BYTES} byte limit for this endpoint`,
      }],
    };
  }
  const clientStatus = code === "VALIDATION" ? 422
    : code === "PARSE" || code === "INVALID_COOKIE_SIGNATURE" ? 400
      : null;
  if (clientStatus !== null) {
    mutableSet.status = clientStatus;
    return {
      errors: [{
        status: String(clientStatus),
        title: clientStatus === 422 ? "Unprocessable Content" : "Bad Request",
      }],
    };
  }
  mutableSet.status = 500;
  log.error("Unhandled request error", {
    code,
    path: pathname,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return {
    errors: [{
      status: "500",
      title: "Internal Server Error",
      detail: "An unexpected error occurred",
    }],
  };
}

type PasswordGuardContext = Readonly<{
  request: CustomRequest;
  user?: Readonly<{ mustChangePassword?: boolean }> | null;
  set: SetObject;
}>;

type RateLimitServer = Readonly<{
  readonly requestIP?: (request: Request) => Readonly<{ readonly address?: string }> | null;
}>;

/** Parse a positive-integer env override, falling back to the default. */
function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const RATE_LIMIT_MAX = envPositiveInt("RATE_LIMIT_MAX", 60);
const SENSITIVE_RATE_LIMIT = envPositiveInt("RATE_LIMIT_SENSITIVE_MAX", 5);
const SENSITIVE_RATE_DURATION_MS = 60_000;
// SSO initiation and IdP-initiated logout arrive from browsers/IdPs (shared
// NATs, corporate proxies), so the 5/min credential limiter would break
// legitimate flows; give them their own, higher-bound limiter.
const SSO_GET_RATE_LIMIT = envPositiveInt("RATE_LIMIT_SSO_GET_MAX", 60);
// SCIM admin settings endpoints: 20 per 1s window per principal (mirrors the
// former hand-rolled fixed-window limiter in scim-admin.ts exactly).
const SCIM_SETTINGS_RATE_LIMIT = envPositiveInt("RATE_LIMIT_SCIM_SETTINGS_MAX", 20);
// SCIM team-group mapping writes: 10 per 60s per principal.
const SCIM_MAPPING_RATE_LIMIT = envPositiveInt("RATE_LIMIT_SCIM_MAPPING_MAX", 10);
// the reference format protects workspace run-history separately from the general API bucket.
// Keep the compatibility default deliberately conservative while allowing an
// operator to tune it for a larger deployment.
/**
 * Per-resource rate-limit summary (todo 463 — keep this block in sync with
 * 464's endpoint-policy table):
 *  - general (RATE_LIMIT_MAX / 1s): every server endpoint outside the
 *    specific buckets below; derived from serverEndpointPath()
 *  - workspaceRunHistory (RATE_LIMIT_WORKSPACE_RUN_HISTORY_MAX / RATE_LIMIT_WORKSPACE_RUN_HISTORY_DURATION_MS)
 *  - sensitive (RATE_LIMIT_SENSITIVE_MAX / 60s): login + sensitive writes
 *  - sso-get (RATE_LIMIT_SSO_GET_MAX / 60s): SSO redirect / callback / IdP logout
 *  - scim-settings (RATE_LIMIT_SCIM_SETTINGS_MAX / 1s): SCIM admin settings
 *  - scim-mapping (RATE_LIMIT_SCIM_MAPPING_MAX / 60s): SCIM team mappings
 * Exposed via GET /api/v2/capabilities rate-limit docs block; see that route.
 */
const WORKSPACE_RUN_HISTORY_RATE_LIMIT = envPositiveInt("RATE_LIMIT_WORKSPACE_RUN_HISTORY_MAX", 120);
const WORKSPACE_RUN_HISTORY_DURATION_MS = envPositiveInt("RATE_LIMIT_WORKSPACE_RUN_HISTORY_DURATION_MS", 60_000);

function distributedOrLocal(bucketPrefix: string): ReturnType<typeof fixedWindowContext> {
  return isPostgres ? distributedFixedWindowContext(bucketPrefix) : fixedWindowContext();
}

function fixedWindowContext(): RateLimitContext {
  const counts = new Map<string, number>();
  let duration = SENSITIVE_RATE_DURATION_MS;
  let resetAt = Date.now() + duration;

  const resetExpiredWindow = (now: number): void => {
    if (now < resetAt) return;
    counts.clear();
    resetAt = now + duration;
  };

  return {
    init(options): void {
      duration = typeof options.duration === "number" && Number.isFinite(options.duration) && options.duration > 0
        ? options.duration
        : SENSITIVE_RATE_DURATION_MS;
      resetAt = Date.now() + duration;
    },
    increment(key, requestDuration, requestTime): { count: number; nextReset: Date; start: number } {
      const now = requestTime ?? Date.now();
      if (requestDuration !== undefined && requestDuration !== duration) {
        duration = requestDuration;
        resetAt = now + duration;
        counts.clear();
      }
      resetExpiredWindow(now);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { count, nextReset: new Date(resetAt), start: resetAt - duration };
    },
    decrement(key): void {
      const count = counts.get(key);
      if (count !== undefined && count > 0) counts.set(key, count - 1);
    },
    reset(key): void {
      if (key !== undefined) {
        counts.delete(key);
        return;
      }
      counts.clear();
      resetAt = Date.now() + duration;
    },
    kill(): void {
      counts.clear();
    },
  };
}

function ipRateLimitKey(request: Request, server: RateLimitServer | null): string {
  // When the admin has opted into trusting forwarded headers (behind Cloudflare
  // etc.), key rate limits on the real client IP instead of the proxy peer.
  const directAddress = typeof server?.requestIP === "function"
    ? server.requestIP(request)?.address ?? null
    : null;
  const trusted = trustedClientIpForPeer(request, directAddress);
  if (trusted !== null && trusted !== "") return `ip:${trusted}`;
  const forwardedAddress = server === null
    ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    : undefined;
  // app.handle() has no socket address; isolate those requests unless a test
  // explicitly supplies a simulated client address.
  const address = directAddress ?? forwardedAddress ?? crypto.randomUUID();
  return `ip:${address}`;
}

function principalRateLimitKey(request: Request, server: RateLimitServer | null): string {
  return authenticatedRateLimitKey(request) ?? ipRateLimitKey(request, server);
}

const RATE_LIMIT_ERROR_RESPONSE = new Response(
  JSON.stringify({ errors: [{ detail: "You have exceeded the API's rate limit.", status: "429", title: "Too Many Requests" }] }),
  { headers: { "content-type": "application/vnd.api+json" }, status: 429 },
);







export const app = new Elysia()
  .use(authPlugin)
  .get("/openapi.json", (): unknown => openapiJson)
  .get("/api/v2/available-versions", async ({ query, set }: Readonly<{ query: Readonly<Record<string, string>>; set: SetObject }>): Promise<unknown> => {
    const tool = query.tool === "terraform" ? "terraform" : "tofu";
    try {
      return { data: await availableVersions(tool) };
    } catch {
      (set as { status: number }).status = 503;
      return { errors: [{ status: "503", title: "Service Unavailable", detail: "Engine versions are temporarily unavailable." }] };
    }
  })
  .onBeforeHandle(({ token, user, set }: { readonly token: { readonly scopes?: string | null } | null; readonly user: { readonly id: string; readonly isSiteAdmin: boolean | null } | null; readonly set: unknown }): Record<string, unknown> | undefined => {
    // Publish fine-grained token scopes into request-scoped storage BEFORE
    // handlers run, so permission helpers enforce them automatically. Legacy
    // tokens (scopes null/absent) resolve to null = full permissions.
    // A malformed scopes field is an auth failure: fail closed (401) rather
    // than silently escalating a scoped token to full permissions.
    if (token !== null && typeof token.scopes === "string" && token.scopes !== "") {
      let parsed: TokenScopes | null;
      try {
        parsed = parseTokenScopes(token.scopes);
      } catch {
        (set as Record<string, unknown>).status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Token scopes are malformed" }] };
      }
      setRequestTokenScopes(parsed);
    } else {
      setRequestTokenScopes(null);
    }
    // The auth derive already read the full user row; hand its site-admin flag
    // to permission helpers so they skip a duplicate users read.
    setRequestSiteAdmin(user?.id ?? null, user?.isSiteAdmin === true);
    return undefined;
  })
  .onBeforeHandle(({ request, user, set }: PasswordGuardContext): Record<string, unknown> | undefined => {
    if (user?.mustChangePassword !== true) return;
    const path = new URL(request.url).pathname;
    if (path === "/api/v2/account/details" || path === "/api/v2/account/password") return;
    if (!path.startsWith("/api/")) return;
    (set as { status: number }).status = 403;
    return {
      errors: [{
        status: "403",
        title: "Password Change Required",
        detail: "Change the temporary administrator password before continuing",
      }],
    };
  })
  .use(rateLimit({
    max: RATE_LIMIT_MAX,
    duration: 1000,
    generator: (request: Request, server: RateLimitServer | null): string => {
      return principalRateLimitKey(request, server);
    },
    // Static content (SPA shell, hashed /assets/* chunks, favicon) is exempt:
    // a page load fetches 30-40 chunks in parallel and would trip the bucket
    // on every cold cache. Only server endpoints are counted; login and other
    // credential-bearing paths get their own tighter limiters below.
    // Workspace run history has its own dedicated bucket (120/min) so it is
    // excluded here to avoid double-counting the same request against the
    // global 60/sec bucket.
    skip: (request: CustomRequest): boolean => serverEndpointPath(request) === undefined || workspaceRunHistoryPath(request) !== undefined,
  }))
  .use(rateLimit({
    context: distributedOrLocal("workspace-run-history"),
    duration: WORKSPACE_RUN_HISTORY_DURATION_MS,
    max: WORKSPACE_RUN_HISTORY_RATE_LIMIT,
    generator: (request: Request, server: RateLimitServer | null): string => {
      return `workspace-run-history:${principalRateLimitKey(request, server)}`;
    },
    errorResponse: RATE_LIMIT_ERROR_RESPONSE,
    skip: (request: CustomRequest): boolean => workspaceRunHistoryPath(request) === undefined,
  }))
  .use(rateLimit({
    context: distributedOrLocal("sensitive"),
    duration: SENSITIVE_RATE_DURATION_MS,
    max: SENSITIVE_RATE_LIMIT,
    generator: (request: Request, server: RateLimitServer | null): string => {
      return `sensitive:${sensitivePath(request) ?? "unknown"}:${principalRateLimitKey(request, server)}`;
    },
    errorResponse: RATE_LIMIT_ERROR_RESPONSE,
    skip: (request: CustomRequest): boolean => sensitivePath(request) === undefined,
  }))
  .use(rateLimit({
    context: distributedOrLocal("sso-get"),
    duration: SENSITIVE_RATE_DURATION_MS,
    max: SSO_GET_RATE_LIMIT,
    generator: (request: Request, server: RateLimitServer | null): string => {
      return `sso-get:${sensitiveSsoPath(request) ?? "unknown"}:${principalRateLimitKey(request, server)}`;
    },
    errorResponse: RATE_LIMIT_ERROR_RESPONSE,
    skip: (request: CustomRequest): boolean => sensitiveSsoPath(request) === undefined,
  }))
  .use(rateLimit({
    context: distributedOrLocal("scim-settings"),
    duration: 1_000,
    max: SCIM_SETTINGS_RATE_LIMIT,
    generator: (request: Request, server: RateLimitServer | null): string => {
      return `scim-settings:${scimSettingsPath(request) ?? "unknown"}:${principalRateLimitKey(request, server)}`;
    },
    errorResponse: RATE_LIMIT_ERROR_RESPONSE,
    skip: (request: CustomRequest): boolean => scimSettingsPath(request) === undefined,
  }))
  // SCIM limiters are distributed on Postgres (shared bucket table) so all
  // replicas share the same window; on SQLite they remain process-local (single
  // instance, no cross-replica drift).
  .use(rateLimit({
    context: distributedOrLocal("scim-mapping"),
    duration: 60_000,
    max: SCIM_MAPPING_RATE_LIMIT,
    generator: (request: Request, server: RateLimitServer | null): string => {
      return `scim-mapping:${principalRateLimitKey(request, server)}`;
    },
    errorResponse: RATE_LIMIT_ERROR_RESPONSE,
    skip: (request: CustomRequest): boolean => scimMappingPath(request) === undefined,
  }))
  .use(rateLimit({
    // 488: /metrics gets its own small bucket so scrape storms don't starve the global limiter.
    context: distributedOrLocal("metrics"),
    duration: 60_000,
    max: envPositiveInt("RATE_LIMIT_METRICS_MAX", 30),
    generator: (request: Request, server: RateLimitServer | null): string => `metrics:${principalRateLimitKey(request, server)}`,
    errorResponse: RATE_LIMIT_ERROR_RESPONSE,
    skip: (request: CustomRequest): boolean => {
      const p = new URL(request.url).pathname;
      return p !== "/metrics";
    },
  }))
  .use(oauthPlugin)
  .onRequest(({ request, set }: RequestContext): Record<string, unknown> | undefined => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
    const suppliedId = request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id");
    const correlationId = suppliedId !== null && CORRELATION_ID_PATTERN.test(suppliedId) ? suppliedId : crypto.randomUUID();
    requestMeta.set(request as unknown as Request, { startTime: Date.now(), method, path: pathname, correlationId });
    (set.headers as Record<string, string | number>)["X-Request-Id"] = correlationId;
    requestStarted();

    // Body-size guard: upload paths keep the 100 MiB server-level limit, but
    // every other endpoint (login, JSON APIs, webhooks) rejects oversized
    // bodies before Elysia buffers them. Content-Length is checked here (no
    // buffering); chunked bodies are capped during onParse below.
    if (!isUploadPath(pathname)) {
      const contentLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > API_BODY_LIMIT_BYTES) {
        // Settle the request counters here; a short-circuited onRequest may
        // never reach onAfterHandle. Idempotent if it does (meta is gone).
        requestFinished(413);
        requestMeta.delete(request as unknown as Request);
        (set as { status: number }).status = 413;
        return {
          errors: [{
            status: "413",
            title: "Payload Too Large",
            detail: `Request body exceeds the ${API_BODY_LIMIT_BYTES} byte limit for this endpoint`,
          }],
        };
      }
    }

    const headers = set.headers as Record<string, string | number>;
    // CORS: never emit a hardcoded allow-origin fallback (a blanket
    // http://localhost:5173 previously exposed the API to any localhost page).
    // If CORS_ORIGIN is set (comma-separated allow-list) we reflect only an
    // Origin that matches it. Otherwise, in non-production builds we reflect a
    // frontend dev Origin explicitly — no origin, no CORS header.
    const origin = request.headers.get("origin");
    const allowedOrigins = (process.env.CORS_ORIGIN ?? "")
      .split(",")
      .map((value): string => value.trim())
      .filter((value): boolean => value !== "");
    const isDevBuild = process.env.NODE_ENV !== "production";
    if (origin !== null
      && ((allowedOrigins.length > 0 && allowedOrigins.includes(origin))
        || (allowedOrigins.length === 0 && isDevBuild && (origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173")))) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
    headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type,Idempotency-Key,If-Match,If-None-Match";
    headers["Access-Control-Expose-Headers"] = "TFP-API-Version,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,Retry-After,X-Request-Id,ETag,Deprecation,Sunset";
  })
  .onAfterHandle(({ request, response, set }: AfterHandleContext): Response | void => {
    const meta = requestMeta.get(request as unknown as Request);
    if (meta !== undefined) {
      const duration = Date.now() - meta.startTime;
      const method = meta.method;
      const path = meta.path;
      const status = set.status ?? 200;
      const numericStatus = typeof status === "number" ? status : Number.parseInt(String(status), 10) || 200;
      requestFinished(numericStatus);
      // Idempotent bookkeeping: the WeakMap entry is consumed here so an
      // error path (onError) can never double-count the same request.
      requestMeta.delete(request as unknown as Request);
      if (path.startsWith("/api/")) {
        // Canonical log line (loggingsucks.com wide-event pattern): one
        // context-rich record per request instead of scattered statements.
        log.info("request completed", {
          requestId: meta.correlationId,
          http: {
            method,
            path,
            status: numericStatus,
            durationMs: duration,
          },
          // High-cardinality route bucket (no ids) so aggregations group
          // cleanly while the raw path stays available for exact search.
          routeBucket: method + " " + pathnameBucket(path),
          outcome: numericStatus < 400 ? "success" : numericStatus < 500 ? "client-error" : "server-error",
        });
      }
    }
    const isJsonDocument = response !== null
      && typeof response === "object"
      && (Array.isArray(response) || Object.getPrototypeOf(response) === Object.prototype);
    const headers = set.headers as Record<string, string | number>;
    const pathname = new URL(request.url).pathname;

    // Browser/document shell hardening (CSP, clickjacking, referrer, robots,
    // permissions) + static caching. Applies to every response, so static
    // assets and SPA HTML get the same treatment as API responses.
    applySecurityHeaders(headers);
    // HSTS (137): only when Terrence knows it is behind HTTPS, so plain HTTP
    // dev/test deployments are not forced into HTTPS by a cached header.
    try {
      if (shouldSendHsts(request)) {
        if (headers["Strict-Transport-Security"] === undefined) headers["Strict-Transport-Security"] = HSTS_VALUE;
      }
    } catch { /* HSTS is best-effort */ }
    if (headers["Content-Type"] === undefined) {
      const mime = staticMimeFor(pathname);
      if (mime !== undefined) headers["Content-Type"] = mime;
    }
    const cacheControl = staticCacheControl(pathname);
    if (cacheControl !== undefined) {
      headers["Cache-Control"] = cacheControl;
    } else if ((pathname === "/api" || pathname.startsWith("/api/")) && headers["Cache-Control"] === undefined) {
      // Control-plane API responses can carry secrets/state; never let a
      // browser or shared cache persist them (avatar images set their own
      // Cache-Control intentionally, so we don't override those).
      headers["Cache-Control"] = "no-store";
    }

    // When an Origin is reflected (or the server may vary by origin), the
    // response MUST advertise that with Vary: Origin or shared caches will
    // serve one origin's CORS decision to everyone.
    const originHeader = request.headers.get("origin");
    const corsConfigured = (process.env.CORS_ORIGIN ?? "").split(",").some((value: string): boolean => value.trim() !== "");
    if (originHeader !== null || corsConfigured) {
      const { Vary: existingVary } = headers;
      headers.Vary = existingVary === undefined ? "Origin" : `${String(existingVary)}, Origin`;
    }

    // 458: emit deprecation headers for compat-legacy support-bundle path.
    if (pathname.startsWith("/api/v1/support-bundle-requests")) {
      if (headers.Deprecation === undefined) headers.Deprecation = "true";
      if (headers.Sunset === undefined) headers.Sunset = "Sat, 31 Dec 2028 23:59:59 GMT";
      if (headers.Link === undefined) headers.Link = "</api/v1/support/bundle-requests>; rel=\"successor-version\"";
    }
    if ((pathname === "/api" || pathname.startsWith("/api/")) && isJsonDocument) {
      headers["Content-Type"] = "application/vnd.api+json";
    }
    const responseHeaders = response instanceof Response ? response.headers : null;
    const limit = responseHeaders?.get("RateLimit-Limit") ?? set.headers["RateLimit-Limit"];
    const remaining = responseHeaders?.get("RateLimit-Remaining") ?? set.headers["RateLimit-Remaining"];
    if (limit !== undefined && limit !== null) headers["X-RateLimit-Limit"] = limit;
    if (remaining !== undefined && remaining !== null) headers["X-RateLimit-Remaining"] = remaining;
    // 461/462: standardize Retry-After + legacy X-RateLimit-Reset on 429; honor any explicit Retry-After already set.
    const responseRetryAfter = responseHeaders?.get("Retry-After");
    if (responseRetryAfter !== undefined && responseRetryAfter !== null && headers["Retry-After"] === undefined) {
      headers["Retry-After"] = responseRetryAfter;
    }
    if ((set.status === 429 || String(set.status) === "429") && headers["Retry-After"] === undefined) {
      const reset = responseHeaders?.get("RateLimit-Reset") ?? set.headers["RateLimit-Reset"] ?? set.headers["X-RateLimit-Reset"] ?? set.headers["X-RateLimit-Reset-At"];
      let seconds: number | null = null;
      if (reset !== undefined && reset !== null) {
        const asNum = Number(reset);
        if (Number.isFinite(asNum) && asNum > 0) {
          seconds = asNum > 1_000_000_000 ? Math.max(1, Math.ceil((asNum - Date.now()) / 1000)) : Math.max(1, Math.ceil(asNum));
        } else {
          const asDate = Date.parse(String(reset));
          if (!Number.isNaN(asDate)) seconds = Math.max(1, Math.ceil((asDate - Date.now()) / 1000));
        }
      }
      headers["Retry-After"] = String(seconds ?? 60);
      if (headers["X-RateLimit-Reset"] === undefined && reset !== undefined && reset !== null) headers["X-RateLimit-Reset"] = String(reset);
    }
    // Always clear the internal precondition marker — it is server-internal state, never a client header.
    // 452-454: ETag + conditional request handling.
    // Generates a 64-bit ETag (Bun.hash) so If-None-Match collisions are negligible;
    // honors If-None-Match with an empty 304 per RFC 9110 (no body), and enforces
    // If-Match via the marker set in onRequest.
    // NOTE: a post-response 412 cannot prevent the lost-update (the handler already wrote the row);
    // real lost-update protection requires the handler to load the current entity and check If-Match
    // before mutating state. This layer provides best-effort enforcement and marker hygiene.
    if (isJsonDocument && (pathname === "/api" || pathname.startsWith("/api/"))) {
      try {
        const etag = strongDocumentEtag(response);
        if (headers.ETag === undefined) headers.ETag = etag;
        if (request.method === "GET") {
          const inm = request.headers.get("if-none-match");
          if (inm !== null && (inm === etag || inm === "*")) {
            headers.ETag = etag;
            return new Response(null, { status: 304, headers: headers as Record<string, string> });
          }
        }
      } catch (error: unknown) {
        // ETag generation must never silently mask a failure — log at debug so operators can observe.
        try { log.debug("ETag generation failed", { error: String(error) }); } catch {}
      }
    }
  })
  .onParse(async ({ request, contentType }: ParseContext): Promise<Record<string, unknown> | string | null | undefined> => {
    const pathname = new URL(request.url).pathname;
    // HMAC-verified webhooks must verify against the exact bytes on the wire;
    // a JSON round-trip would re-serialize noncanonically and break signatures.
    if (
      pathname === "/api/webhooks/github"
      || pathname === "/api/webhooks/bitbucket"
      || pathname === "/api/v2/webhooks/run-approval"
      // Agent log chunks are raw stream text (never JSON); a JSON-flavored
      // content-type would make Elysia consume the stream and drop the body.
      || /^\/api\/agent\/jobs\/[^/]+\/log$/.test(pathname)
    ) {
      return readTextWithLimit(request as unknown as Request, API_BODY_LIMIT_BYTES);
    }
    // Any JSON-flavored content type (vnd.api+json, application/json,
    // application/scim+json, ...) is capped and parsed here so chunked
    // bodies without Content-Length cannot buffer up to the 100 MiB server
    // limit. Non-JSON types (multipart avatar uploads, archive blobs) stay
    // on Elysia's default parse; the archive paths are upload-path exempt
    // by design.
    if (contentType !== undefined && contentType.includes("json")) {
      const text = await readTextWithLimit(request as unknown as Request, API_BODY_LIMIT_BYTES);
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  })
  .use(staticPlugin({
    assets: join(import.meta.dir, "../../frontend/dist"),
    prefix: "/",
  }))
  // Avatar proxy handled from the SPA catch-all (see `.get("*")` below) so it
  // is not shadowed by the wildcard route.
  .get("/", serveFrontend)
  .get("/login", serveFrontend)
  .get("/register", serveFrontend)
  .get("/app", serveFrontend)
  .get("/app/*", serveFrontend)
  .get("*", async ({ request, set }: { request: Request; set: Record<string, unknown> }): Promise<Response | { errors: { status: string; title: string }[] } | undefined> => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    // Avatar proxy: handled here (the wildcard route is what Elysia matches
    // for `/api/v2/avatars/<key>`) so it can't be shadowed by a `:param` route.
    const avatarMatch = /^\/api\/v2\/avatars\/([0-9a-f]{64})$/.exec(pathname);
    if (avatarMatch !== null && avatarMatch[1] !== undefined) {
      return avatarHandler({
        params: { key: avatarMatch[1] },
        request,
        set: set as { status: number | string; headers: Record<string, string | number> },
      });
    }
    const isApiPath = pathname === "/api" || pathname.startsWith("/api/");
    if (isApiPath) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (pathname === "/login" || pathname === "/app" || pathname.startsWith("/app/")) {
      return new Response(Bun.file(FRONTEND_INDEX));
    }
    const filePath = join(FRONTEND_DIR, pathname);
    if (filePath.startsWith(FRONTEND_DIR) && await Bun.file(filePath).exists()) {
      return new Response(Bun.file(filePath));
    }
    // Nothing matched: return a real 404 instead of a silent 200 empty body.
    // Missing assets get a bare text 404; navigations get the branded page.
    const mutableSet = set as { status: number; headers: Record<string, string | number> };
    mutableSet.status = 404;
    // Each alternative is independently anchored so a path cannot slip past
    // one branch by matching only the other (e.g. "/x/assets/" or a trailing
    // extension without a leading path separator).
    const isAssetPath = /^\/assets\//i.test(pathname) || /\.[a-z0-9]{1,10}$/i.test(pathname);
    const plainText = isAssetPath || frontend404Html === null;
    mutableSet.headers["Content-Type"] = plainText ? "text/plain; charset=utf-8" : "text/html; charset=utf-8";
    return new Response(plainText ? "Not Found" : frontend404Html, { status: 404 });
  })
  .options("/*", ({ set }: OptionsContext): Record<string, never> => {
    (set as { status: number }).status = 204;
    return {};
  })
  .onError(handleAppError)
  // Route modules
  .use(systemHealthRoutes)
  .use(healthRoutes)
  .use(operationsRoutes)
  .use(accountRoutes)
  .use(userRoutes)
  .use(organizationRoutes)
  .use(varsetRoutes)
  .use(workspaceRoutes)
  .use(runRoutes)
  .use(stateVersionRoutes)
  .use(configurationVersionRoutes)
  .use(teamRoutes)
  .use(projectRoutes)
  .use(gpgKeyRoutes)
  .use(registryRoutes)
  .use(stackRoutes)
  .use(providerSetRoutes)
  .use(tokenTtlRoutes)
  .use(oidcConfigRoutes)
  .use(hyokRoutes)
  .use(adminRoutes)
  .use(scimAdminRoutes)
  .use(adminRegistrySharingRoutes)
  .use(policyRoutes)
  .use(agentRoutes)
  .use(agentApiRoutes)
  .use(runTaskRoutes)
  .use(oauthClientRoutes)
  .use(notificationRoutes)
  .use(mcpRoutes)
  .use(sshKeyRoutes)
  .use(githubAppInstallationRoutes)
  .use(miscRoutes)
  .use(assessmentRoutes)
  .use(eventsRoutes)
  .use(workspaceTransferRoutes)
  .use(planExportRoutes)
  .use(cidrRangeRoutes)
  .use(scimRoutes)
  .use(explorerRoutes)
  .use(teamProjectRoutes)
  .use(organizationRoleRoutes)
  .use(organizationInvitationRoutes)
  .use(emailVerificationRoutes)
  .use(samlRoutes)
  .use(oidcRoutes)
  .use(workloadIdentityRoutes)
  .use(providerIconRoutes)
  .use(policyEvaluationRoutes)
  .use(docsRoutes)
  .use(actionsRoutes)
  .use(registryComponentsRoutes);

// The System API has its own listener in production; privileged diagnostics
// are deliberately not mounted on the public application listener.
export const systemApiApp = new Elysia({ name: "system-api-listener" })
  .use(systemHealthRoutes)
  .use(systemAdminRoutes)
  // Security-header and error-handling parity with the application listener:
  // the System API exposes node inventory, diagnostics and support bundles,
  // so responses must carry the same hardening and error shapes.
  .onAfterHandle(({ set }): void => {
    applySecurityHeaders(set.headers);
    if (set.headers["Cache-Control"] === undefined) {
      set.headers["Cache-Control"] = "no-store";
    }
  })
  .onError(({ code, error, set, request }) => handleAppError({
    code: String(code),
    error,
    set,
    request: { url: String(request.url) },
  }));

// Start the background worker queue. Deferred out of module evaluation:
// ./db/index.ts is a top-level-await module, and the dynamic import weave
// can fire this before `db` finishes initializing (TDZ ReferenceError that
// 500s every request in worker-thread test runs). A 0ms timer guarantees
// the module graph has fully evaluated before the first poll.
setTimeout((): void => {
  let loggingRefreshFailureReported = false;
  const refreshLoggingSettings = (): void => {
    void import("./lib/settings").then(({ getSettings }): Promise<void> =>
      getSettings("logging").then(applyLoggingSettings),
    ).then((): void => {
      loggingRefreshFailureReported = false;
    }).catch((error: unknown): void => {
      if (loggingRefreshFailureReported) return;
      loggingRefreshFailureReported = true;
      log.warn("Failed to load Site Admin logging settings", { error: String(error) });
    });
  };
  refreshLoggingSettings();
  const loggingRefreshTimer = setInterval(refreshLoggingSettings, 1_000);
  (loggingRefreshTimer as unknown as { unref?: () => void }).unref?.();
  import("./worker").then(({ startWorkerQueue }: { startWorkerQueue: () => void }): void => {
    startWorkerQueue();
    log.info("Worker queue started");
  }).catch((error: unknown): void => {
    log.error("Failed to start worker queue", { error: String(error) });
  });
  // Memory/request observability sampler. Follows the worker switch: tests
  // disable both (TERRENCE_DISABLE_WORKER=1 keeps the process timer-free),
  // production runs both. The ring buffer is what turns the /metrics rss
  // growth figure into a leak trend instead of a steady-state snapshot.
  if (!envEnabled(process.env.TERRENCE_DISABLE_WORKER)) {
    import("./lib/process-metrics").then(({ startProcessSampler }: { startProcessSampler: (intervalMs?: number, ringMax?: number) => void }): void => {
      startProcessSampler();
    }).catch((error: unknown): void => {
      log.error("Failed to start metrics sampler", { error: String(error) });
    });
  }
  // Fire-and-forget sweep of the installed-binary cache (kanban 6.5):
  // removes installs whose executable no longer matches its persisted
  // digest so tampered binaries are re-downloaded before first use.
  import("./binaryManager").then(({ revalidateInstalledBinaries }): void => {
    void revalidateInstalledBinaries().then((removed: string[]): void => {
      if (removed.length > 0) {
        log.warn(`[terrence] Removed ${removed.length} binary install(s) failing integrity check: ${removed.join(", ")}`);
      }
    });
  }).catch((error: unknown): void => {
    log.warn(`[terrence] Binary integrity sweep unavailable: ${String(error)}`);
  });
}, 0);
