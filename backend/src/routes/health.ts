import { Elysia } from "elysia";
import { db } from "../db";
import { authPlugin } from "../auth";

export const healthRoutes = new Elysia({ name: "health" })
  .use(authPlugin)
  .get("/.well-known/terraform.json", (): Record<string, unknown> => ({
    "login.v1": {
      client: "terraform-cli",
      grant_types: ["authz_code"],
      authz: "/oauth/authorization",
      token: "/oauth/token",
      ports: [10000, 10010],
    },
    "tfe.v2": "/api/v2/",
    "tfe.v2.1": "/api/v2/",
    "tfe.v2.2": "/api/v2/",
    "state.v2": "/api/v2/",
    "modules.v1": "/api/registry/v1/modules/",
    "providers.v1": "/api/registry/v1/providers/",
  }))
  .get("/api", (): string => "Terrence API")
  .get("/api/v2/ping", ({ set }): Record<string, never> => {
    set.headers["TFP-API-Version"] = "2.5";
    set.headers["TFP-AppName"] = "Terraform Enterprise";
    return {};
  })
  .get("/healthz", (): string => "ok")
  .get("/readyz", async ({ set }): Promise<string> => {
    try {
      await db.query.users.findFirst();
      return "ready";
    } catch {
      set.status = 503;
      return "not ready";
    }
  })
  .get("/api/v1/ping", ({ user, set }): string | { errors: { status: string; title: string }[] } => {
    if (user === null || user === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    return "pong";
  })
  .get("/api/v1/readiness", async ({ set }): Promise<{ status: string }> => {
    try {
      await db.query.users.findFirst();
      return { status: "ready" };
    } catch {
      set.status = 503;
      return { status: "not_ready" };
    }
  })
  .get("/api/v1/health/readiness", async ({ set }): Promise<{ status: string }> => {
    try {
      await db.query.users.findFirst();
      return { status: "ready" };
    } catch {
      set.status = 503;
      return { status: "not_ready" };
    }
  })
  .get("/api/v1/metadata", (): { version: string; build: string } => ({
    version: process.env.BUILD_VERSION ?? "dev",
    build: process.env.BUILD_SHA ?? "unknown",
  }));
