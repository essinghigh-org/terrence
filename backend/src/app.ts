import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit, type Context as RateLimitContext } from "elysia-rate-limit";
import { join } from "path";
import { authPlugin, authenticatedRateLimitKey } from "./auth";
import { syncedTrustedClientIp } from "./lib/client-ip";
import { oauthPlugin } from "./oauth";
import { log } from "./lib/log";
import { parseTokenScopes, type TokenScopes } from "./lib/token-scopes";
import { setRequestTokenScopes, setRequestSiteAdmin } from "./lib/request-scope";
import { applySecurityHeaders, staticCacheControl, staticMimeFor } from "./lib/security-headers";

const FRONTEND_INDEX = join(import.meta.dir, "../../frontend/dist/index.html");
const FRONTEND_DIR = join(import.meta.dir, "../../frontend/dist");
const serveFrontend = (): ReturnType<typeof Bun.file> => Bun.file(FRONTEND_INDEX);

// Import route plugins
import { healthRoutes } from "./routes/health";
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
import { permissionSimulatorRoutes } from "./routes/permission-simulator";
import { agentRoutes } from "./routes/agents";
import { runTaskRoutes } from "./routes/run-tasks";
import { oauthClientRoutes } from "./routes/oauth-clients";
import { notificationRoutes } from "./routes/notifications";
import { mcpRoutes } from "./routes/mcp";
import { sshKeyRoutes } from "./routes/ssh-keys";
import { githubAppInstallationRoutes } from "./routes/github-app-installations";
import { miscRoutes } from "./routes/misc";
import { assessmentRoutes } from "./routes/assessments";
import { changeRequestRoutes } from "./routes/change-requests";
import { policyEvaluationRoutes } from "./routes/policy-evaluations";
import { workspaceTransferRoutes } from "./routes/workspace-transfers";
import { planExportRoutes } from "./routes/plan-exports";
import { cidrRangeRoutes } from "./routes/cidr-ranges";
import { queryRoutes } from "./routes/queries";
import { avatarHandler } from "./routes/avatars";
import { scimRoutes } from "./routes/scim";
import { explorerRoutes } from "./routes/explorer";
import { teamProjectRoutes } from "./routes/team-projects";
import { organizationRoleRoutes } from "./routes/organization-roles";
import { samlRoutes } from "./routes/saml";
import { oidcRoutes } from "./routes/oidc";
import { availableVersions } from "./binaryManager";

// Store request metadata without polluting the set object
const requestMeta = new WeakMap<Request, { startTime: number; method: string; path: string }>();

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
  set: Readonly<{ status: number }>;
}>;

type ErrorContext = Readonly<{
  code: string;
  error: unknown;
  set: SetObject;
}>;

type PasswordGuardContext = Readonly<{
  request: CustomRequest;
  user?: Readonly<{ mustChangePassword?: boolean }> | null;
  set: SetObject;
}>;

type RateLimitServer = Readonly<{
  readonly requestIP?: (request: CustomRequest) => Readonly<{ readonly address?: string }> | null;
}>;

/** Parse a positive-integer env override, falling back to the default. */
function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const RATE_LIMIT_MAX = envPositiveInt("RATE_LIMIT_MAX", 30);
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
// The five SSO endpoints are sensitive no matter the verb: the protected GETs
// mutate challenge state and the POSTs consume assertion/form-post payloads.
// Share one set so path matching and rate limiting never drift apart.
const SSO_AUTH_PATHS = new Set([
  "/users/oidc/auth",
  "/users/oidc/callback",
  "/users/saml/auth",
  "/users/saml/logout",
  "/users/saml/slo",
]);
const sensitivePaths = new Set([
  "/admin/initial-admin-user",
  "/api/v2/tokens",
  "/api/v2/users",
  "/api/v2/users/login",
  "/oauth/authorization",
  "/oauth/token",
  ...SSO_AUTH_PATHS,
]);

