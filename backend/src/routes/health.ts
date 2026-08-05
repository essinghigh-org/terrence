import { Elysia } from "elysia";
import { db } from "../db";
import { organizations, runs, users, workspaces } from "../db/schema";
import { count } from "drizzle-orm";
import { authPlugin } from "../auth";
import { probeLandlockAbi, runSandboxRequired } from "../lib/sandbox";
import { log } from "../lib/log";
import { ssoSettingsSnapshot } from "../lib/sso";

type SetCtx = Readonly<{ set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }> }>;
type UserSetCtx = Readonly<{ user: unknown; set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }> }>;
type MetricsCtx = Readonly<{
  request: Readonly<{ url: string }>;
  set: Readonly<{ headers: Readonly<Record<string, string | number>> }>;
}>;

const PING_SSO_CACHE_TTL_MS = 1_000;
type PingSsoSnapshot = Awaited<ReturnType<typeof ssoSettingsSnapshot>>;
let pingSsoCache: Readonly<{ value: PingSsoSnapshot; expiresAt: number }> | undefined;
let pingSsoLastKnown: PingSsoSnapshot | undefined;
let pingSsoCacheGeneration = 0;
let pingSsoInFlight: Readonly<{ generation: number; promise: Promise<PingSsoSnapshot> }> | undefined;
let pingSsoErrorUntil = 0;

export function invalidatePingSsoCache(): void {
  pingSsoCacheGeneration += 1;
  pingSsoCache = undefined;
  pingSsoErrorUntil = 0;
}

async function pingSsoSnapshot(): Promise<PingSsoSnapshot> {
  const now = Date.now();
  if (pingSsoCache !== undefined && pingSsoCache.expiresAt > now) return pingSsoCache.value;
  // Negative-cache a failed read for the same TTL: while the marker is valid,
  // serve the last known snapshot instead of hammering the database.
  if (pingSsoErrorUntil > now && pingSsoLastKnown !== undefined) return pingSsoLastKnown;
  // A burst of /api/v2/ping probes (the Login page and the login API both hit
  // it on load) must not each start a fresh settings read: share the in-flight
  // lookup and cache the first result. An in-flight lookup belongs to the
  // generation it started in; after an invalidation a fresh read is required
  // even if a stale request is still pending.
  if (pingSsoInFlight !== undefined && pingSsoInFlight.generation === pingSsoCacheGeneration) {
    return pingSsoInFlight.promise;
  }
  const generation = pingSsoCacheGeneration;
  pingSsoInFlight = { generation, promise: ssoSettingsSnapshot() };
  try {
    const value = await pingSsoInFlight.promise;
    if (generation === pingSsoCacheGeneration) {
      pingSsoCache = { value, expiresAt: Date.now() + PING_SSO_CACHE_TTL_MS };
      pingSsoLastKnown = value;
      pingSsoErrorUntil = 0;
    }
    return value;
  } catch (error: unknown) {
    if (generation === pingSsoCacheGeneration) {
      pingSsoErrorUntil = Date.now() + PING_SSO_CACHE_TTL_MS;
    }
    throw error;
  } finally {
    if (pingSsoInFlight?.generation === generation) pingSsoInFlight = undefined;
  }
}

function metricValue(rows: readonly Readonly<{ value: number }>[] | undefined): number {
  return rows?.[0]?.value ?? 0;
}

function prometheusLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

