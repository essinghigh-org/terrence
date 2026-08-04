import { Database } from 'bun:sqlite';
import { drizzle, SQLiteBunTransaction } from 'drizzle-orm/bun-sqlite';
import type { SQLiteBunSession } from 'drizzle-orm/bun-sqlite';
import type { SQLiteSession, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import * as schema from './schema';
import { encryptSecret, isEncryptedSecret } from '../lib/secrets';

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, '../../storage'));
await mkdir(storageDir, { recursive: true });

// bun:sqlite is built into Bun and keeps a single stable native connection; the
// @libsql/client driver leaked native memory per query and churned a fresh native
// connection for every transaction (the source of terrence's multi-GB RSS growth).
const dbUrl = process.env.DATABASE_URL ?? `file:${join(storageDir, 'terrence.db')}`;
const client = new Database(dbUrl === ':memory:' ? ':memory:' : dbUrl.replace(/^file:/, ''), { create: true });
client.run('PRAGMA journal_mode = WAL;');
client.run('PRAGMA busy_timeout = 5000;');

type TableInfoRow = { name: string; notnull?: number };

function tableRows(sql: string): readonly unknown[] {
  return client.prepare(sql).all();
}

function runSql(sql: string): void {
  client.run(sql);
}

function getColumnNames(rows: readonly unknown[]): Set<string> {
  return new Set(rows.map((r: unknown): string => (r as TableInfoRow).name));
}

// Opt-in SQL query instrumentation for the benchmark suite
// (TERRENCE_QUERY_COUNT=1). Drizzle routes every statement through
// client.prepare(), so counting prepares counts queries. Zero overhead when
// the env var is unset (the wrapper is never installed). Set
// TERRENCE_QUERY_LOG=1 alongside it to also capture the SQL text.
let queryCount = 0;
const queryLog: string[] = [];
let queryLogEnabled = process.env.TERRENCE_QUERY_LOG === "1";
if (process.env.TERRENCE_QUERY_COUNT === "1") {
  const originalPrepare = client.prepare.bind(client);
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types, @typescript-eslint/explicit-function-return-type -- mirrors bun:sqlite's generic prepare() signature that an explicit return type cannot widen.
  client.prepare = ((sql: string, ...params: unknown[]) => {
    queryCount += 1;
    if (queryLogEnabled) queryLog.push(sql);
    return originalPrepare(sql, ...(params as [never]));
  });
}

/** @public Used by the dynamically imported benchmark runner. */
export function resetQueryCount(): void {
  queryCount = 0;
  queryLog.length = 0;
}

/** @public Used by the dynamically imported benchmark runner. */
export function getQueryCount(): number {
  return queryCount;
}

/** @public Used by the dynamically imported benchmark runner. */
export function getQueryLog(): readonly string[] {
  return queryLog.slice();
}

/**
 * Toggle query-text capture at runtime (used by the benchmark runner's
 * --query-breakdown mode). Disabling clears the log so stale statements never
 * leak into a later breakdown. Zero cost while disabled: the hot path only
 * reads a boolean.
 */
/** @public Used by the dynamically imported benchmark runner. */
export function setQueryLogging(enabled: boolean): void {
  queryLogEnabled = enabled;
  if (!enabled) queryLog.length = 0;
}

export const db = drizzle(client, { schema });

// bun:sqlite's native transaction() rolls back only when its callback throws
// synchronously; drizzle-orm/bun-sqlite delegates transaction() straight to it, so
// an async callback that throws would silently COMMIT partial writes. Wrap it with
// explicit BEGIN/COMMIT/ROLLBACK that awaits the callback instead.
const session = (db as unknown as { session: SQLiteBunSession<Record<string, unknown>, never> }).session;
(session as unknown as { transaction: unknown }).transaction = async function (
  // The callback signature mirrors drizzle's own session.transaction type.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  fn: (tx: SQLiteBunTransaction<Record<string, unknown>, never>) => Promise<unknown>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  config?: { behavior?: 'deferred' | 'immediate' | 'exclusive' },
): Promise<unknown> {
  const sess = this as unknown as { dialect: SQLiteSyncDialect; schema: unknown };
  const tx = new SQLiteBunTransaction<Record<string, unknown>, never>(
    'sync',
    sess.dialect,
    this as unknown as SQLiteSession<'sync', void, Record<string, unknown>, never>,
    sess.schema as never,
  );
  const behavior = config?.behavior !== undefined ? ` ${config.behavior.toUpperCase()}` : '';
  client.run(`BEGIN${behavior}`);
  try {
    const result = await fn(tx);
    client.run('COMMIT');
    return result;
  } catch (err) {
    client.run('ROLLBACK');
    throw err;
  }
};

