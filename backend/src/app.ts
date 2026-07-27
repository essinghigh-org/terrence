import { Elysia } from "elysia";
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

export const app = new Elysia()
  .use(authPlugin)
  .use(rateLimit({
    max: 30,
    duration: 1000,
    generator: (request: Request, server: unknown): string => {
      const authHeader = request.headers.get("authorization");
      const bearer = authHeader !== null ? authHeader.replace(/^Bearer /, "") : undefined;
      if (bearer !== undefined) {
        return `token:${Bun.hash(bearer)}`;
      }
      const srv = server as { requestIP?: (req: Request) => { address?: string } | null } | null;
      return `ip:${srv?.requestIP?.(request)?.address ?? "unknown"}`;
    },
  }))
  .use(oauthPlugin)
  .onRequest(({ request, set }): void => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    requestMeta.set(request, { startTime: Date.now(), method, path: pathname });

    const allowOrigin = process.env.CORS_ORIGIN ?? (process.env.NODE_ENV === "production" ? undefined : "*");
    if (allowOrigin !== undefined) {
      set.headers["Access-Control-Allow-Origin"] = allowOrigin;
    }
    set.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    set.headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    set.headers["Access-Control-Expose-Headers"] = "TFP-API-Version,X-RateLimit-Limit,X-RateLimit-Remaining";
  })
  .onAfterHandle(({ request, response, set }): void => {
    const meta = requestMeta.get(request);
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
    if (new URL(request.url).pathname.startsWith("/api/") && isJsonDocument) {
      set.headers["Content-Type"] = "application/vnd.api+json";
    }
    const limit: string | undefined = set.headers["RateLimit-Limit"];
    const remaining: string | undefined = set.headers["RateLimit-Remaining"];
    if (limit !== undefined) set.headers["X-RateLimit-Limit"] = limit;
    if (remaining !== undefined) set.headers["X-RateLimit-Remaining"] = remaining;
  })
  .onParse(async ({ request, contentType }): Promise<Record<string, unknown> | null | undefined> => {
    if (contentType === 'application/vnd.api+json') {
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
    prefix: ""
  }))
  .get("/login", serveFrontend)
  .get("/register", serveFrontend)
  .get("/app", serveFrontend)
  .get("/app/*", serveFrontend)
  .options("/*", ({ set }): Record<string, never> => {
    set.status = 204;
    return {};
  })
  .onError(({ code, error, set }): { errors: { status: string; title: string; detail?: string }[] } => {
    const s = set as { headers: Record<string, string | number>; status: number };
    s.headers["Content-Type"] = "application/vnd.api+json";
    if (code === "NOT_FOUND") {
      s.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    s.status = 500;
    const detail = typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "An unexpected error occurred";
    return {
      errors: [{
        status: "500",
        title: "Internal Server Error",
        detail
      }]
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
