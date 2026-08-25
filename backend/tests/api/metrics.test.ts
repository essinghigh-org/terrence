import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  agentJobs,
  agentPools,
  agents,
  apiTokens,
  organizationMemberships,
  organizations,
  projects,
  refreshSessions,
  runs,
  systemApiTokens,
  users,
  workspaces,
} from "../../src/db/schema";
import { inArray } from "drizzle-orm";
import { hashSystemApiToken } from "../../src/lib/system-api";

// Token-authenticated /metrics (kanban 9.14): a dedicated System API token
// sees instance-wide metrics; ordinary legacy and fine-grained tokens see only
// the org/workspace/agent data their scope is eligible for.
describe("instance metrics", () => {
  let server: { url: URL; stop: () => void };
  let baseUrl: string;
  let legacyToken: string;
  let scopedToken: string;
  let workspaceRestrictedToken: string;
  let noAgentGrantToken: string;
  let otherOrgToken: string;
  let sessionToken: string;
  let adminSessionToken: string;
  let monitoringToken: string;

  const suffix = crypto.randomUUID();
  const monitoringTokenId = `metrics-system-${suffix}`;
  const sessionTokenId = `metrics-tok-session-${suffix}`;
  const sessionRefreshId = `metrics-refresh-session-${suffix}`;
  const adminSessionTokenId = `metrics-tok-admin-session-${suffix}`;
  const adminSessionRefreshId = `metrics-refresh-admin-${suffix}`;
  const userId = `metrics-user-${suffix}`;
  const otherUserId = `metrics-other-${suffix}`;
  const orgA = `metrics-org-a-${suffix}`;
  const orgB = `metrics-org-b-${suffix}`;
  const wsA1 = `metrics-ws-a1-${suffix}`;
  const wsA2 = `metrics-ws-a2-${suffix}`;
  const wsB1 = `metrics-ws-b1-${suffix}`;
  const runAApplied = `metrics-run-a-applied-${suffix}`;
  const runAPending = `metrics-run-a-pending-${suffix}`;
  const runBApplied = `metrics-run-b-applied-${suffix}`;
  const poolA = `metrics-pool-a-${suffix}`;
  const poolB = `metrics-pool-b-${suffix}`;
  const agentA1 = `metrics-agent-a1-${suffix}`;
  const agentA2 = `metrics-agent-a2-${suffix}`;
  const agentB1 = `metrics-agent-b1-${suffix}`;

  // The stale-agent assertion depends on the heartbeat timeout being below the
  // 120s heartbeat age seeded for agent-a2; pin it so the test is deterministic
  // regardless of operator env overrides.
  const previousHeartbeatTimeout = process.env.AGENT_HEARTBEAT_TIMEOUT_MS;

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const readJson = async (res: Response): Promise<Record<string, unknown>> =>
    JSON.parse(await res.text()) as Record<string, unknown>;

  beforeAll(async () => {
    process.env.AGENT_HEARTBEAT_TIMEOUT_MS = "60000";
    server = Bun.serve({ port: 0, fetch: (req: Request): Promise<Response> => app.handle(req) });
    baseUrl = server.url.toString();
    await db.insert(users).values([
      { id: userId, username: `metrics-${suffix}@test`, passwordHash: "hash" },
      { id: otherUserId, username: `metrics-other-${suffix}@test`, passwordHash: "hash" },
      { id: `metrics-admin-${suffix}`, username: `metrics-admin-${suffix}@test`, passwordHash: "hash", isSiteAdmin: true },
    ]);
    await db.insert(organizations).values([
      { id: orgA, name: `metrics-a-${suffix}` },
      { id: orgB, name: `metrics-b-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values([
      { id: `metrics-mem-a-${suffix}`, userId, orgId: orgA, role: "owner" },
      { id: `metrics-mem-b-${suffix}`, userId: otherUserId, orgId: orgB, role: "owner" },
    ]);
    await db.insert(projects).values([
      { id: `metrics-prj-a-${suffix}`, orgId: orgA, name: "proj-a" },
      { id: `metrics-prj-b-${suffix}`, orgId: orgB, name: "proj-b" },
    ]);
    await db.insert(workspaces).values([
      { id: wsA1, orgId: orgA, name: "ws-a1", executionMode: "agent" },
      { id: wsA2, orgId: orgA, name: "ws-a2", executionMode: "remote" },
      { id: wsB1, orgId: orgB, name: "ws-b1", executionMode: "remote" },
    ]);
    const now = Date.now();
    await db.insert(runs).values([
      { id: runAApplied, workspaceId: wsA1, status: "applied", createdAt: now - 60_000 },
      { id: runAPending, workspaceId: wsA2, status: "pending", createdAt: now },
      { id: runBApplied, workspaceId: wsB1, status: "applied", createdAt: now },
    ]);
    await db.insert(agentPools).values([
      { id: poolA, orgId: orgA, name: "pool-a" },
      { id: poolB, orgId: orgB, name: "pool-b" },
    ]);
    await db.insert(agents).values([
      { id: agentA1, agentPoolId: poolA, name: "agent-a1", status: "idle", lastPingAt: now },
      // Stale: heartbeat older than the 60s default timeout.
      { id: agentA2, agentPoolId: poolA, name: "agent-a2", status: "busy", lastPingAt: now - 120_000 },
      { id: agentB1, agentPoolId: poolB, name: "agent-b1", status: "idle", lastPingAt: now },
    ]);
    await db.insert(agentJobs).values([
      { id: `metrics-job-aq-${suffix}`, runId: runAApplied, agentPoolId: poolA, phase: "plan", status: "queued", createdAt: now - 30_000 },
      { id: `metrics-job-ac-${suffix}`, runId: runAPending, agentPoolId: poolA, phase: "apply", status: "claimed", claimedAt: now, createdAt: now - 10_000 },
      { id: `metrics-job-ae-${suffix}`, runId: runAApplied, agentPoolId: poolA, phase: "apply", status: "errored", createdAt: now - 20_000 },
      { id: `metrics-job-bq-${suffix}`, runId: runBApplied, agentPoolId: poolB, phase: "plan", status: "queued", createdAt: now - 5_000 },
    ]);

    legacyToken = `metrics-legacy-${suffix}`;
    scopedToken = `metrics-scoped-${suffix}`;
    workspaceRestrictedToken = `metrics-ws-scoped-${suffix}`;
    noAgentGrantToken = `metrics-noagent-${suffix}`;
    otherOrgToken = `metrics-other-${suffix}`;
    sessionToken = `metrics-session-${suffix}`;
    adminSessionToken = `metrics-admin-session-${suffix}`;
    monitoringToken = `tfe-system-metrics-${suffix}`;
    await db.insert(apiTokens).values([
      // Legacy: no scopes = full permissions.
      { id: `metrics-tok-legacy-${suffix}`, token: legacyToken, userId },
      // Browser session access token: no scopes, but tracked in
      // refresh_sessions. Must NOT see instance-wide metrics.
      { id: sessionTokenId, token: sessionToken, userId, description: "Browser session access token" },
      // Site admin's browser session access token: accepted for instance-wide metrics.
      { id: adminSessionTokenId, token: adminSessionToken, userId: `metrics-admin-${suffix}`, description: "Browser session access token" },
      // Fine-grained: full org A coverage, both grants.
      {
        id: `metrics-tok-scoped-${suffix}`,
        token: scopedToken,
        userId,
        scopes: JSON.stringify({
          version: 1,
          orgs: [orgA],
          permissions: { "workspaces:read": true, "agent-pools:read": true },
        }),
      },
      // Fine-grained: org A but workspace-restricted to wsA1 only.
      {
        id: `metrics-tok-ws-${suffix}`,
        token: workspaceRestrictedToken,
        userId,
        scopes: JSON.stringify({
          version: 1,
          orgs: [orgA],
          workspaces: [wsA1],
          permissions: { "workspaces:read": true },
        }),
      },
      // Fine-grained: org A but no agent-pools grant.
      {
        id: `metrics-tok-noagent-${suffix}`,
        token: noAgentGrantToken,
        userId,
        scopes: JSON.stringify({
          version: 1,
          orgs: [orgA],
          permissions: { "workspaces:read": true },
        }),
      },
      // Fine-grained: bound to a user who owns org B, scoped to org B.
      {
        id: `metrics-tok-other-${suffix}`,
        token: otherOrgToken,
        userId: otherUserId,
        scopes: JSON.stringify({
          version: 1,
          orgs: [orgB],
          permissions: { "workspaces:read": true, "agent-pools:read": true },
        }),
      },
    ]);
    // The session token's refresh-session tracking row (what distinguishes a
    // browser session access token from a user-created legacy API token).
    await db.insert(refreshSessions).values({
      id: sessionRefreshId,
      familyId: `metrics-family-${suffix}`,
      tokenHash: `metrics-refresh-hash-${suffix}`,
      userId,
      accessTokenId: sessionTokenId,
      expiresAt: Date.now() + 60 * 60_000,
      createdAt: Date.now(),
    });
    // The site admin's browser-session tracking row.
    await db.insert(refreshSessions).values({
      id: adminSessionRefreshId,
      familyId: `metrics-admin-family-${suffix}`,
      tokenHash: `metrics-admin-refresh-hash-${suffix}`,
      userId: `metrics-admin-${suffix}`,
      accessTokenId: adminSessionTokenId,
      expiresAt: Date.now() + 60 * 60_000,
      createdAt: Date.now(),
    });
    await db.insert(systemApiTokens).values({
      id: monitoringTokenId,
      tokenHash: hashSystemApiToken(monitoringToken),
      description: "instance metrics test token",
      expiresAt: Date.now() + 60 * 60_000,
    });
  });

  afterAll(async () => {
    server.stop();
    if (previousHeartbeatTimeout === undefined) {
      delete process.env.AGENT_HEARTBEAT_TIMEOUT_MS;
    } else {
      process.env.AGENT_HEARTBEAT_TIMEOUT_MS = previousHeartbeatTimeout;
    }
    await db.delete(refreshSessions).where(inArray(refreshSessions.id, [sessionRefreshId, adminSessionRefreshId]));
    await db.delete(systemApiTokens).where(inArray(systemApiTokens.id, [monitoringTokenId]));
    await db.delete(apiTokens).where(inArray(apiTokens.id, [
      `metrics-tok-legacy-${suffix}`,
      sessionTokenId,
      adminSessionTokenId,
      `metrics-tok-scoped-${suffix}`,
      `metrics-tok-ws-${suffix}`,
      `metrics-tok-noagent-${suffix}`,
      `metrics-tok-other-${suffix}`,
    ]));
    await db.delete(agentJobs).where(inArray(agentJobs.id, [
      `metrics-job-aq-${suffix}`,
      `metrics-job-ac-${suffix}`,
      `metrics-job-ae-${suffix}`,
      `metrics-job-bq-${suffix}`,
    ]));
    await db.delete(agents).where(inArray(agents.id, [agentA1, agentA2, agentB1]));
    await db.delete(agentPools).where(inArray(agentPools.id, [poolA, poolB]));
    await db.delete(runs).where(inArray(runs.id, [runAApplied, runAPending, runBApplied]));
    await db.delete(workspaces).where(inArray(workspaces.id, [wsA1, wsA2, wsB1]));
    await db.delete(projects).where(inArray(projects.id, [`metrics-prj-a-${suffix}`, `metrics-prj-b-${suffix}`]));
    await db.delete(organizationMemberships).where(inArray(organizationMemberships.id, [`metrics-mem-a-${suffix}`, `metrics-mem-b-${suffix}`]));
    await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB]));
    await db.delete(users).where(inArray(users.id, [userId, otherUserId, `metrics-admin-${suffix}`]));
  });

  test("rejects unauthenticated access", async () => {
    const res = await fetch(`${baseUrl}metrics`);
    expect(res.status).toBe(401);
  });

  test("rejects an unknown token", async () => {
    const res = await fetch(`${baseUrl}metrics`, { headers: auth("metrics-nope") });
    expect(res.status).toBe(401);
  });

  test("rejects a browser session access token from a non-admin (no instance metrics)", async () => {
    const res = await fetch(`${baseUrl}metrics`, { headers: auth(sessionToken) });
    expect(res.status).toBe(403);
    const body = await readJson(res) as { errors: { status: string }[] };
    expect(body.errors[0]?.status).toBe("403");
  });

  test("accepts a site admin's browser session access token for instance-wide metrics", async () => {
    const res = await fetch(`${baseUrl}metrics`, { headers: auth(adminSessionToken) });
    expect(res.status).toBe(200);
    const { metrics } = await readJson(res) as { metrics: Record<string, unknown> };
    // Instance-wide counters are present (not the scoped-org shape).
    expect(typeof metrics.terrence_users_total).toBe("number");
  });

  test("legacy token sees instance-wide metrics plus agent queue depth", async () => {
    const res = await fetch(`${baseUrl}metrics`, { headers: auth(monitoringToken) });
    expect(res.status).toBe(200);
    const { metrics } = await readJson(res) as { metrics: Record<string, unknown> };

    expect(metrics.terrence_users_total).toBeGreaterThanOrEqual(2);
    expect(metrics.terrence_organizations_total).toBeGreaterThanOrEqual(2);
    expect(metrics.terrence_workspaces_total).toBeGreaterThanOrEqual(3);
    expect(metrics.terrence_runs_total).toBeGreaterThanOrEqual(3);
    // NOTE: do not use toMatchObject with expect.any() on values that are
    // read again afterwards — Bun 1.3.14 replaces matched values with {}
    // (asymmetric-matcher materialization bug); use explicit typeof checks.
    const runCounts = metrics.tfe_run_current_count as Record<string, unknown>;
    expect(typeof runCounts.applied).toBe("number");
    expect(typeof runCounts.pending).toBe("number");
    expect(metrics.terrence_database_size_bytes).toEqual(expect.any(Number));
    // WAL size can be null when the WAL has been folded into the main DB file
    // (graceful shutdown checkpoints it); both shapes are valid.
    expect(metrics.terrence_database_wal_size_bytes === null || typeof metrics.terrence_database_wal_size_bytes === "number").toBe(true);
    expect(metrics.terrence_database_page_count).toEqual(expect.any(Number));
    expect(metrics.terrence_database_cache_size_bytes === null || typeof metrics.terrence_database_cache_size_bytes === "number").toBe(true);
    expect(metrics.terrence_database_freelist_bytes === null || typeof metrics.terrence_database_freelist_bytes === "number").toBe(true);
    expect(metrics.terrence_agent_pools_total).toBeGreaterThanOrEqual(2);

    // Process-level runtime observability (legacy tier only).
    expect(metrics.terrence_process_rss_bytes).toBeGreaterThan(0);
    expect(metrics.terrence_process_max_rss_bytes).toBeGreaterThan(0);
    expect(metrics.terrence_process_heap_used_bytes).toBeGreaterThanOrEqual(0);
    expect(metrics.terrence_process_uptime_seconds).toBeGreaterThanOrEqual(0);
    const cpuSeconds = metrics.terrence_process_cpu_seconds as Record<string, unknown>;
    expect(typeof cpuSeconds.user).toBe("number");
    expect(typeof cpuSeconds.system).toBe("number");
    // The /metrics request itself is counted, plus every earlier test request.
    const requests = metrics.terrence_requests as { total: number; in_flight: number; errors5xx: number };
    expect(typeof requests.total).toBe("number");
    expect(typeof requests.in_flight).toBe("number");
    expect(typeof requests.errors5xx).toBe("number");
    expect(requests.total).toBeGreaterThanOrEqual(1);
    const worker = metrics.terrence_worker as { polls: number; last_poll_at: number | null; last_poll_duration_ms: number | null; last_poll_ok: boolean | null };
    expect(typeof worker.polls).toBe("number");
    expect(worker.last_poll_at === null || typeof worker.last_poll_at === "number").toBe(true);
    expect(worker.last_poll_duration_ms === null || typeof worker.last_poll_duration_ms === "number").toBe(true);
    expect(worker.last_poll_ok === null || typeof worker.last_poll_ok === "boolean").toBe(true);
    const history = metrics.terrence_process_history as { interval_ms: number; max_samples: number; samples: unknown[]; stats: { rss: { min: number; max: number; latest: number | null; growth_per_hour: number | null }; heap_used: { min: number; max: number; latest: number | null; growth_per_hour: number | null } } };
    expect(history.interval_ms).toBeGreaterThan(0);
    expect(history.max_samples).toBeGreaterThan(0);
    expect(Array.isArray(history.samples)).toBe(true);
    expect(history.stats.rss.min).toBeGreaterThanOrEqual(0);
    expect(history.stats.rss.growth_per_hour === null || typeof history.stats.rss.growth_per_hour === "number").toBe(true);

    const pools = metrics.agent_pools as { id: string; agents_by_status: Record<string, number>; agents_stale: number; jobs_queued: number; jobs_claimed: number; jobs_errored: number; oldest_queued_wait_seconds: number }[];
    expect(pools.some((pool): boolean => pool.id === poolA)).toBe(true);
    const poolA_ = pools.find((pool): boolean => pool.id === poolA)!;
    expect(poolA_.agents_by_status).toMatchObject({ idle: 1, busy: 1 });
    expect(poolA_.agents_stale).toBe(1); // agent-a2 heartbeat is 120s old
    expect(poolA_.jobs_queued).toBe(1);
    expect(poolA_.jobs_claimed).toBe(1);
    expect(poolA_.jobs_errored).toBe(1);
    expect(poolA_.oldest_queued_wait_seconds).toBeGreaterThanOrEqual(25);
  });

  test("rejects an ordinary legacy token from instance-wide metrics", async () => {
    const res = await fetch(`${baseUrl}metrics`, { headers: auth(legacyToken) });
    expect(res.status).toBe(403);
  });

  test("fine-grained token sees only its org, no instance counters", async () => {
    const res = await fetch(`${baseUrl}metrics`, { headers: auth(scopedToken) });
    expect(res.status).toBe(200);
    const { metrics } = await readJson(res) as { metrics: Record<string, unknown> };

    // Instance-wide counters must NOT leak to a scoped token.
    expect(metrics.terrence_users_total).toBeUndefined();
    expect(metrics.terrence_organizations_total).toBeUndefined();
    expect(metrics.terrence_database_size_bytes).toBeUndefined();
    // Process-level runtime observability is instance-wide too.
    expect(metrics.terrence_process_rss_bytes).toBeUndefined();
    expect(metrics.terrence_process_history).toBeUndefined();

    const orgs = metrics.organizations as { org_id: string; workspaces: number; runs_by_status: Record<string, number> }[];
    const orgA_ = orgs.find((org): boolean => org.org_id === orgA);
    expect(orgA_).toBeDefined();
    // ws-a1, ws-a2 (all workspaces in org A; no project/workspace/tag selector).
    expect(orgA_!.workspaces).toBe(2);
    expect(orgA_!.runs_by_status).toMatchObject({ applied: 1, pending: 1 });

    const pools = metrics.agent_pools as { id: string }[];
    expect(pools.some((pool): boolean => pool.id === poolA)).toBe(true);
    expect(pools.some((pool): boolean => pool.id === poolB)).toBe(false);
  });

  test("workspace-restricted scope counts only eligible workspaces", async () => {
    const res = await fetch(`${baseUrl}metrics`, { headers: auth(workspaceRestrictedToken) });
    expect(res.status).toBe(200);
    const { metrics } = await readJson(res) as { metrics: Record<string, unknown> };
    const orgs = metrics.organizations as { org_id: string; workspaces: number; runs_by_status: Record<string, number> }[];
    const orgA_ = orgs.find((org): boolean => org.org_id === orgA);
    expect(orgA_!.workspaces).toBe(1); // only ws-a1
    expect(orgA_!.runs_by_status).toMatchObject({ applied: 1 });
    expect(orgA_!.runs_by_status.pending).toBeUndefined();
  });

  test("scope without agent-pools:read sees no pool metrics", async () => {
    const res = await fetch(`${baseUrl}metrics`, { headers: auth(noAgentGrantToken) });
    expect(res.status).toBe(200);
    const { metrics } = await readJson(res) as { metrics: Record<string, unknown> };
    expect(metrics.agent_pools).toEqual([]);
    expect(metrics.terrence_agent_pools_total).toBe(0);
  });

  test("scoped token never sees another org's data", async () => {
    const res = await fetch(`${baseUrl}metrics`, { headers: auth(otherOrgToken) });
    expect(res.status).toBe(200);
    const { metrics } = await readJson(res) as { metrics: Record<string, unknown> };
    const orgs = metrics.organizations as { org_id: string; workspaces: number }[];
    expect(orgs.some((org): boolean => org.org_id === orgB)).toBe(true);
    expect(orgs.some((org): boolean => org.org_id === orgA)).toBe(false);
    const pools = metrics.agent_pools as { id: string }[];
    expect(pools.some((pool): boolean => pool.id === poolB)).toBe(true);
    expect(pools.some((pool): boolean => pool.id === poolA)).toBe(false);
  });

  test("Prometheus text format carries queue-depth gauges with pool labels", async () => {
    const res = await fetch(`${baseUrl}metrics?format=prometheus`, { headers: auth(monitoringToken) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    // Each metric family must have exactly one HELP/TYPE pair (Prometheus text
    // format); a per-pool family repeated once per pool would duplicate them.
    const helpNames = body
      .split("\n")
      .filter((line): boolean => line.startsWith("# HELP "))
      .map((line): string => line.split(" ")[2]!);
    expect(new Set(helpNames).size).toBe(helpNames.length);
    expect(body).toContain("# TYPE terrence_runs_total gauge");
    expect(body).toMatch(/terrence_runs_total \d+/);
    expect(body).toContain("# TYPE terrence_agent_jobs_queued_total gauge");
    expect(body).toMatch(new RegExp(`terrence_agent_jobs_queued_total\\{pool_id="${poolA}",pool="pool-a",org="${orgA}"\\} 1`));
    expect(body).toMatch(/terrence_agents_stale_total\{[^}]*pool-a[^}]*\} 1/);
    expect(body).toMatch(/terrence_agent_queue_oldest_wait_seconds\{[^}]*pool-a[^}]*\} [1-9]\d*/);
    // Process gauges (legacy tier).
    expect(body).toContain("# TYPE terrence_process_rss_bytes gauge");
    expect(body).toMatch(/terrence_process_rss_bytes \d+/);
    expect(body).toMatch(/terrence_requests_total \d+/);
    expect(body).toMatch(/terrence_worker_polls_total \d+/);
    // SQLite-only bloat metric: health.ts only emits the value line when
    // freelistBytes !== null (null on postgres). Require the value on
    // sqlite and require its absence on postgres so a missing sqlite
    // metric cannot pass silently.
    const isPg = (process.env.DATABASE_URL ?? "").startsWith("postgres");
    if (isPg) {
      expect(body).not.toMatch(/^terrence_database_freelist_bytes \d+/m);
    } else {
      expect(body).toMatch(/terrence_database_freelist_bytes \d+/);
    }
  });

  test("Prometheus format for a scoped token omits instance gauges", async () => {
    const res = await fetch(`${baseUrl}metrics?format=prometheus`, { headers: auth(scopedToken) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("terrence_users_total ");
    expect(body).not.toContain("terrence_process_rss_bytes");
    expect(body).toContain(`terrence_org_workspaces_total{org="${orgA}"} 2`);
    expect(body).toContain(`terrence_agents_total{pool_id="${poolA}",pool="pool-a",org="${orgA}",status="idle"} 1`);
  });
});