migrate(db, { migrationsFolder: join(import.meta.dir, '../../drizzle') });

// Read-path performance indexes (also in migration 0059). Re-applied
// idempotently here so deployments with historically incomplete migration
// journals still get the indexes even though the journal doesn't record 0059.
// All three are pure read-shape accelerators; no data or semantics change.
runSql(`
  CREATE INDEX IF NOT EXISTS runs_workspace_created_idx ON runs (workspace_id, created_at);
  CREATE INDEX IF NOT EXISTS team_memberships_user_idx ON team_memberships (user_id);
  CREATE INDEX IF NOT EXISTS organization_memberships_user_org_idx ON organization_memberships (user_id, org_id);
`);

// Keep upgrades from pre-RBAC releases safe even when their migration journal is incomplete.
runSql(`
  CREATE TABLE IF NOT EXISTS organization_roles (
    id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT, permissions TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(org_id, name)
  );
  CREATE TABLE IF NOT EXISTS organization_membership_roles (
    membership_id TEXT NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES organization_roles(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, UNIQUE(membership_id, role_id)
  );
`);

// Apply schema additions that may not be in the migration history
const tableInfo = tableRows("PRAGMA table_info(runs)");
const existingRunsColumns = getColumnNames(tableInfo);
const runsAdditions: [string, string][] = [
  ["allow_empty_apply", "integer DEFAULT false NOT NULL"],
  ["save_plan", "integer DEFAULT false NOT NULL"],
  ["allow_config_generation", "integer DEFAULT false NOT NULL"],
  ["status_timestamps", "text"],
  ["plan_resource_additions", "integer DEFAULT 0"],
  ["plan_resource_changes", "integer DEFAULT 0"],
  ["plan_resource_destructions", "integer DEFAULT 0"],
  ["plan_resource_imports", "integer DEFAULT 0"],
  ["apply_resource_additions", "integer DEFAULT 0"],
  ["apply_resource_changes", "integer DEFAULT 0"],
  ["apply_resource_destructions", "integer DEFAULT 0"],
  ["apply_resource_imports", "integer DEFAULT 0"],
  ["applied_at", "integer"],
];
for (const [col, def] of runsAdditions) {
  if (!existingRunsColumns.has(col)) {
    runSql(`ALTER TABLE runs ADD COLUMN ${col} ${def}`);
  }
}

// Check state_versions for missing columns too
const svTableInfo = tableRows("PRAGMA table_info(state_versions)");
const existingSvCols = getColumnNames(svTableInfo);
const svAdditions: [string, string][] = [
  ["status", "text DEFAULT 'finalized'"],
  ["json_state", "text"],
  ["json_state_outputs", "text"],
  ["vcs_commit_sha", "text"],
  ["vcs_commit_url", "text"],
  ["run_id", "text REFERENCES runs(id)"],
  ["terraform_version", "text"],
];
for (const [col, def] of svAdditions) {
  if (!existingSvCols.has(col)) {
    runSql(`ALTER TABLE state_versions ADD COLUMN ${col} ${def}`);
  }
}

// Check workspaces for created_at column
const wsTableInfo = tableRows("PRAGMA table_info(workspaces)");
const existingWsCols = getColumnNames(wsTableInfo);
if (!existingWsCols.has("created_at")) {
  runSql("ALTER TABLE workspaces ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)");
}
if (!existingWsCols.has("updated_at")) {
  runSql("ALTER TABLE workspaces ADD COLUMN updated_at INTEGER");
}

