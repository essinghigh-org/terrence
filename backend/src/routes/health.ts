import { Elysia } from "elysia";
import { db } from "../db";
import { authPlugin } from "../auth";
import { probeLandlockAbi, runSandboxRequired } from "../lib/sandbox";
import { log } from "../lib/log";
import { ssoSettingsSnapshot } from "../lib/sso";
import { currentTokenScopes } from "../lib/request-scope";
import {
  collectLegacyMetrics,
  collectScopedMetrics,
  type AgentPoolMetrics,
  type MetricsCollection,
} from "../lib/metrics";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// Single source of truth for the reported application version:
// BUILD_VERSION env wins, otherwise the root package.json version,
// otherwise "dev". Read once at first call and cached; a missing or
// unparseable package.json must never crash the metadata endpoint.
let cachedAppVersion: string | undefined;
export function appVersion(): string {
  if (cachedAppVersion !== undefined) return cachedAppVersion;
  const fromEnv = process.env.BUILD_VERSION;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    cachedAppVersion = fromEnv;
    return cachedAppVersion;
  }
  try {
    const parsed = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim() !== "") {
      cachedAppVersion = parsed.version.trim();
      return cachedAppVersion;
    }
  } catch {
    // fall through to "dev"
  }
  cachedAppVersion = "dev";
  return cachedAppVersion;
}

type SetCtx = Readonly<{ set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }> }>;
type UserSetCtx = Readonly<{ user: unknown; set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }> }>;
type MetricsCtx = Readonly<{
  request: Readonly<{ url: string }>;
  set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
  user: Readonly<{ id: string }> | null;
  token: Readonly<{ id: string }> | null;
  orgId: string | null;
  teamId: string | null;
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

function prometheusLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

function poolLabels(pool: AgentPoolMetrics): string {
  return `pool_id="${prometheusLabel(pool.id)}",pool="${prometheusLabel(pool.name)}",org="${prometheusLabel(pool.orgId)}"`;
}

/** JSON representation: instance counters (legacy) or org breakdown (scoped). */
function collectionToJson(collection: MetricsCollection): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  if (collection.instance !== null) {
    metrics.terrence_users_total = collection.instance.users;
    metrics.terrence_organizations_total = collection.instance.organizations;
    metrics.terrence_workspaces_total = collection.instance.workspaces;
    metrics.terrence_runs_total = collection.instance.runs;
    metrics.tfe_run_current_count = collection.instance.runsByStatus;
    metrics.terrence_database_size_bytes = collection.instance.database.sizeBytes;
    metrics.terrence_database_wal_size_bytes = collection.instance.database.walSizeBytes;
    metrics.terrence_database_page_count = collection.instance.database.pageCount;
  }
  if (collection.orgs !== null) {
    metrics.organizations = collection.orgs.map((org): Record<string, unknown> => ({
      org_id: org.orgId,
      workspaces: org.workspaces,
      runs_by_status: org.runsByStatus,
    }));
  }
  metrics.terrence_agent_pools_total = collection.agentPoolsTotal;
  metrics.agent_pools = collection.agentPools.map((pool): Record<string, unknown> => ({
    id: pool.id,
    name: pool.name,
    org_id: pool.orgId,
    agents_by_status: pool.agentsByStatus,
    agents_stale: pool.staleAgents,
    jobs_queued: pool.jobsQueued,
    jobs_claimed: pool.jobsClaimed,
    jobs_errored: pool.jobsErrored,
    oldest_queued_wait_seconds: pool.oldestQueuedWaitSeconds,
  }));
  return metrics;
}

