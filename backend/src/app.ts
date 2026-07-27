import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit } from "elysia-rate-limit";
import { join } from "path";
import { authPlugin } from "./auth";
import { oauthPlugin } from "./oauth";
import { startWorkerQueue } from "./worker";
import { log } from "./lib/log";

// Initialize persistent worker queue loop
startWorkerQueue();

const FRONTEND_INDEX = join(import.meta.dir, "../../frontend/dist/index.html");
const serveFrontend = () => Bun.file(FRONTEND_INDEX);

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

export const app = new Elysia()
  .use(authPlugin)
  .use(rateLimit({
    max: 30,
    duration: 1000,
    generator: async (request, server) => {
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (bearer) {
        return `token:${Bun.hash(bearer)}`;
      }
      return `ip:${server?.requestIP(request)?.address || "unknown"}`;
    },
  }))
  .use(oauthPlugin)
  .onRequest(({ request, set }) => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    (set as any).__startTime = Date.now();
    (set as any).__method = method;
    (set as any).__path = pathname;

    const allowOrigin = process.env.CORS_ORIGIN || (process.env.NODE_ENV === "production" ? undefined : "*");
    if (allowOrigin) {
      set.headers["Access-Control-Allow-Origin"] = allowOrigin;
    }
    set.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    set.headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    set.headers["Access-Control-Expose-Headers"] = "TFP-API-Version,X-RateLimit-Limit,X-RateLimit-Remaining";
  })
  .onAfterHandle(({ request, response, set }) => {
    const startTime = (set as any).__startTime as number | undefined;
    if (startTime) {
      const duration = Date.now() - startTime;
      const method = (set as any).__method || request.method;
      const path = (set as any).__path || new URL(request.url).pathname;
      const status = set.status || 200;
      if (path.startsWith("/api/")) {
        log.info(`[${new Date().toISOString()}] ${method} ${path} ${status} ${duration}ms`);
      }
    }
    const isJsonDocument = response !== null
      && typeof response === "object"
      && (Array.isArray(response) || Object.getPrototypeOf(response) === Object.prototype);
    if (new URL(request.url).pathname.startsWith("/api/") && isJsonDocument) {
      set.headers["Content-Type"] = "application/vnd.api+json";
    }
    const limit = set.headers["RateLimit-Limit"];
    const remaining = set.headers["RateLimit-Remaining"];
    if (limit) set.headers["X-RateLimit-Limit"] = limit;
    if (remaining) set.headers["X-RateLimit-Remaining"] = remaining;
  })
  .onParse(async ({ request, contentType }) => {
    if (contentType === 'application/vnd.api+json') {
      const text = await request.text();
      try {
        return JSON.parse(text);
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
  .options("/*", ({ set }) => {
    set.status = 204;
  })
  .onError(({ code, error, set }) => {
    set.headers["Content-Type"] = "application/vnd.api+json";
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    set.status = 500;
    return {
      errors: [{
        status: "500",
        title: "Internal Server Error",
        detail: error.message || "An unexpected error occurred"
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