async function readinessResponse(set: SetCtx["set"]): Promise<unknown> {
  let dbOk = true;
  try {
    await db.query.users.findFirst();
  } catch {
    dbOk = false;
  }
  const status = dbOk ? "OK" : "ERROR";
  if (!dbOk) (set as { status: number }).status = 503;
  return {
    node: "terrence-node-1",
    status,
    checks: [
      { check: "database", status: dbOk ? "OK" : "ERROR" },
      { check: "disk", status: "OK" },
      { check: "task-worker", status: "OK" },
      { check: "archivist", status: "OK" },
    ],
  };
}

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
  .get("/api/v2/ping", async ({ set }: SetCtx): Promise<unknown> => {
    const headers = set.headers as Record<string, string | number>;
    headers["TFP-API-Version"] = "2.5";
    headers["TFP-AppName"] = "Terraform Enterprise";
    headers["TFE-Version"] = "2.4.0";
    headers["X-TFE-Version"] = "v202410-1";
    headers["X-TFE-Current-Version"] = "2.4.0";
    let sso;
    try {
      sso = await pingSsoSnapshot();
    } catch (error: unknown) {
      log.error("Unable to read SSO configuration for ping", { error: error instanceof Error ? error.message : String(error) });
      const lastKnown = pingSsoLastKnown;
      return {
        "signup-enabled": process.env.TERRENCE_ENABLE_LOCAL_SIGNUP === "true",
        "local-auth-enabled": lastKnown?.localAuthEnabled ?? true,
        sso: {
          saml: lastKnown?.samlEnabled ?? false,
          oidc: lastKnown?.oidcEnabled ?? false,
          ldap: lastKnown?.ldapEnabled ?? false,
        },
      };
    }
    return {
      "signup-enabled": process.env.TERRENCE_ENABLE_LOCAL_SIGNUP === "true",
      "local-auth-enabled": sso.localAuthEnabled,
      sso: { saml: sso.samlEnabled, oidc: sso.oidcEnabled, ldap: sso.ldapEnabled },
    };
  })
  .get("/api/v2/meta", (): {
    data: {
      "run-sandbox": {
        enabled: boolean;
        available: boolean;
        abi: number;
        reason: string | null;
        docs: string;
      };
    };
  } => {
    const sandboxRequired = runSandboxRequired();
    const abi = probeLandlockAbi();
    let reason: string | null = null;
    if (abi < 1) {
      reason = process.env.TERRENCE_LANDLOCK_RUNNER
        ? "landlock-runner missing or Landlock not enabled in the kernel"
        : "Landlock is not available on this kernel (needs Linux >= 5.13 with CONFIG_SECURITY_LANDLOCK)";
    }
    return {
      data: {
        "run-sandbox": {
          enabled: sandboxRequired,
          available: abi >= 1,
          abi,
          reason,
          docs: "https://docs.kernel.org/userspace-api/landlock.html",
        },
      },
    };
  })
  .get("/healthz", (): string => "ok")
  .get("/metrics", async ({ request, set }: MetricsCtx): Promise<unknown> => {
    const [userCount, organizationCount, workspaceCount, runCount, runsByStatus] = await Promise.all([
      db.select({ value: count() }).from(users),
      db.select({ value: count() }).from(organizations),
      db.select({ value: count() }).from(workspaces),
      db.select({ value: count() }).from(runs),
      db.select({ status: runs.status, value: count() }).from(runs).groupBy(runs.status),
    ]);
    const metrics = {
      terrence_users_total: metricValue(userCount),
      terrence_organizations_total: metricValue(organizationCount),
      terrence_workspaces_total: metricValue(workspaceCount),
      terrence_runs_total: metricValue(runCount),
      tfe_run_current_count: Object.fromEntries(runsByStatus.map((row): [string, number] => [row.status, row.value])),
    };
    if (new URL(request.url).searchParams.get("format") !== "prometheus") return { metrics };

    const headers = set.headers as Record<string, string | number>;
    headers["Content-Type"] = "text/plain; version=0.0.4; charset=utf-8";
    const lines = [
      "# HELP terrence_users_total Registered users.",
      "# TYPE terrence_users_total gauge",
      `terrence_users_total ${metrics.terrence_users_total}`,
      "# HELP terrence_organizations_total Organizations.",
      "# TYPE terrence_organizations_total gauge",
      `terrence_organizations_total ${metrics.terrence_organizations_total}`,
      "# HELP terrence_workspaces_total Workspaces.",
      "# TYPE terrence_workspaces_total gauge",
      `terrence_workspaces_total ${metrics.terrence_workspaces_total}`,
      "# HELP terrence_runs_total Runs.",
      "# TYPE terrence_runs_total gauge",
      `terrence_runs_total ${metrics.terrence_runs_total}`,
      "# HELP tfe_run_current_count Current runs by status.",
      "# TYPE tfe_run_current_count gauge",
      ...runsByStatus.map((row): string =>
        `tfe_run_current_count{status="${prometheusLabel(row.status)}"} ${row.value}`,
      ),
    ];
    return `${lines.join("\n")}\n`;
  })
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
  .get("/api/v1/health/readiness", async ({ set }: SetCtx): Promise<unknown> => readinessResponse(set))
  .get("/api/v1/nodes/readiness", async ({ set }: SetCtx): Promise<unknown> => readinessResponse(set))
  .get("/api/v1/metadata", (): { version: string; build: string } => ({
    version: process.env.BUILD_VERSION ?? "dev",
    build: process.env.BUILD_SHA ?? "unknown",
  }));
