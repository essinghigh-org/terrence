import { Elysia } from "elysia";
import { db } from "../db";
import { authPlugin } from "../auth";
import { probeLandlockAbi, runSandboxRequired } from "../lib/sandbox";
import { envEnabled } from "../lib/env";
import { log } from "../lib/log";
import { ssoSettingsSnapshot } from "../lib/sso";
import { isStorageDegraded } from "../lib/storage-health";
import { currentTokenScopes } from "../lib/request-scope";
import {
  collectLegacyMetrics,
  collectScopedMetrics,
  type AgentPoolMetrics,
  type MetricsCollection,
} from "../lib/metrics";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { eq, desc, gte } from "drizzle-orm";
import { controlPlaneNodes } from "../db/schema";
import { systemAuthError, systemRateLimited } from "../lib/system-api";
import { maintenanceSnapshot } from "../lib/maintenance";
import { COMPATIBILITY_VERSION, TFP_API_VERSION } from "../lib/constants";

// Single source of truth for the reported application version:
// BUILD_VERSION env wins, otherwise the root package.json version,
// otherwise "dev". Read once at first call and cached; a missing or
// unparseable package.json must never crash the metadata endpoint.
let cachedAppVersion: string | undefined;
const NODE_HEARTBEAT_INTERVAL_MS = 10_000;
const NODE_HEARTBEAT_TIMEOUT_MS = 45_000;
let nodeHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
export function appVersion(): string {
  if (cachedAppVersion !== undefined) return cachedAppVersion;
  const fromEnv = process.env["BUILD_VERSION"];
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
type MetricsCtx = Readonly<{
  request: Readonly<{ url: string }>;
  set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
  user: Readonly<{ id: string; isSiteAdmin?: boolean | null }> | null;
  token: Readonly<{ id: string }> | null;
  orgId: string | null;
  teamId: string | null;
  systemToken?: Readonly<{ id: string }> | null;
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
    metrics["terrence_users_total"] = collection.instance.users;
    metrics["terrence_organizations_total"] = collection.instance.organizations;
    metrics["terrence_workspaces_total"] = collection.instance.workspaces;
    metrics["terrence_runs_total"] = collection.instance.runs;
    metrics["tfe_run_current_count"] = collection.instance.runsByStatus;
    metrics["terrence_database_size_bytes"] = collection.instance.database.sizeBytes;
    metrics["terrence_database_wal_size_bytes"] = collection.instance.database.walSizeBytes;
    metrics["terrence_database_page_count"] = collection.instance.database.pageCount;
    metrics["terrence_database_cache_size_bytes"] = collection.instance.database.cacheSizeBytes;
    metrics["terrence_database_freelist_bytes"] = collection.instance.database.freelistBytes;
    // DB pool observation (todos 289,290,291): pending depth, latency p50/p95.
    metrics["terrence_database_pool"] = collection.instance.database.pool;
    // VCS webhook delivery queue (todo 192-194).
    metrics["terrence_webhook_queue"] = {
      queued: collection.instance.webhookQueue.queued,
      processing: collection.instance.webhookQueue.processing,
      failed: collection.instance.webhookQueue.failed,
      oldest_pending_seconds: collection.instance.webhookQueue.oldestPendingSeconds,
    };
  }
  if (collection.process !== null) {
    const { snapshot, history } = collection.process;
    metrics["terrence_process_rss_bytes"] = snapshot.rss;
    metrics["terrence_process_max_rss_bytes"] = snapshot.maxRss;
    metrics["terrence_process_heap_total_bytes"] = snapshot.heapTotal;
    metrics["terrence_process_heap_used_bytes"] = snapshot.heapUsed;
    metrics["terrence_process_external_bytes"] = snapshot.external;
    metrics["terrence_process_array_buffers_bytes"] = snapshot.arrayBuffers;
    metrics["terrence_process_uptime_seconds"] = snapshot.uptimeSeconds;
    metrics["terrence_process_cpu_seconds"] = { user: snapshot.userCpuSeconds, system: snapshot.systemCpuSeconds };
    metrics["terrence_requests"] = {
      total: snapshot.requests.total,
      in_flight: snapshot.requests.inFlight,
      errors5xx: snapshot.requests.errors5xx,
    };
    metrics["terrence_failures"] = { ...snapshot.failures };
    metrics["terrence_storage_degraded"] = isStorageDegraded() ? 1 : 0;
    metrics["terrence_worker"] = {
      polls: snapshot.worker.polls,
      last_poll_at: snapshot.worker.lastPollAt,
      last_poll_duration_ms: snapshot.worker.lastPollDurationMs,
      last_poll_ok: snapshot.worker.lastPollOk,
      pollers: Object.fromEntries(Object.entries(snapshot.worker.pollers).map(([name, stats]): [string, Record<string, number | boolean | null>] => [name, {
        runs: stats.runs,
        errors: stats.errors,
        last_duration_ms: stats.lastDurationMs,
        last_ok: stats.lastOk,
      }])),
    };
    metrics["terrence_process_history"] = {
      interval_ms: history.intervalMs,
      max_samples: history.maxSamples,
      samples: history.samples.map((sample): Record<string, number> => ({
        at: sample.at,
        rss: sample.rss,
        heap_used: sample.heapUsed,
        requests_in_flight: sample.requestsInFlight,
        worker_polls: sample.workerPolls,
      })),
      stats: {
        rss: {
          min: history.stats.rss.min,
          max: history.stats.rss.max,
          latest: history.stats.rss.latest,
          growth_per_hour: history.stats.rss.growthPerHour,
        },
        heap_used: {
          min: history.stats.heapUsed.min,
          max: history.stats.heapUsed.max,
          latest: history.stats.heapUsed.latest,
          growth_per_hour: history.stats.heapUsed.growthPerHour,
        },
      },
    };
  }
  if (collection.orgs !== null) {
    metrics["organizations"] = collection.orgs.map((org): Record<string, unknown> => ({
      org_id: org.orgId,
      workspaces: org.workspaces,
      runs_by_status: org.runsByStatus,
    }));
  }
  metrics["terrence_agent_pools_total"] = collection.agentPoolsTotal;
  metrics["agent_pools"] = collection.agentPools.map((pool): Record<string, unknown> => ({
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
      "# HELP terrence_database_cache_size_bytes Database page-cache budget (sqlite PRAGMA cache_size; null on postgres).",
      "# TYPE terrence_database_cache_size_bytes gauge",
      "# HELP terrence_database_freelist_bytes Database freelist pages in bytes (sqlite bloat signal; null on postgres).",
      "# TYPE terrence_database_freelist_bytes gauge",
      // VCS webhook delivery queue gauges (todo 192-194).
      "# HELP terrence_webhook_queue_depth VCS webhook deliveries waiting or in-flight, by state.",
      "# TYPE terrence_webhook_queue_depth gauge",
      `terrence_webhook_queue_depth{state="queued"} ${instance.webhookQueue.queued}`,
      `terrence_webhook_queue_depth{state="processing"} ${instance.webhookQueue.processing}`,
      "# HELP terrence_webhook_failed_total VCS webhook deliveries dead-lettered after repeated failure.",
      "# TYPE terrence_webhook_failed_total gauge",
      `terrence_webhook_failed_total ${instance.webhookQueue.failed}`,
      "# HELP terrence_webhook_oldest_pending_seconds Age of the oldest delivery not yet processed.",
      "# TYPE terrence_webhook_oldest_pending_seconds gauge",
      `terrence_webhook_oldest_pending_seconds ${instance.webhookQueue.oldestPendingSeconds}`,
    );
    // Backend-specific samples are omitted when the value is unavailable
    // (postgres has no sqlite page cache/freelist) rather than emitting 0.
    if (instance.database.cacheSizeBytes !== null) {
      lines.push(`terrence_database_cache_size_bytes ${instance.database.cacheSizeBytes}`);
    }
    if (instance.database.freelistBytes !== null) {
      lines.push(`terrence_database_freelist_bytes ${instance.database.freelistBytes}`);
    }
    // DB pool (todos 289,290,291)
    {
      const p = instance.database.pool;
      lines.push(
        "# HELP terrence_database_pool_pending Queries currently waiting or executing.",
        "# TYPE terrence_database_pool_pending gauge",
        `terrence_database_pool_pending{driver="${p.driver}"} ${p.pendingQueries}`,
        "# HELP terrence_database_pool_exhausted_total Queries that arrived while another was pending (contention signal).",
        "# TYPE terrence_database_pool_exhausted_total counter",
        `terrence_database_pool_exhausted_total ${p.queriesExhausted}`,
        "# HELP terrence_database_query_duration_ms Observed query/transaction latency (recent window).",
        "# TYPE terrence_database_query_duration_ms gauge",
        `terrence_database_query_duration_ms{quantile="0.5"} ${p.p50Ms ?? 0}`,
        `terrence_database_query_duration_ms{quantile="0.95"} ${p.p95Ms ?? 0}`,
        `terrence_database_query_duration_ms{quantile="max"} ${p.maxMs ?? 0}`,
      );
      const fps = (instance.database as unknown as { slowFingerprints?: Readonly<Record<string, number>> }).slowFingerprints ?? {};
      const fpLines = Object.entries(fps).slice(0, 10).map(([fp, count]): string =>
        `terrence_database_slow_fingerprint_total{fingerprint="${prometheusLabel(fp)}"} ${count}`,
      );
      if (fpLines.length > 0) {
        lines.push(
          "# HELP terrence_database_slow_fingerprint_total Normalized slow-query fingerprint occurrences.",
          "# TYPE terrence_database_slow_fingerprint_total counter",
          ...fpLines,
        );
      }
    }
  }
  // Global latch: emitted for every collection shape (scoped tokens too).
  if (isStorageDegraded()) {
    lines.push(
      "# HELP terrence_storage_degraded Storage degraded (disk full) latched; applies are paused and readiness reports 503.",
      "# TYPE terrence_storage_degraded gauge",
      "terrence_storage_degraded 1",
    );
  }
  if (collection.process !== null) {
    const { snapshot, history } = collection.process;
    lines.push(
      "# HELP terrence_process_rss_bytes Resident set size (process memory actually held).",
      "# TYPE terrence_process_rss_bytes gauge",
      `terrence_process_rss_bytes ${snapshot.rss}`,
      "# HELP terrence_process_max_rss_bytes Peak RSS observed by the OS scheduler.",
      "# TYPE terrence_process_max_rss_bytes gauge",
      `terrence_process_max_rss_bytes ${snapshot.maxRss}`,
      "# HELP terrence_process_heap_used_bytes jsc heap used (informational in Bun; rss is authoritative).",
      "# TYPE terrence_process_heap_used_bytes gauge",
      `terrence_process_heap_used_bytes ${snapshot.heapUsed}`,
      "# HELP terrence_process_external_bytes Memory attributed to external allocations.",
      "# TYPE terrence_process_external_bytes gauge",
      `terrence_process_external_bytes ${snapshot.external}`,
      "# HELP terrence_process_uptime_seconds Process uptime.",
      "# TYPE terrence_process_uptime_seconds gauge",
      `terrence_process_uptime_seconds ${snapshot.uptimeSeconds}`,
      "# HELP terrence_process_cpu_seconds_total Process CPU time by kind (user/system).",
      "# TYPE terrence_process_cpu_seconds_total counter",
      `terrence_process_cpu_seconds_total{kind="user"} ${snapshot.userCpuSeconds}`,
      `terrence_process_cpu_seconds_total{kind="system"} ${snapshot.systemCpuSeconds}`,
      "# HELP terrence_requests_total API requests started since boot.",
      "# TYPE terrence_requests_total counter",
      `terrence_requests_total ${snapshot.requests.total}`,
      "# HELP terrence_requests_in_flight API requests currently being handled.",
      "# TYPE terrence_requests_in_flight gauge",
      `terrence_requests_in_flight ${snapshot.requests.inFlight}`,
      "# HELP terrence_requests_errors5xx_total Responses with status >= 500.",
      "# TYPE terrence_requests_errors5xx_total counter",
      `terrence_requests_errors5xx_total ${snapshot.requests.errors5xx}`,
      "# HELP terrence_failures_total Best-effort subsystem write failures (audit log, run logs).",
      "# TYPE terrence_failures_total counter",
      ...Object.entries(snapshot.failures).map(([kind, value]): string =>
        `terrence_failures_total{kind="${prometheusLabel(kind)}"} ${value}`,
      ),
      "# HELP terrence_worker_polls_total Background queue poll cycles since boot.",
      "# TYPE terrence_worker_polls_total counter",
      `terrence_worker_polls_total ${snapshot.worker.polls}`,
      "# HELP terrence_worker_last_poll_ok Whether the last poll cycle completed without an uncaught error.",
      "# TYPE terrence_worker_last_poll_ok gauge",
      "# HELP terrence_worker_last_poll_duration_ms Duration of the last poll cycle.",
      "# TYPE terrence_worker_last_poll_duration_ms gauge",
      "# HELP terrence_worker_poller_runs_total Poll cycles completed by poller.",
      "# TYPE terrence_worker_poller_runs_total counter",
      "# HELP terrence_worker_poller_errors_total Poll cycles that ended in error, by poller.",
      "# TYPE terrence_worker_poller_errors_total counter",
      "# HELP terrence_process_history_rss_growth_per_hour RSS linear-regression slope over the sample window (bytes/hour; leak detector).",
      "# TYPE terrence_process_history_rss_growth_per_hour gauge",
      "# HELP terrence_process_history_samples Samples currently held in the ring buffer.",
      "# TYPE terrence_process_history_samples gauge",
      `terrence_process_history_samples ${history.samples.length}`,
    );
    // Time-dependent samples are omitted before the first poll/history
    // window exists (a 0 would read as a real measurement).
    if (snapshot.worker.lastPollOk !== null) {
      lines.push(`terrence_worker_last_poll_ok ${snapshot.worker.lastPollOk ? 1 : 0}`);
    }
    if (snapshot.worker.lastPollDurationMs !== null) {
      lines.push(`terrence_worker_last_poll_duration_ms ${snapshot.worker.lastPollDurationMs}`);
    }
    if (history.stats.rss.growthPerHour !== null) {
      lines.push(`terrence_process_history_rss_growth_per_hour ${history.stats.rss.growthPerHour}`);
    }
    for (const [poller, stats] of Object.entries(snapshot.worker.pollers)) {
      const label = `poller="${prometheusLabel(poller)}"`;
      lines.push(
        `terrence_worker_poller_runs_total{${label}} ${stats.runs}`,
        `terrence_worker_poller_errors_total{${label}} ${stats.errors}`,
      );
    }
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
    // Per-pool families: emit HELP/TYPE exactly once (Prometheus text format
    // requires a single metadata line per family), then one sample line per
    // pool. The pool label set is identical for every family so grouping the
    // samples by family keeps the output deterministic.
    "# HELP terrence_agents_stale_total Agents with a heartbeat older than the configured timeout.",
    "# TYPE terrence_agents_stale_total gauge",
    "# HELP terrence_agent_jobs_queued_total Agent jobs waiting for a worker (queue depth).",
    "# TYPE terrence_agent_jobs_queued_total gauge",
    "# HELP terrence_agent_jobs_claimed_total Agent jobs currently claimed by a worker.",
    "# TYPE terrence_agent_jobs_claimed_total gauge",
    "# HELP terrence_agent_jobs_errored_total Agent jobs that ended in error.",
    "# TYPE terrence_agent_jobs_errored_total gauge",
    "# HELP terrence_agent_queue_oldest_wait_seconds Age of the oldest job still waiting for a worker.",
    "# TYPE terrence_agent_queue_oldest_wait_seconds gauge",
  );
  for (const pool of collection.agentPools) {
    for (const [status, value] of Object.entries(pool.agentsByStatus)) {
      lines.push(`terrence_agents_total{${poolLabels(pool)},status="${prometheusLabel(status)}"} ${value}`);
    }
    lines.push(
      `terrence_agents_stale_total{${poolLabels(pool)}} ${pool.staleAgents}`,
      `terrence_agent_jobs_queued_total{${poolLabels(pool)}} ${pool.jobsQueued}`,
      `terrence_agent_jobs_claimed_total{${poolLabels(pool)}} ${pool.jobsClaimed}`,
      `terrence_agent_jobs_errored_total{${poolLabels(pool)}} ${pool.jobsErrored}`,
      `terrence_agent_queue_oldest_wait_seconds{${poolLabels(pool)}} ${pool.oldestQueuedWaitSeconds}`,
    );
  }
  return lines;
}

export const readinessNodeId = (): string => process.env["TERRENCE_NODE_ID"] ?? "terrence-node-1";

async function readinessResponse(
  set: SetCtx["set"],
  timeoutSeconds: number,
  request?: Readonly<{ headers: Readonly<{ get: (name: string) => string | null }> }>,
  persistNode = false,
): Promise<ReadinessResult | Response> {
  const timeout = timeoutSeconds * 1000;
  // Clear the fallback timer once the database query settles: Promise.race
  // resolves as soon as either side completes, but an un-cleared setTimeout
  // stays armed for the full window and holds its closure. Readiness is
  // polled by load balancers and the heartbeat loop, so stray timers would
  // accumulate.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const database = await Promise.race([
    db.query.users.findFirst().then((): "OK" => "OK").catch((): "ERROR" => "ERROR"),
    new Promise<"ERROR">((resolve): void => {
      timer = setTimeout((): void => { resolve("ERROR"); }, timeout);
    }),
  ]).finally((): void => {
    if (timer !== undefined) clearTimeout(timer);
  });
  const disk = isStorageDegraded() ? "ERROR" : "OK";
  const worker = envEnabled(process.env["TERRENCE_DISABLE_WORKER"]) ? "ERROR" : "OK";
  // Todo 64: fail readiness when operator policy demands a newer Landlock ABI than the host provides.
  const sandboxMinAbi = (() => {
    const raw = process.env["TERRENCE_SANDBOX_MIN_ABI"];
    if (raw === undefined || raw.trim() === "") return null;
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  })();
  const sandboxAbiStatus: "OK" | "ERROR" =
    sandboxMinAbi !== null && probeLandlockAbi() < sandboxMinAbi ? "ERROR" : "OK";
  const maintenance = maintenanceSnapshot();
  const draining = maintenance.active || ["draining", "maintenance"].includes((process.env["TERRENCE_NODE_STATUS"] ?? "").toLowerCase());
  const status =
    database === "ERROR" || disk === "ERROR" || sandboxAbiStatus === "ERROR"
      ? "ERROR"
      : draining
        ? "DRAINING"
        : "OK";
  if (status !== "OK") (set as { status: number }).status = 503;

  const result: ReadinessResult = {
    node: readinessNodeId(),
    status,
    checks: [
      { check: "archivist", status: "OK" },
      { check: "atlas", status: "OK" },
      { check: "database", status: database },
      { check: "disk", status: disk },
      { check: "redis", status: "OK" },
      { check: "task-worker", status: worker },
      { check: "run-sandbox", status: sandboxAbiStatus },
      { check: "vault", status: "OK" },
    ],
  };
  // Todo 271: include the bundled DB schema target alongside the
  // database liveness check so /api/v1/readiness and /readyz agree.
  // This is the packaged target; the applied state lives in the DB's
  // `__drizzle_migrations` history (see databaseSchemaVersion()).
  try {
    const { databaseSchemaVersion } = await import("../db");
    const schemaVersion = databaseSchemaVersion();
    if (schemaVersion !== null) result.checks.push({ check: "database-schema", status: schemaVersion });
  } catch { /* journal missing on fresh boot is not readiness failure */ }
  // Only the heartbeat path persists the node row. Every readiness probe
  // responding on load-balancer or orchestrator intervals would otherwise
  // write the row on each request for zero freshness gain (the heartbeat
  // already refreshes it every 10s). Swallow nothing either: a failing
  // upsert must not silently let the node disappear from /api/v1/nodes.
  if (database === "OK" && persistNode) {
    const now = Date.now();
    await db.insert(controlPlaneNodes).values({
      id: readinessNodeId(),
      hostname: readinessNodeId(),
      address: process.env["TERRENCE_NODE_ADDRESS"] ?? null,
      version: appVersion(),
      status: status === "ERROR" ? "error" : draining ? "draining" : "active",
      readinessChecks: result.checks,
      registeredAt: now,
      lastHeartbeatAt: now,
    }).onConflictDoUpdate({
      target: controlPlaneNodes.id,
      set: {
        hostname: readinessNodeId(),
        address: process.env["TERRENCE_NODE_ADDRESS"] ?? null,
        version: appVersion(),
        status: status === "ERROR" ? "error" : draining ? "draining" : "active",
        readinessChecks: result.checks,
        lastHeartbeatAt: now,
      },
    }).catch((error: unknown): void => {
      log.warn("Unable to record control-plane node heartbeat", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const accept = request?.headers.get("accept") ?? "";
  const plainText = accept.split(",").some((value): boolean => {
    const mediaType = value.split(";")[0]?.trim().toLowerCase();
    return mediaType === "text/plain" || mediaType === "text/html";
  });
  if (plainText) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(set.headers)) headers.set(key, String(value));
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(status, { status: set.status === undefined ? 200 : Number(set.status), headers });
  }
  return result;
}

type ReadinessResult = {
  node: string;
  status: string;
  checks: { check: string; status: string }[];
};

export async function markControlPlaneNodeDraining(): Promise<void> {
  await db.update(controlPlaneNodes).set({
    status: "draining",
    lastHeartbeatAt: Date.now(),
  }).where(eq(controlPlaneNodes.id, readinessNodeId())).catch((): void => undefined);
}

export function startControlPlaneHeartbeat(): void {
  if (nodeHeartbeatTimer !== undefined) return;
  const heartbeat = async (): Promise<void> => {
    const set = { headers: {} as Record<string, string | number> };
    await readinessResponse(set, 1, undefined, true).catch((): void => undefined);
  };
  void heartbeat();
  nodeHeartbeatTimer = setInterval((): void => { void heartbeat(); }, NODE_HEARTBEAT_INTERVAL_MS);
  nodeHeartbeatTimer.unref?.();
}

function readinessTimeout(request: Readonly<{ url: string }>, fallback: number): number | null {
  const raw = new URL(request.url).searchParams.get("timeout");
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= 30 ? value : null;
}

type SystemHealthContext = Readonly<{
  set: SetCtx["set"];
  systemToken?: Readonly<{ id: string }> | null;
  token?: unknown;
  user?: unknown;
  orgId?: unknown;
  teamId?: unknown;
  run?: unknown;
}>;

const systemHealthGuard = ({ systemToken, token, user, orgId, teamId, run, set }: SystemHealthContext): Record<string, unknown> | undefined => {
  const authError = systemAuthError({ systemToken, token, user, orgId, teamId, run }, set as { status?: number; headers: Record<string, string | number> });
  if (authError !== undefined) return authError;
  if (systemToken !== null && systemToken !== undefined
    && systemRateLimited(systemToken.id, set as { status?: number; headers: Record<string, string | number> })) {
    (set as { status: number }).status = 429;
    return { errors: [{ status: "429", title: "Too Many Requests" }] };
  }
  return undefined;
};

export const systemHealthRoutes = new Elysia({ name: "system-health" })
  .use(authPlugin)
  .onBeforeHandle(systemHealthGuard)
  .get("/api/v1/ping", (): string => "pong")
  .get("/api/v1/readiness", async ({ set, request }: SetCtx & { request: Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }> }): Promise<unknown> => {
    const timeout = readinessTimeout(request, 1);
    if (timeout === null) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "timeout must be an integer from 1 to 30" }] }; }
    return readinessResponse(set, timeout, request);
  })
  .get("/api/v1/health/readiness", async ({ set, request }: SetCtx & { request: Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }> }): Promise<unknown> => {
    const timeout = readinessTimeout(request, 1);
    if (timeout === null) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "timeout must be an integer from 1 to 30" }] }; }
    return readinessResponse(set, timeout, request);
  })
  .get("/api/v1/nodes/readiness", async ({ set, request }: SetCtx & { request: Readonly<{ url: string }> }): Promise<unknown> => {
    const timeout = readinessTimeout(request, 5);
    if (timeout === null) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "timeout must be an integer from 1 to 30" }] }; }
    const current = await readinessResponse(set, timeout);
    if (current instanceof Response) throw new Error("Unexpected plain-text readiness response");
    const nodes = await db.query.controlPlaneNodes.findMany({
      where: gte(controlPlaneNodes.lastHeartbeatAt, Date.now() - NODE_HEARTBEAT_TIMEOUT_MS),
      orderBy: [desc(controlPlaneNodes.registeredAt)],
    }).catch(() => []);
    const byId = new Map(nodes.map((node): [string, typeof node] => [node.id, node]));
    byId.set(readinessNodeId(), {
      id: readinessNodeId(), hostname: readinessNodeId(), address: process.env["TERRENCE_NODE_ADDRESS"] ?? null,
      version: appVersion(), status: String(current.status).toLowerCase(), readinessChecks: current.checks,
      registeredAt: Date.now(), lastHeartbeatAt: Date.now(),
    });
    return {
      data: [...byId.values()].map((node): Record<string, unknown> => ({
        id: node.id,
        type: "nodes",
        attributes: {
          status: node.id === readinessNodeId() ? current.status : (node.status === "error" ? "ERROR" : node.status === "draining" ? "DRAINING" : "OK"),
          checks: node.id === readinessNodeId() ? current.checks : node.readinessChecks,
        },
      })),
      links: { self: "/api/v1/nodes/readiness" },
    };
  })
  .get("/api/v1/metadata", (): { version: string; build: string } => ({
    version: appVersion(),
    build: process.env["BUILD_SHA"] ?? "unknown",
  }))
  .get("/api/v1/nodes", async (): Promise<{ data: { id: string; type: "nodes" }[]; links: { self: string } }> => {
    const nodes = await db.query.controlPlaneNodes.findMany({
      where: gte(controlPlaneNodes.lastHeartbeatAt, Date.now() - NODE_HEARTBEAT_TIMEOUT_MS),
      orderBy: [desc(controlPlaneNodes.registeredAt)],
    }).catch(() => []);
    return {
      data: [...new Set([readinessNodeId(), ...nodes.map((node): string => node.id)])]
        .map((id): { id: string; type: "nodes" } => ({ id, type: "nodes" })),
      links: { self: "/api/v1/nodes" },
    };
  });

