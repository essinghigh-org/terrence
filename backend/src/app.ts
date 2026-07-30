import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit, type Context as RateLimitContext } from "elysia-rate-limit";
import { join } from "path";
import { authPlugin, authenticatedRateLimitKey } from "./auth";
import { oauthPlugin } from "./oauth";
import { log } from "./lib/log";

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
import { adminRoutes } from "./routes/admin";
import { scimAdminRoutes } from "./routes/scim-admin";
import { adminRegistrySharingRoutes } from "./routes/admin-registry-sharing";
import { systemAdminRoutes } from "./routes/system-admin";
import { policyRoutes } from "./routes/policies";
import { agentRoutes } from "./routes/agents";
import { runTaskRoutes } from "./routes/run-tasks";
import { oauthClientRoutes } from "./routes/oauth-clients";
import { notificationRoutes } from "./routes/notifications";
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
import { scimRoutes } from "./routes/scim";
import { explorerRoutes } from "./routes/explorer";
import { teamProjectRoutes } from "./routes/team-projects";

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

const SENSITIVE_RATE_LIMIT = 5;
const SENSITIVE_RATE_DURATION_MS = 60_000;
const sensitivePaths = new Set([
  "/admin/initial-admin-user",
  "/api/v2/tokens",
  "/api/v2/users",
  "/api/v2/users/login",
  "/oauth/authorization",
  "/oauth/token",
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
    max: 30,
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
  .use(oauthPlugin)
  .onRequest(({ request, set }: RequestContext): void => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    requestMeta.set(request as unknown as Request, { startTime: Date.now(), method, path: pathname });

    const headers = set.headers as Record<string, string | number>;
    const allowOrigin = process.env.CORS_ORIGIN ?? (process.env.NODE_ENV === "production" ? undefined : "*");
    if (allowOrigin !== undefined) {
      headers["Access-Control-Allow-Origin"] = allowOrigin;
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
    if (new URL(request.url).pathname.startsWith("/api/") && isJsonDocument) {
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
  .get("/login", serveFrontend)
  .get("/register", serveFrontend)
  .get("/app", serveFrontend)
  .get("/app/*", serveFrontend)
  .get("*", async ({ request }: { request: { url: string } }): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname.startsWith("/api/") || pathname === "/login" || pathname.startsWith("/app")) return;
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
      if (!pathname.startsWith("/api/")) {
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
  .use(adminRoutes)
  .use(scimAdminRoutes)
  .use(adminRegistrySharingRoutes)
  .use(systemAdminRoutes)
  .use(policyRoutes)
  .use(agentRoutes)
  .use(runTaskRoutes)
  .use(oauthClientRoutes)
  .use(notificationRoutes)
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
  .use(policyEvaluationRoutes);
