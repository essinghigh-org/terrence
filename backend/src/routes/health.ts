import { Elysia } from "elysia";
import { db } from "../db";
import { authPlugin } from "../auth";

type SetCtx = Readonly<{ set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }> }>;
type UserSetCtx = Readonly<{ user: unknown; set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }> }>;

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
  .get("/api/v2/ping", ({ set }: SetCtx): Record<string, never> => {
    const headers = set.headers as Record<string, string | number>;
    headers["TFP-API-Version"] = "2.5";
    headers["TFP-AppName"] = "Terraform Enterprise";
    return {};
  })
  .get("/healthz", (): string => "ok")
  .get("/readyz", async ({ set }: SetCtx): Promise<string> => {
    try {
      await db.query.users.findFirst();
      return "ready";
    } catch {
      (set as { status: number }).status = 503;
      return "not ready";
    }
  })
  .get("/api/v1/ping", ({ user, set }: UserSetCtx): string | { errors: { status: string; title: string }[] } => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    return "pong";
  })
  .get("/api/v1/readiness", async ({ set }: SetCtx): Promise<{ status: string }> => {
    try {
      await db.query.users.findFirst();
      return { status: "ready" };
    } catch {
      (set as { status: number }).status = 503;
      return { status: "not_ready" };
    }
  })
  .get("/api/v1/health/readiness", async ({ set }: SetCtx): Promise<{ status: string }> => {
    try {
      await db.query.users.findFirst();
      return { status: "ready" };
    } catch {
      (set as { status: number }).status = 503;
      return { status: "not_ready" };
    }
  })
  .get("/api/v1/metadata", (): { version: string; build: string } => ({
    version: process.env.BUILD_VERSION ?? "dev",
    build: process.env.BUILD_SHA ?? "unknown",
  }));
