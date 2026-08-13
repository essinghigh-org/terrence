/**
 * Metrics collection for the /metrics endpoint (kanban 9.14 + instance
 * observability).
 *
 * Two visibility tiers:
 *
 * - Legacy tokens (scopes null) see INSTANCE-WIDE metrics: global user/org/
 *   workspace/run counts, database size, and every agent pool.
 * - Fine-grained tokens see ONLY the data their scope is eligible for:
 *   org-scoped workspace/run counts for orgs in scope.orgs (intersected with
 *   the user's own access), and agent-pool/queue metrics only when the scope
 *   grants `agent-pools:read`. Instance-wide counters are never exposed to a
 *   scoped token.
 *
 * Both tiers share the same per-pool collection: agents by status, stale
 * agent count (heartbeat timeout), queued/claimed/errored jobs, and the age
 * of the oldest queued job.
 */
import { db } from "../db";
import {
  agentJobs,
  agentPools,
  agents,
  organizations,
  runs,
  users,
  workspaces,
} from "../db/schema";
import { and, count, eq, inArray, min, type SQL } from "drizzle-orm";
import { databaseMetrics } from "../db";
import { configuredHeartbeatTimeoutMs } from "./agent-jobs";
import {
  checkOrganizationPermission,
  workspaceIdsForPermission,
} from "./utils";
import type { TokenScopes } from "./token-scopes";

export type AgentPoolMetrics = Readonly<{
  id: string;
  name: string;
  orgId: string;
  /** agents.status -> count ('idle' | 'busy' | 'exited' | 'errored' | 'unknown'). */
  agentsByStatus: Readonly<Record<string, number>>;
  /** Agents whose last heartbeat is older than the configured timeout. */
  staleAgents: number;
  jobsQueued: number;
  jobsClaimed: number;
  jobsErrored: number;
  /** Age in seconds of the oldest job still waiting for an agent; 0 when empty. */
  oldestQueuedWaitSeconds: number;
}>;

export type OrgMetrics = Readonly<{
  orgId: string;
  workspaces: number;
  runsByStatus: Readonly<Record<string, number>>;
}>;

export type MetricsCollection = Readonly<{
  /** True when the caller holds a legacy full-permission token. */
  legacy: boolean;
  /** Instance-wide counters; present only for legacy tokens. */
  instance: Readonly<{
    users: number;
    organizations: number;
    workspaces: number;
    runs: number;
    runsByStatus: Readonly<Record<string, number>>;
    database: Readonly<{
      sizeBytes: number;
      walSizeBytes: number | null;
      pageCount: number;
    }>;
  }> | null;
  /** Org-scoped workspace/run breakdown; present only for fine-grained tokens. */
  orgs: readonly OrgMetrics[] | null;
  /** Agent pool metrics; pools outside the caller's eligibility are excluded. */
  agentPools: readonly AgentPoolMetrics[];
  /** Total number of pools in the collection (equivalent to agentPools.length). */
  agentPoolsTotal: number;
}>;

function runsByStatusFrom(
  rows: readonly Readonly<{ status: string; value: number }>[],
): Record<string, number> {
  return Object.fromEntries(rows.map((row): [string, number] => [row.status, row.value]));
}