function fixedWindowContext(): RateLimitContext {
  const counts = new Map<string, number>();
  let duration = SENSITIVE_RATE_DURATION_MS;
  let resetAt = Date.now() + duration;

  const resetExpiredWindow = (): void => {
    if (Date.now() < resetAt) return;
    counts.clear();
    resetAt = Date.now() + duration;
  };

  return {
    init(options): void {
      duration = options.duration;
      resetAt = Date.now() + duration;
    },
    increment(key): { count: number; nextReset: Date } {
      resetExpiredWindow();
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { count, nextReset: new Date(resetAt) };
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

function ipRateLimitKey(request: CustomRequest, server: RateLimitServer | null): string {
  // When the admin has opted into trusting forwarded headers (behind Cloudflare
  // etc.), key rate limits on the real client IP instead of the proxy peer.
  const trusted = syncedTrustedClientIp(request);
  if (trusted !== null && trusted !== "") return `ip:${trusted}`;
  const directAddress = typeof server?.requestIP === "function"
    ? server.requestIP(request)?.address
    : undefined;
  const forwardedAddress = server === null
    ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    : undefined;
  // app.handle() has no socket address; isolate those requests unless a test
  // explicitly supplies a simulated client address.
  const address = directAddress ?? forwardedAddress ?? crypto.randomUUID();
  return `ip:${address}`;
}

function principalRateLimitKey(request: CustomRequest, server: RateLimitServer | null): string {
  return authenticatedRateLimitKey(request) ?? ipRateLimitKey(request, server);
}

function sensitiveSsoPath(request: CustomRequest): string | undefined {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && SSO_AUTH_PATHS.has(path)) return path;
  return undefined;
}

function scimSettingsPath(request: CustomRequest): string | undefined {
  const path = new URL(request.url).pathname;
  if (path !== "/api/v2/admin/scim-settings") return undefined;
  return request.method === "GET" || request.method === "PATCH" || request.method === "DELETE" ? path : undefined;
}

function scimMappingPath(request: CustomRequest): string | undefined {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") return undefined;
  return /^\/api\/v2\/admin\/teams\/[^/]+\/scim-group-mapping$/.test(path) ? path : undefined;
}

function sensitivePath(request: CustomRequest): string | undefined {
  const path = new URL(request.url).pathname;
  if (request.method === "PATCH" && path === "/api/v2/account/password") return path;
  if (request.method !== "POST") return undefined;
  if (sensitivePaths.has(path)) return path;
  if (/^\/api\/v2\/notification-configurations\/[^/]+\/actions\/verify$/.test(path)) {
    return "/api/v2/notification-configurations/*/actions/verify";
  }
  if (
    /^\/api\/v2\/(?:agent-pools|teams)\/[^/]+\/authentication-tokens?$/.test(path)
    || /^\/api\/v2\/organizations\/[^/]+\/authentication-token$/.test(path)
  ) {
    return "/api/v2/*/authentication-tokens";
  }
  return undefined;
}

export const app = new Elysia()
  .use(authPlugin)
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
    generator: (request: CustomRequest, server: Readonly<{ readonly requestIP?: (req: CustomRequest) => Readonly<{ readonly address?: string }> | null }> | null): string => {
      return principalRateLimitKey(request, server);
    },
  }))
  .use(rateLimit({
    context: fixedWindowContext(),
    duration: SENSITIVE_RATE_DURATION_MS,
    max: SENSITIVE_RATE_LIMIT,
    generator: (request: CustomRequest, server: RateLimitServer | null): string => {
      return `sensitive:${sensitivePath(request) ?? "unknown"}:${principalRateLimitKey(request, server)}`;
    },
    responseMessage: {
      errors: [{
        detail: "You have exceeded the API's rate limit.",
        status: "429",
        title: "Too Many Requests",
      }],
    },
    skip: (request: CustomRequest): boolean => sensitivePath(request) === undefined,
  }))
  .use(rateLimit({
    context: fixedWindowContext(),
    duration: SENSITIVE_RATE_DURATION_MS,
    max: SSO_GET_RATE_LIMIT,
    generator: (request: CustomRequest, server: RateLimitServer | null): string => {
      return `sso-get:${sensitiveSsoPath(request) ?? "unknown"}:${principalRateLimitKey(request, server)}`;
    },
    responseMessage: {
      errors: [{
        detail: "You have exceeded the API's rate limit.",
        status: "429",
        title: "Too Many Requests",
      }],
    },
    skip: (request: CustomRequest): boolean => sensitiveSsoPath(request) === undefined,
  }))
  .use(rateLimit({
    context: fixedWindowContext(),
    duration: 1_000,
    max: SCIM_SETTINGS_RATE_LIMIT,
    generator: (request: CustomRequest, server: RateLimitServer | null): string => {
      return `scim-settings:${scimSettingsPath(request) ?? "unknown"}:${principalRateLimitKey(request, server)}`;
    },
    responseMessage: {
      errors: [{
        detail: "You have exceeded the API's rate limit.",
        status: "429",
        title: "Too Many Requests",
      }],
    },
    skip: (request: CustomRequest): boolean => scimSettingsPath(request) === undefined,
  }))
  // Both SCIM limiters use the process-local fixedWindowContext store, so they
  // enforce per-instance bounds: single-node deployments get the documented
  // limits, multi-replica deployments should account for the worker count
  // (each replica carries its own window).
  .use(rateLimit({
    context: fixedWindowContext(),
    duration: 60_000,
    max: SCIM_MAPPING_RATE_LIMIT,
    generator: (request: CustomRequest, server: RateLimitServer | null): string => {
      return `scim-mapping:${principalRateLimitKey(request, server)}`;
    },
    responseMessage: {
      errors: [{
        detail: "You have exceeded the API's rate limit.",
        status: "429",
        title: "Too Many Requests",
      }],
    },
    skip: (request: CustomRequest): boolean => scimMappingPath(request) === undefined,
  }))
  .use(oauthPlugin)
  .onRequest(({ request, set }: RequestContext): void => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    requestMeta.set(request as unknown as Request, { startTime: Date.now(), method, path: pathname });

    const headers = set.headers as Record<string, string | number>;
    // CORS: never emit a hardcoded allow-origin fallback (a blanket
    // http://localhost:5173 previously exposed the API to any localhost page).
    // If CORS_ORIGIN is set (comma-separated allow-list) we reflect only an
    // Origin that matches it. Otherwise, in non-production builds we reflect a
    // Vite dev Origin explicitly — no origin, no CORS header.
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
    headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    headers["Access-Control-Expose-Headers"] = "TFP-API-Version,X-RateLimit-Limit,X-RateLimit-Remaining";
  })
  .onAfterHandle(({ request, response, set }: AfterHandleContext): void => {
    const meta = requestMeta.get(request as unknown as Request);
    if (meta !== undefined) {
      const duration = Date.now() - meta.startTime;
      const method = meta.method;
      const path = meta.path;
      const status = set.status ?? 200;
      if (path.startsWith("/api/")) {
        log.info(`[${new Date().toISOString()}] ${method} ${path} ${String(status)} ${duration}ms`);
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
      const existingVary = headers["Vary"];
      headers["Vary"] = existingVary === undefined ? "Origin" : `${String(existingVary)}, Origin`;
    }

    if ((pathname === "/api" || pathname.startsWith("/api/")) && isJsonDocument) {
      headers["Content-Type"] = "application/vnd.api+json";
    }
    const limit = set.headers["RateLimit-Limit"];
    const remaining = set.headers["RateLimit-Remaining"];
    if (limit !== undefined) headers["X-RateLimit-Limit"] = limit;
    if (remaining !== undefined) headers["X-RateLimit-Remaining"] = remaining;
  })
  .onParse(async ({ request, contentType }: ParseContext): Promise<Record<string, unknown> | string | null | undefined> => {
    if (new URL(request.url).pathname === "/api/webhooks/github") {
      return request.text();
    }
    if (contentType === "application/vnd.api+json") {
      const text = await request.text();
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
        request: request as { headers: Headers },
        set: set as { status: number | string; headers: Record<string, string | number> },
      });
    }
    const isApiPath = pathname === "/api" || pathname.startsWith("/api/");
    if (isApiPath) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (pathname === "/login" || pathname.startsWith("/app")) return;
    const filePath = join(FRONTEND_DIR, pathname);
    if (filePath.startsWith(FRONTEND_DIR) && await Bun.file(filePath).exists()) {
      return new Response(Bun.file(filePath));
    }
  })
  .options("/*", ({ set }: OptionsContext): Record<string, never> => {
    (set as { status: number }).status = 204;
    return {};
  })
  .onError(({ code, error, set, request }: ErrorContext & { request: { url: string } }): { errors: { status: string; title: string; detail?: string }[] } | string | undefined => {
    const mutableSet = set as { status?: number | string; headers: Record<string, string | number> };
    const pathname = new URL(request.url).pathname;
    if (code === "NOT_FOUND") {
      if (!(pathname === "/api" || pathname.startsWith("/api/"))) {
        mutableSet.status = 404;
        mutableSet.headers["Content-Type"] = "text/plain";
        return "Not Found";
      }
      mutableSet.headers["Content-Type"] = "application/vnd.api+json";
      mutableSet.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    mutableSet.headers["Content-Type"] = "application/vnd.api+json";
    mutableSet.status = 500;
    const detail = typeof error === "object" && error !== null && "message" in error
      ? String((error as Record<string, unknown>).message)
      : "An unexpected error occurred";
    return {
      errors: [{
        status: "500",
        title: "Internal Server Error",
        detail,
      }],
    };
  })
  // Route modules
  .use(healthRoutes)
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
  .use(systemAdminRoutes)
  .use(policyRoutes)
  .use(permissionSimulatorRoutes)
  .use(agentRoutes)
  .use(runTaskRoutes)
  .use(oauthClientRoutes)
  .use(notificationRoutes)
  .use(mcpRoutes)
  .use(sshKeyRoutes)
  .use(githubAppInstallationRoutes)
  .use(miscRoutes)
  .use(assessmentRoutes)
  .use(changeRequestRoutes)
  .use(workspaceTransferRoutes)
  .use(planExportRoutes)
  .use(cidrRangeRoutes)
  .use(queryRoutes)
  .use(scimRoutes)
  .use(explorerRoutes)
  .use(teamProjectRoutes)
  .use(organizationRoleRoutes)
  .use(samlRoutes)
  .use(oidcRoutes)
  .use(policyEvaluationRoutes);

// Start the background worker queue. Deferred out of module evaluation:
// ./db/index.ts is a top-level-await module, and the dynamic import weave
// can fire this before `db` finishes initializing (TDZ ReferenceError that
// 500s every request in worker-thread test runs). A 0ms timer guarantees
// the module graph has fully evaluated before the first poll.
setTimeout((): void => {
  import("./worker").then(({ startWorkerQueue }: { startWorkerQueue: () => void }): void => {
    startWorkerQueue();
    log.info("Worker queue started");
  }).catch((error: unknown): void => {
    log.error("Failed to start worker queue", { error: String(error) });
  });
}, 0);