const organizationTableInfo = tableRows("PRAGMA table_info(organizations)");
const existingOrganizationColumns = getColumnNames(organizationTableInfo);
const organizationAdditions: [string, string][] = [
  ["aggregated_commit_status_enabled", "integer NOT NULL DEFAULT true"],
  ["send_passing_statuses", "integer NOT NULL DEFAULT false"],
];
for (const [col, def] of organizationAdditions) {
  if (!existingOrganizationColumns.has(col)) runSql(`ALTER TABLE organizations ADD COLUMN ${col} ${def}`);
}
// Check workspaces for source column
if (!existingWsCols.has("source")) {
  runSql("ALTER TABLE workspaces ADD COLUMN source text DEFAULT 'tfe-api'");
}

// Check state_versions for created_at column
const svCreatedAtInfo = tableRows("PRAGMA table_info(state_versions)");
const existingSvCreatedAtCols = getColumnNames(svCreatedAtInfo);
if (!existingSvCreatedAtCols.has("created_at")) {
  runSql("ALTER TABLE state_versions ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)");
}

// Check policy_sets for missing columns
const psTableInfo = tableRows("PRAGMA table_info(policy_sets)");
const existingPsCols = getColumnNames(psTableInfo);
const psAdditions: [string, string][] = [
  ["agent_enabled", "integer DEFAULT false"],
  ["policy_tool_version", "text"],
  ["policies_path", "text"],
  ["vcs_repo", "text"],
];
for (const [col, def] of psAdditions) {
  if (!existingPsCols.has(col)) {
    runSql(`ALTER TABLE policy_sets ADD COLUMN ${col} ${def}`);
  }
}

// Create admin version tables if they don't exist
runSql(`
  CREATE TABLE IF NOT EXISTS admin_terraform_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    url TEXT,
    sha TEXT,
    deprecated INTEGER DEFAULT false,
    is_default INTEGER DEFAULT false,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sentinel_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    url TEXT,
    sha TEXT,
    deprecated INTEGER DEFAULT false,
    is_default INTEGER DEFAULT false,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_opa_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    url TEXT,
    sha TEXT,
    deprecated INTEGER DEFAULT false,
    is_default INTEGER DEFAULT false,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    agent_pool_id TEXT NOT NULL REFERENCES agent_pools(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    ip_address TEXT,
    version TEXT,
    architecture TEXT,
    last_ping_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS github_app_installations (
    id TEXT PRIMARY KEY NOT NULL,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    installation_id INTEGER NOT NULL,
    icon_url TEXT,
    installation_type TEXT DEFAULT 'Organization',
    installation_url TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS github_app_installations_org_installation_idx
    ON github_app_installations (org_id, installation_id);
  CREATE INDEX IF NOT EXISTS workspaces_vcs_repo_identifier_idx
    ON workspaces (json_extract(vcs_repo, '$.identifier'));
  CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT DEFAULT 'processing' NOT NULL,
    received_at INTEGER NOT NULL,
    processed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS admin_settings (
    id TEXT PRIMARY KEY NOT NULL,
    "values" TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Check notification_configurations for missing columns
const ncTableInfo = tableRows("PRAGMA table_info(notification_configurations)");
const existingNcCols = getColumnNames(ncTableInfo);
const ncAdditions: [string, string][] = [
  ["team_id", "text REFERENCES teams(id)"],
  ["project_id", "text REFERENCES projects(id)"],
];
for (const [col, def] of ncAdditions) {
  if (!existingNcCols.has(col)) {
    runSql(`ALTER TABLE notification_configurations ADD COLUMN ${col} ${def}`);
  }
}
const workspaceNotificationColumn = ncTableInfo
  .map((row: unknown): TableInfoRow => row as TableInfoRow)
  .find((column: Readonly<TableInfoRow>): boolean => column.name === "workspace_id");
if (workspaceNotificationColumn?.notnull === 1) {
  runSql(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE __new_notification_configurations (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      destination_type TEXT NOT NULL,
      url TEXT NOT NULL,
      triggers TEXT NOT NULL,
      enabled INTEGER DEFAULT true,
      token TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO __new_notification_configurations (
      id, workspace_id, team_id, project_id, name, destination_type, url, triggers, enabled, token, created_at
    )
    SELECT
      id, workspace_id, team_id, project_id, name, destination_type, url, triggers, enabled, token, created_at
    FROM notification_configurations;
    DROP TABLE notification_configurations;
    ALTER TABLE __new_notification_configurations RENAME TO notification_configurations;
    PRAGMA foreign_keys = ON;
  `);
}