/** Aggregate agent pool metrics for the given pools, one query per shape. */
async function collectPoolMetrics(
  pools: readonly Readonly<{ id: string; name: string; orgId: string }>[],
): Promise<AgentPoolMetrics[]> {
  if (pools.length === 0) return [];
  const poolIds = pools.map((pool): string => pool.id);
  const now = Date.now();

  const [agentRows, jobRows, oldestRows] = await Promise.all([
    db.select({ agentPoolId: agents.agentPoolId, status: agents.status, lastPingAt: agents.lastPingAt })
      .from(agents)
      .where(inArray(agents.agentPoolId, poolIds)),
    db.select({ agentPoolId: agentJobs.agentPoolId, status: agentJobs.status, value: count() })
      .from(agentJobs)
      .where(and(
        inArray(agentJobs.agentPoolId, poolIds),
        inArray(agentJobs.status, ["queued", "claimed", "errored"] as const),
      ))
      .groupBy(agentJobs.agentPoolId, agentJobs.status),
    db.select({ agentPoolId: agentJobs.agentPoolId, oldest: min(agentJobs.createdAt) })
      .from(agentJobs)
      .where(and(
        inArray(agentJobs.agentPoolId, poolIds),
        eq(agentJobs.status, "queued"),
      ))
      .groupBy(agentJobs.agentPoolId),
  ]);

  const agentsByPool = new Map<string, Map<string, number>>();
  const staleByPool = new Map<string, number>();
  const staleCutoff = now - configuredHeartbeatTimeoutMs();
  for (const row of agentRows) {
    const byStatus = agentsByPool.get(row.agentPoolId) ?? new Map<string, number>();
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    agentsByPool.set(row.agentPoolId, byStatus);
    // An agent with a heartbeat older than the configured timeout is stale
    // regardless of its recorded status; the sweep flips idle/busy to
    // 'unknown' but the metric is time-based so it reflects the CURRENT
    // window even before the next sweep pass.
    const stale = row.lastPingAt === null || row.lastPingAt < staleCutoff;
    staleByPool.set(row.agentPoolId, (staleByPool.get(row.agentPoolId) ?? 0) + (stale ? 1 : 0));
  }
  const jobsByPool = new Map<string, Map<string, number>>();
  for (const row of jobRows) {
    const byStatus = jobsByPool.get(row.agentPoolId) ?? new Map<string, number>();
    byStatus.set(row.status, row.value);
    jobsByPool.set(row.agentPoolId, byStatus);
  }
  const oldestByPool = new Map(oldestRows.map((row): [string, number | null] => [row.agentPoolId, row.oldest ?? null]));

  return pools.map((pool): AgentPoolMetrics => {
    const byStatus = agentsByPool.get(pool.id) ?? new Map<string, number>();
    const byJobStatus = jobsByPool.get(pool.id) ?? new Map<string, number>();
    const oldest = oldestByPool.get(pool.id) ?? null;
    return {
      id: pool.id,
      name: pool.name,
      orgId: pool.orgId,
      agentsByStatus: Object.fromEntries(byStatus),
      // An agent whose last heartbeat predates the timeout is stale
      // regardless of recorded status; the sweep flips idle/busy to
      // 'unknown' but the metric is time-based so it reflects the CURRENT
      // window even before the next sweep pass.
      staleAgents: staleByPool.get(pool.id) ?? 0,
      jobsQueued: byJobStatus.get("queued") ?? 0,
      jobsClaimed: byJobStatus.get("claimed") ?? 0,
      jobsErrored: byJobStatus.get("errored") ?? 0,
      oldestQueuedWaitSeconds: oldest === null ? 0 : Math.max(0, Math.round((now - oldest) / 1000)),
    };
  });
}

/** Instance-wide metrics (legacy tokens only). */
export async function collectInstanceMetrics(): Promise<NonNullable<MetricsCollection["instance"]>> {
  const [userCount, organizationCount, workspaceCount, runCount, runsByStatus, database] = await Promise.all([
    db.select({ value: count() }).from(users),
    db.select({ value: count() }).from(organizations),
    db.select({ value: count() }).from(workspaces),
    db.select({ value: count() }).from(runs),
    db.select({ status: runs.status, value: count() }).from(runs).groupBy(runs.status),
    Promise.resolve(databaseMetrics()),
  ]);
  return {
    users: userCount[0]?.value ?? 0,
    organizations: organizationCount[0]?.value ?? 0,
    workspaces: workspaceCount[0]?.value ?? 0,
    runs: runCount[0]?.value ?? 0,
    runsByStatus: runsByStatusFrom(runsByStatus),
    database: {
      sizeBytes: database.sizeBytes,
      walSizeBytes: database.walSizeBytes,
      pageCount: database.pageCount,
    },
  };
}

/**
 * Collect metrics for a legacy token: instance-wide counters plus every
 * agent pool.
 */
