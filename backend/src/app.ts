import { Elysia, type BunFile } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit } from "elysia-rate-limit";
import { join } from "path";
import { authPlugin } from "./auth";
import { oauthPlugin } from "./oauth";
import { log } from "./lib/log";

const FRONTEND_INDEX = join(import.meta.dir, "../../frontend/dist/index.html");
const serveFrontend = (): BunFile => Bun.file(FRONTEND_INDEX);

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
import { registryRoutes } from "./routes/registry";
import { adminRoutes } from "./routes/admin";
import { policyRoutes } from "./routes/policies";
import { agentRoutes } from "./routes/agents";
import { runTaskRoutes } from "./routes/run-tasks";
import { oauthClientRoutes } from "./routes/oauth-clients";
import { notificationRoutes } from "./routes/notifications";
import { sshKeyRoutes } from "./routes/ssh-keys";
import { miscRoutes } from "./routes/misc";

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

export const app = new Elysia()
  .use(authPlugin)
  .use(rateLimit({
    max: 30,
    duration: 1000,
    generator: (request: CustomRequest, server: Readonly<{ readonly requestIP?: (req: CustomRequest) => Readonly<{ readonly address?: string }> | null }>): string => {

      const authHeader = request.headers.get("authorization");
      const bearer = authHeader !== null ? authHeader.replace(/^Bearer /, "") : undefined;
      if (bearer !== undefined) {
        return `token:${Bun.hash(bearer)}`;
      }
      return `ip:${server.requestIP?.(request)?.address ?? "unknown"}`;
    },
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
  .onParse(async ({ request, contentType }: ParseContext): Promise<Record<string, unknown> | null | undefined> => {
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
    assets: "../frontend/dist",
    prefix: "",
  }))
  .get("/login", serveFrontend)
  .get("/register", serveFrontend)
  .get("/app", serveFrontend)
  .get("/app/*", serveFrontend)
  .options("/*", ({ set }: OptionsContext): Record<string, never> => {
    (set as { status: number }).status = 204;
    return {};
  })
  .onError(({ code, error, set }: ErrorContext): { errors: { status: string; title: string; detail?: string }[] } => {
    const mutableSet = set as { status?: number | string; headers: Record<string, string | number> };
    mutableSet.headers["Content-Type"] = "application/vnd.api+json";
    if (code === "NOT_FOUND") {
      mutableSet.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
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
  .use(registryRoutes)
  .use(adminRoutes)
  .use(policyRoutes)
  .use(agentRoutes)
  .use(runTaskRoutes)
  .use(oauthClientRoutes)
  .use(notificationRoutes)
  .use(sshKeyRoutes)
  .use(miscRoutes);