// Check policy_checks for missing columns
const pcTableInfo = tableRows("PRAGMA table_info(policy_checks)");
const existingPcCols = getColumnNames(pcTableInfo);
const pcAdditions: [string, string][] = [
  ["policy_id", "text REFERENCES policies(id)"],
  ["policy_set_id", "text REFERENCES policy_sets(id)"],
];
for (const [col, def] of pcAdditions) {
  if (!existingPcCols.has(col)) {
    runSql(`ALTER TABLE policy_checks ADD COLUMN ${col} ${def}`);
  }
}

// Encrypt private keys created by older releases before serving requests.
const storedSshKeys = await db.query.sshKeys.findMany();
for (const key of storedSshKeys) {
  if (!isEncryptedSecret(key.value)) {
    client.prepare("UPDATE ssh_keys SET value = ? WHERE id = ?").run(await encryptSecret(key.value), key.id);
  }
}

// Check users for missing columns
const usersTableInfo = tableRows("PRAGMA table_info(users)");
const existingUsersCols = getColumnNames(usersTableInfo);
if (!existingUsersCols.has("is_site_auditor")) runSql("ALTER TABLE users ADD COLUMN is_site_auditor INTEGER DEFAULT 0");
if (!existingUsersCols.has("is_suspended")) runSql("ALTER TABLE users ADD COLUMN is_suspended INTEGER DEFAULT 0");
if (!existingUsersCols.has("theme")) runSql("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'original-light'");

// Check teams for missing columns
const teamsTableInfo = tableRows("PRAGMA table_info(teams)");
const existingTeamsCols = getColumnNames(teamsTableInfo);
if (!existingTeamsCols.has("allow_member_token_management")) runSql("ALTER TABLE teams ADD COLUMN allow_member_token_management INTEGER DEFAULT 0");

// Check oauth_clients for missing columns
const oauthTableInfo = tableRows("PRAGMA table_info(oauth_clients)");
const existingOauthCols = getColumnNames(oauthTableInfo);
if (!existingOauthCols.has("organization_scoped")) runSql("ALTER TABLE oauth_clients ADD COLUMN organization_scoped INTEGER DEFAULT 0");