/** Prometheus text format; agent queue-depth gauges are per-pool. */
function prometheusLines(collection: MetricsCollection): string[] {
  const lines: string[] = [];
  const instance = collection.instance;
  if (instance !== null) {
    lines.push(
      "# HELP terrence_users_total Registered users.",
      "# TYPE terrence_users_total gauge",
      `terrence_users_total ${instance.users}`,
      "# HELP terrence_organizations_total Organizations.",
      "# TYPE terrence_organizations_total gauge",
      `terrence_organizations_total ${instance.organizations}`,
      "# HELP terrence_workspaces_total Workspaces.",
      "# TYPE terrence_workspaces_total gauge",
      `terrence_workspaces_total ${instance.workspaces}`,
      "# HELP terrence_runs_total Runs.",
      "# TYPE terrence_runs_total gauge",
      `terrence_runs_total ${instance.runs}`,
      "# HELP tfe_run_current_count Current runs by status.",
      "# TYPE tfe_run_current_count gauge",
      ...Object.entries(instance.runsByStatus).map(([status, value]): string =>
        `tfe_run_current_count{status="${prometheusLabel(status)}"} ${value}`,
      ),
      "# HELP terrence_database_size_bytes Database file size on disk.",
      "# TYPE terrence_database_size_bytes gauge",
      `terrence_database_size_bytes ${instance.database.sizeBytes}`,
      "# HELP terrence_database_wal_size_bytes Database WAL sidecar size on disk.",
      "# TYPE terrence_database_wal_size_bytes gauge",
      `terrence_database_wal_size_bytes ${instance.database.walSizeBytes ?? 0}`,
      "# HELP terrence_database_page_count Database pages.",
      "# TYPE terrence_database_page_count gauge",
      `terrence_database_page_count ${instance.database.pageCount}`,
    );
  }
  if (collection.orgs !== null) {
    lines.push(
      "# HELP terrence_org_workspaces_total Workspaces visible to the caller per org.",
      "# TYPE terrence_org_workspaces_total gauge",
      ...collection.orgs.map((org): string =>
        `terrence_org_workspaces_total{org="${prometheusLabel(org.orgId)}"} ${org.workspaces}`,
      ),
      "# HELP tfe_run_current_count Current runs visible to the caller by org and status.",
      "# TYPE tfe_run_current_count gauge",
      ...collection.orgs.flatMap((org): string[] =>
        Object.entries(org.runsByStatus).map(([status, value]): string =>
          `tfe_run_current_count{org="${prometheusLabel(org.orgId)}",status="${prometheusLabel(status)}"} ${value}`,
        ),
      ),
    );
  }
  lines.push(
    "# HELP terrence_agent_pools_total Agent pools visible to the caller.",
    "# TYPE terrence_agent_pools_total gauge",
    `terrence_agent_pools_total ${collection.agentPoolsTotal}`,
    "# HELP terrence_agents_total Agents by pool and status.",
    "# TYPE terrence_agents_total gauge",
  );
  for (const pool of collection.agentPools) {
    for (const [status, value] of Object.entries(pool.agentsByStatus)) {
      lines.push(`terrence_agents_total{${poolLabels(pool)},status="${prometheusLabel(status)}"} ${value}`);
    }
    lines.push(
      "# HELP terrence_agents_stale_total Agents with a heartbeat older than the configured timeout.",
      "# TYPE terrence_agents_stale_total gauge",
      `terrence_agents_stale_total{${poolLabels(pool)}} ${pool.staleAgents}`,
      "# HELP terrence_agent_jobs_queued_total Agent jobs waiting for a worker (queue depth).",
      "# TYPE terrence_agent_jobs_queued_total gauge",
      `terrence_agent_jobs_queued_total{${poolLabels(pool)}} ${pool.jobsQueued}`,
      "# HELP terrence_agent_jobs_claimed_total Agent jobs currently claimed by a worker.",
      "# TYPE terrence_agent_jobs_claimed_total gauge",
      `terrence_agent_jobs_claimed_total{${poolLabels(pool)}} ${pool.jobsClaimed}`,
      "# HELP terrence_agent_jobs_errored_total Agent jobs that ended in error.",
      "# TYPE terrence_agent_jobs_errored_total gauge",
      `terrence_agent_jobs_errored_total{${poolLabels(pool)}} ${pool.jobsErrored}`,
      "# HELP terrence_agent_queue_oldest_wait_seconds Age of the oldest job still waiting for a worker.",
      "# TYPE terrence_agent_queue_oldest_wait_seconds gauge",
      `terrence_agent_queue_oldest_wait_seconds{${poolLabels(pool)}} ${pool.oldestQueuedWaitSeconds}`,
    );
  }
  return lines;
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
  .get("/metrics", async ({ request, set, user, orgId, teamId }: MetricsCtx): Promise<unknown> => {
    // Token-authenticated. Legacy tokens (scopes null) get instance-wide
    // metrics; fine-grained tokens get only the org/workspace/agent data
    // their scope is eligible for (enforced inside the collectors).
    const scopes = currentTokenScopes();
    const collection = scopes === null
      ? await collectLegacyMetrics()
      : await collectScopedMetrics(scopes, user?.id, orgId, teamId);

    const format = new URL(request.url).searchParams.get("format");
    if (format !== "prometheus") {
      return { metrics: collectionToJson(collection) };
    }

    const headers = set.headers as Record<string, string | number>;
    headers["Content-Type"] = "text/plain; version=0.0.4; charset=utf-8";
    return `${prometheusLines(collection).join("\n")}\n`;
  }, { isAuth: true })
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
    version: appVersion(),
    build: process.env.BUILD_SHA ?? "unknown",
  }))
  .get("/api/meta/ip-ranges", (): { api: string[]; notifications: string[]; sentinel: string[]; vcs: string[] } => ({
    // Terrence has no fixed public egress ranges to advertise, so return empty
    // arrays rather than placeholder (TEST-NET or RFC1918) CIDRs that would
    // mislead users into whitelisting ranges the service never uses.
    api: [],
    notifications: [],
    sentinel: [],
    vcs: [],
  }));