export async function collectLegacyMetrics(): Promise<MetricsCollection> {
  const [instance, pools] = await Promise.all([
    collectInstanceMetrics(),
    db.select({ id: agentPools.id, name: agentPools.name, orgId: agentPools.orgId })
      .from(agentPools),
  ]);
  const agentPoolMetrics = await collectPoolMetrics(pools);
  return {
    legacy: true,
    instance,
    orgs: null,
    agentPools: agentPoolMetrics,
    agentPoolsTotal: agentPoolMetrics.length,
  };
}

/**
 * Collect metrics for a fine-grained token: org-scoped workspace/run
 * breakdowns and agent pool metrics, both restricted to what the scope (and
 * the underlying principal's access) permits. Instance-wide counters are
 * omitted.
 */
export async function collectScopedMetrics(
  scope: TokenScopes,
  userId: string | undefined,
  tokenOrgId: string | null | undefined,
  tokenTeamId: string | null | undefined,
): Promise<MetricsCollection> {
  const orgTokenId = tokenOrgId ?? null;
  const teamTokenId = tokenTeamId ?? null;
  const orgs: OrgMetrics[] = [];
  const pools: Readonly<{ id: string; name: string; orgId: string }>[] = [];

  for (const orgId of scope.orgs) {
    // read-workspaces eligibility: scope org coverage + grant + principal access.
    const canReadWorkspaces = await checkOrganizationPermission(
      orgId, userId, orgTokenId, teamTokenId, "read-workspaces",
    );
    if (canReadWorkspaces) {
      // Resolve the workspace set the scope permits within this org: null =
      // all workspaces, otherwise an explicit ID list (project/workspace/tag
      // selectors) that run counts must be restricted to.
      const allowedWorkspaceIds = await workspaceIdsForPermission(
        orgId, userId, orgTokenId, teamTokenId, "read",
      );
      if (allowedWorkspaceIds !== null && allowedWorkspaceIds.length === 0) {
        // The scope cannot reach any workspace in this org.
        orgs.push({ orgId, workspaces: 0, runsByStatus: {} });
      } else {
        const workspaceFilter: SQL | undefined = allowedWorkspaceIds === null
          ? undefined
          : inArray(workspaces.id, [...allowedWorkspaceIds]);
        const [workspaceCount, runsByStatus] = await Promise.all([
          workspaceFilter === undefined
            ? db.select({ value: count() }).from(workspaces).where(eq(workspaces.orgId, orgId))
            : db.select({ value: count() }).from(workspaces).where(and(eq(workspaces.orgId, orgId), workspaceFilter)),
          workspaceFilter === undefined
            ? db.select({ status: runs.status, value: count() })
              .from(runs)
              .innerJoin(workspaces, eq(runs.workspaceId, workspaces.id))
              .where(eq(workspaces.orgId, orgId))
              .groupBy(runs.status)
            : db.select({ status: runs.status, value: count() })
              .from(runs)
              .innerJoin(workspaces, eq(runs.workspaceId, workspaces.id))
              .where(and(eq(workspaces.orgId, orgId), workspaceFilter))
              .groupBy(runs.status),
        ]);
        orgs.push({
          orgId,
          workspaces: workspaceCount[0]?.value ?? 0,
          runsByStatus: runsByStatusFrom(runsByStatus),
        });
      }
    }

    // Agent pool metrics require the agent-pools:read grant for the org.
    if (await checkOrganizationPermission(orgId, userId, orgTokenId, teamTokenId, "read-agent-pools")) {
      const orgPools = await db.select({ id: agentPools.id, name: agentPools.name, orgId: agentPools.orgId })
        .from(agentPools)
        .where(eq(agentPools.orgId, orgId));
      pools.push(...orgPools);
    }
  }

  const agentPoolMetrics = await collectPoolMetrics(pools);
  return {
    legacy: false,
    instance: null,
    orgs,
    agentPools: agentPoolMetrics,
    agentPoolsTotal: agentPoolMetrics.length,
  };
}