// Create new tables if not existing
runSql(`
  CREATE TABLE IF NOT EXISTS workspace_transfers (
    id TEXT PRIMARY KEY,
    source_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    destination_org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
    destination_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    approval_mode TEXT NOT NULL DEFAULT 'auto',
    cleanup_on_failure INTEGER DEFAULT 1,
    history_cutoff TEXT,
    policy_set_mode TEXT NOT NULL DEFAULT 'move',
    variable_mode TEXT NOT NULL DEFAULT 'move',
    workspace_prefix TEXT,
    workspace_suffix TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    pause_reason TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plan_exports (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    data_type TEXT NOT NULL DEFAULT 'sentinel-mock-bundle-v0',
    status TEXT NOT NULL DEFAULT 'queued',
    download_url TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cidr_range_lists (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    enforcement_scope TEXT NOT NULL DEFAULT 'organization',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cidr_ranges (
    id TEXT PRIMARY KEY,
    cidr_range_list_id TEXT NOT NULL REFERENCES cidr_range_lists(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS query_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'tfe-api',
    variables TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    log_read_url TEXT,
    status_timestamps TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    canceled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_projects (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    access TEXT NOT NULL DEFAULT 'read',
    project_access TEXT,
    workspace_access TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(team_id, project_id)
  );

  CREATE TABLE IF NOT EXISTS admin_general_settings (
    id TEXT PRIMARY KEY,
    limit_user_organization_creation INTEGER NOT NULL DEFAULT 1,
    api_rate_limiting_enabled INTEGER NOT NULL DEFAULT 1,
    api_rate_limit INTEGER NOT NULL DEFAULT 30,
    plan_timeout TEXT NOT NULL DEFAULT '2h',
    apply_timeout TEXT NOT NULL DEFAULT '24h',
    send_passing_statuses INTEGER NOT NULL DEFAULT 0,
    allow_speculative_plans_forks INTEGER NOT NULL DEFAULT 0,
    default_remote_state_access INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS site_data_retention_policies (
    id TEXT PRIMARY KEY,
    state_versions_count INTEGER,
    delete_older_than_n_days INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS support_bundle_requests (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    download_url TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS module_test_configurations (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL REFERENCES registry_modules(id) ON DELETE CASCADE,
    oidc_provider_url TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS module_test_results (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES registry_module_versions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    output TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_device_codes (
    device_code TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    token TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_2fa (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_stages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    status_timestamps TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS policy_evaluations (
    id TEXT PRIMARY KEY,
    task_stage_id TEXT REFERENCES task_stages(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'passed',
    policy_kind TEXT DEFAULT 'opa',
    policy_tool_version TEXT DEFAULT '0.44.0',
    result_count TEXT,
    status_timestamps TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS policy_set_outcomes (
    id TEXT PRIMARY KEY,
    policy_evaluation_id TEXT NOT NULL REFERENCES policy_evaluations(id) ON DELETE CASCADE,
    policy_set_name TEXT,
    policy_name TEXT,
    enforcement_level TEXT NOT NULL DEFAULT 'advisory',
    status TEXT NOT NULL DEFAULT 'passed',
    query TEXT,
    description TEXT,
    error TEXT,
    overridable INTEGER DEFAULT 0,
    result_count TEXT,
    created_at INTEGER NOT NULL
  );
`);

// Check registry_module_versions for missing columns
const rmvInfo = tableRows("PRAGMA table_info(registry_module_versions)");
const existingRmvCols = getColumnNames(rmvInfo);
if (!existingRmvCols.has("is_deprecated")) runSql("ALTER TABLE registry_module_versions ADD COLUMN is_deprecated INTEGER DEFAULT 0");
if (!existingRmvCols.has("is_revoked")) runSql("ALTER TABLE registry_module_versions ADD COLUMN is_revoked INTEGER DEFAULT 0");

// Check run_tasks for global_configuration
const rtInfo = tableRows("PRAGMA table_info(run_tasks)");
const existingRtCols = getColumnNames(rtInfo);
if (!existingRtCols.has("global_configuration")) runSql("ALTER TABLE run_tasks ADD COLUMN global_configuration TEXT");

// Check configuration_versions for auto_queue_runs
const cvInfo = tableRows("PRAGMA table_info(configuration_versions)");
const existingCvCols = getColumnNames(cvInfo);
if (!existingCvCols.has("auto_queue_runs")) {
  runSql("ALTER TABLE configuration_versions ADD COLUMN auto_queue_runs INTEGER NOT NULL DEFAULT 1");
}

// Check run_task_results for task_stage_id
const rtrInfo = tableRows("PRAGMA table_info(run_task_results)");
const existingRtrCols = getColumnNames(rtrInfo);
if (!existingRtrCols.has("task_stage_id")) runSql("ALTER TABLE run_task_results ADD COLUMN task_stage_id TEXT REFERENCES task_stages(id)");

// Check policy_evaluations for task_stage_id & run_id
const peInfo = tableRows("PRAGMA table_info(policy_evaluations)");
const existingPeCols = getColumnNames(peInfo);
if (!existingPeCols.has("task_stage_id")) runSql("ALTER TABLE policy_evaluations ADD COLUMN task_stage_id TEXT REFERENCES task_stages(id)");
if (!existingPeCols.has("run_id")) runSql("ALTER TABLE policy_evaluations ADD COLUMN run_id TEXT REFERENCES runs(id)");

runSql('PRAGMA foreign_keys = ON');