export const healthRoutes = new Elysia({ name: "health" })
  .use(authPlugin)
  // 459/460: programmatic capabilities + version-negotiation endpoint (TFE parity, also satisfies 463 docs premise).
  .get("/api/v2/capabilities", ({ set }: MetricsCtx): Record<string, unknown> => {
    const h = set.headers as Record<string, string | number>;
    h["TFP-API-Version"] = TFP_API_VERSION;
    h["TFE-Version"] = COMPATIBILITY_VERSION;
    h["X-TFE-Version"] = COMPATIBILITY_VERSION;
    const rateLimits = {
      general: { max: Number(process.env["RATE_LIMIT_MAX"] ?? 30), "window-ms": 1_000 },
      "workspace-run-history": { max: Number(process.env["RATE_LIMIT_WORKSPACE_RUN_HISTORY_MAX"] ?? 30), "window-ms": Number(process.env["RATE_LIMIT_WORKSPACE_RUN_HISTORY_DURATION_MS"] ?? 60_000) },
      sensitive: { max: Number(process.env["RATE_LIMIT_SENSITIVE_MAX"] ?? 5), "window-ms": 60_000 },
      "sso-get": { max: Number(process.env["RATE_LIMIT_SSO_GET_MAX"] ?? 60), "window-ms": 60_000 },
      "scim-settings": { max: Number(process.env["RATE_LIMIT_SCIM_SETTINGS_MAX"] ?? 20), "window-ms": 1_000 },
      "scim-mapping": { max: Number(process.env["RATE_LIMIT_SCIM_MAPPING_MAX"] ?? 10), "window-ms": 60_000 },
    };
    return {
      data: {
        id: "capabilities",
        type: "capabilities",
        attributes: {
          "tfe-version": COMPATIBILITY_VERSION,
          "tfp-api-version": TFP_API_VERSION,
          "minimum-client-version": null as string | null,
          "maximum-client-version": null as string | null,
          "rate-limits": rateLimits,
        },
        meta: { version: appVersion(), build: process.env["BUILD_SHA"] ?? "unknown" },
      },
    };
  })
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
    headers["TFP-API-Version"] = TFP_API_VERSION;
    // Note: we intentionally do NOT emit "TFP-AppName". That header's literal
    // value ("Terraform Enterprise") is a vendor trademark string some clients
    // read to distinguish HCP Terraform from Terraform Enterprise. It is not
    // required by the run/plan/apply or registry flows, and the documented
    // format states not all releases of the documented format include it. Omitting it keeps the
    // response free of vendor branding while preserving every functional
    // header. Terrence is an independent implementation and is not
    // affiliated with HashiCorp or its products.
    headers["TFE-Version"] = COMPATIBILITY_VERSION;
    headers["X-TFE-Version"] = COMPATIBILITY_VERSION;
    headers["X-TFE-Current-Version"] = COMPATIBILITY_VERSION;
    let sso;
    try {
      sso = await pingSsoSnapshot();
    } catch (error: unknown) {
      log.error("Unable to read SSO configuration for ping", { error: error instanceof Error ? error.message : String(error) });
      const lastKnown = pingSsoLastKnown;
      return {
        "signup-enabled": envEnabled(process.env["TERRENCE_ENABLE_LOCAL_SIGNUP"]),
        "local-auth-enabled": lastKnown?.localAuthEnabled ?? true,
        sso: {
          saml: lastKnown?.samlEnabled ?? false,
          oidc: lastKnown?.oidcEnabled ?? false,
          ldap: lastKnown?.ldapEnabled ?? false,
        },
      };
    }
    return {
      "signup-enabled": envEnabled(process.env["TERRENCE_ENABLE_LOCAL_SIGNUP"]),
      "local-auth-enabled": sso.localAuthEnabled,
      sso: { saml: sso.samlEnabled, oidc: sso.oidcEnabled, ldap: sso.ldapEnabled },
    };
  })
  .get("/api/v2/meta", ({ user, set }: MetricsCtx): {
    data: {
      id: string;
      type: "meta";
      attributes: {
        "run-sandbox": {
          enabled: boolean;
          available: boolean;
          abi: number;
          reason: string | null;
          "extra-rw-allowed": boolean;
          docs: string;
        };
      };
    };
  } | { errors: { status: string; title: string }[] } => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const sandboxRequired = runSandboxRequired();
    const abi = probeLandlockAbi();
    let reason: string | null = null;
    if (abi < 1) {
      reason = process.env["TERRENCE_LANDLOCK_RUNNER"]
        ? "landlock-runner missing or Landlock not enabled in the kernel"
        : "Landlock is not available on this kernel (needs Linux >= 5.13 with CONFIG_SECURITY_LANDLOCK)";
    }
    const extraRwAllowed = envEnabled(process.env["TERRENCE_SANDBOX_EXTRA_RW_ALLOWED"]);
    return {
      data: {
        id: "meta",
        type: "meta",
        attributes: {
          "run-sandbox": {
            enabled: sandboxRequired,
            available: abi >= 1,
            abi,
            reason,
            "extra-rw-allowed": extraRwAllowed,
            docs: "https://docs.kernel.org/userspace-api/landlock.html",
          },
        },
      },
    };
  })
  .get("/healthz", (): string => "ok")
  .get("/metrics", async ({ request, set, user, orgId, teamId, systemToken }: MetricsCtx): Promise<unknown> => {
    // Token-authenticated. Fine-grained tokens get only the org/workspace/
    // agent data their scope is eligible for. Instance-wide counters require
    // a dedicated System API token or an explicitly site-admin user.
    //
    // Instance-wide metrics are reserved for verified legacy API tokens,
    // System API tokens, and site admins. A browser-session access token
    // (issued by login, tracked in refresh_sessions) must not fall through
    // to the legacy collector even though it carries no scopes: that would
    // leak instance-wide counters to any logged-in UI user. Site-admin
    // session tokens ARE accepted (the admin UI has no other bearer to
    // present); ordinary session principals fail closed with 403.
    const scopes = currentTokenScopes();
    // The auth derive is global, so `user` is the full users row here.
    // currentSiteAdmin() can be unavailable on this plugin instance (the
    // request-cache hook lives on the main app), so read the row directly.
    const isSiteAdmin = (user as Readonly<{ isSiteAdmin?: boolean | null }> | null)?.isSiteAdmin === true;
    // A site admin's browser-session access token is an accepted credential
    // for instance-wide metrics: the UI cannot attach any other bearer to a
    // fetch, and the session already grants full administrative reach.
    // Ordinary (non-admin) session principals keep the fail-closed 403, as do
    // ordinary legacy API tokens — instance counters were never available to
    // them and the pinned test below keeps it that way.
    const allowInstanceMetrics = scopes === null
      && ((systemToken !== null && systemToken !== undefined) || (isSiteAdmin && user !== null && user !== undefined));

    const collection = scopes !== null
      ? await collectScopedMetrics(scopes, user?.id, orgId, teamId)
      : allowInstanceMetrics
        ? await collectLegacyMetrics()
        : null;

    if (collection === null) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Metrics require a bearer token with sufficient scope" }] };
    }

    const format = new URL(request.url).searchParams.get("format");
    if (format !== null && format !== "" && format !== "json" && format !== "prometheus") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "format must be 'json' or 'prometheus'" }] };
    }
    if (format !== "prometheus") {
      return { metrics: collectionToJson(collection) };
    }

    const headers = set.headers as Record<string, string | number>;
    headers["Content-Type"] = "text/plain; version=0.0.4; charset=utf-8";
    return `${prometheusLines(collection).join("\n")}\n`;
  }, { systemAuth: true })
  .get("/readyz", async ({ set }: SetCtx): Promise<string> => {
    try {
      await db.query.users.findFirst();
      if (isStorageDegraded()) {
        (set as { status: number }).status = 503;
        return "not ready: storage degraded";
      }
      // Todo 271: surface the applied DB schema version so operators can
      // verify rollout completeness (e.g. mixed-version fleet check).
      const { databaseSchemaVersion } = await import("../db");
      const schemaVersion = databaseSchemaVersion();
      return schemaVersion !== null ? `ready (schema ${schemaVersion})` : "ready";
    } catch {
      (set as { status: number }).status = 503;
      return "not ready";
    }
  })
  .get("/api/meta/ip-ranges", (): { api: string[]; notifications: string[]; sentinel: string[]; vcs: string[] } => ({
    // Terrence has no fixed public egress ranges to advertise, so return empty
    // arrays rather than placeholder (TEST-NET or RFC1918) CIDRs that would
    // mislead users into whitelisting ranges the service never uses.
    api: [],
    notifications: [],
    sentinel: [],
    vcs: [],
  }));
