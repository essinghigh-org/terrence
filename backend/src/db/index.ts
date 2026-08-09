import { Database } from 'bun:sqlite';
import { drizzle, SQLiteBunTransaction } from 'drizzle-orm/bun-sqlite';
import type { SQLiteBunSession } from 'drizzle-orm/bun-sqlite';
import type { SQLiteSession, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'path';
import * as schema from './schema';
import { encryptSecret, isEncryptedSecret } from '../lib/secrets';

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, '../../storage'));
// Deliberately synchronous: a top-level await here made this module a TLA
// module, and Bun's worker threads can resolve importers while the TLA is
// still pending (ReferenceError: Cannot access 'db' before initialization
// in every bun test worker). mkdirSync is behavior-identical.
mkdirSync(storageDir, { recursive: true });

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

// api_tokens gained a token_type column (org token slot: "" vs "audit-trails").
// Guarded ALTER so both fresh DBs (created by drizzle migrations) and existing
// deployments converge.
{
  const cols = (client.query("SELECT name FROM pragma_table_info('api_tokens')").all() as { name: string }[]).map((c): string => c.name);
  if (!cols.includes("token_type")) {
    client.run("ALTER TABLE api_tokens ADD COLUMN token_type TEXT DEFAULT ''");
  }
}

// organizations gained access_beta_tools + workspace_limit (admin settings).
// Guarded ALTER for existing deployments; fresh DBs get them via drizzle.
{
  const orgCols = (client.query("SELECT name FROM pragma_table_info('organizations')").all() as { name: string }[]).map((c): string => c.name);
  if (!orgCols.includes("access_beta_tools")) {
    client.run("ALTER TABLE organizations ADD COLUMN access_beta_tools INTEGER NOT NULL DEFAULT 0");
  }
  if (!orgCols.includes("workspace_limit")) {
    client.run("ALTER TABLE organizations ADD COLUMN workspace_limit INTEGER");
  }
}

// Read-path performance indexes (also in migration 0059). Re-applied
// idempotently here so deployments with historically incomplete migration
// journals still get the indexes even though the journal doesn't record 0059.
// All three are pure read-shape accelerators; no data or semantics change.
runSql(`
  CREATE INDEX IF NOT EXISTS runs_workspace_created_idx ON runs (workspace_id, created_at);
  CREATE INDEX IF NOT EXISTS team_memberships_user_idx ON team_memberships (user_id);
  CREATE INDEX IF NOT EXISTS organization_memberships_user_org_idx ON organization_memberships (user_id, org_id);
`);
runSql(`
  CREATE TABLE IF NOT EXISTS test_variables (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL REFERENCES registry_modules (id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    sensitive INTEGER NOT NULL DEFAULT 0,
    hcl INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'terraform',
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS test_variables_module_key_idx ON test_variables (module_id, key);
`);

// Stacks domain (tfe_stack / tfe_stack_variable_set).
runSql(`
  CREATE TABLE IF NOT EXISTS stacks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
    agent_pool_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    speculative_enabled INTEGER NOT NULL DEFAULT 0,
    working_directory TEXT,
    trigger_patterns TEXT NOT NULL DEFAULT '[]',
    vcs_identifier TEXT,
    vcs_branch TEXT,
    vcs_oauth_token_id TEXT,
    vcs_gha_installation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stack_variable_sets (
    stack_id TEXT NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
    variable_set_id TEXT NOT NULL REFERENCES variable_sets (id) ON DELETE CASCADE,
    PRIMARY KEY (stack_id, variable_set_id)
  );
`);

// HYOK customer key versions (tfe_hyok_customer_key_version / tfe_hyok_encrypted_data_key data sources).
runSql(`
  CREATE TABLE IF NOT EXISTS hyok_customer_key_versions (
    id TEXT PRIMARY KEY,
    hyok_config_id TEXT NOT NULL REFERENCES hyok_configurations (id) ON DELETE CASCADE,
    key_version TEXT NOT NULL,
    encrypted_dek TEXT NOT NULL,
    customer_key_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    workspaces_secured INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL
  );
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

// Org-scoped (standalone) policies: go-tfe Policies.Create posts to
// /organizations/:org/policies, so a policy must be able to exist without a
// policy set. Add policies.org_id and make policy_set_id nullable. SQLite
// cannot drop NOT NULL via ALTER, so rebuild the table when needed (run
// outside any transaction so PRAGMA foreign_keys takes effect). Idempotent.
// Ran AFTER the policy_sets column adds above so the vcs_repo reference-check
// triggers (0048) see a complete policy_sets row shape.
// Mirrored in migration 0060 (which adds org_id only; the rebuild here is
// the source of truth for dropping NOT NULL).
{
  // Rebuild the policies table when its shape is out of date (NOT NULL cannot
  // be dropped via ALTER). Runs outside any transaction so PRAGMA foreign_keys
  // changes take effect. Idempotent and recoverable at every step WITHOUT ever
  // renaming the live table away:
  //   * The live `policies` table keeps its name the whole time, so child
  //     foreign keys (policy_checks.policy_id -> policies) stay valid.
  //   * Data is copied into `policies_new` first, then `DROP TABLE policies`
  //     + `ALTER TABLE policies_new RENAME TO policies` promotes the new shape
  //     under the SAME name. The only crash window (policies gone, data safe in
  //     policies_new) is restored on next startup by the recovery block below.
  // Prefer this over a policies->policies_old rename, which rewrites child FKs
  // to `policies_old` and leaves them dangling once that table is dropped.
  // Mirrored in migration 0060 (which adds org_id only; the rebuild here is
  // the source of truth for dropping NOT NULL).
  const policiesExists = tableRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policies'").length > 0;

  // Recover an interrupted rebuild: the live table is gone but the full data
  // set survived in policies_new — restore it under the canonical name so the
  // check below sees a complete `policies` row (and child FKs resolve).
  if (!policiesExists) {
    const newExists = tableRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policies_new'").length > 0;
    if (newExists) {
      runSql("ALTER TABLE policies_new RENAME TO policies;");
      // Refresh the policy-set org_id backfill this rebuild would have applied.
      runSql(`
        UPDATE policies SET org_id = (SELECT ps.org_id FROM policy_sets ps WHERE ps.id = policies.policy_set_id)
          WHERE org_id IS NULL AND policy_set_id IS NOT NULL;
      `);
    }
  }

  const policiesTableInfo = tableRows("PRAGMA table_info(policies)");
  const policiesColumns = getColumnNames(policiesTableInfo);
  if (!policiesColumns.has("org_id")) {
    runSql("ALTER TABLE policies ADD COLUMN org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE;");
  }
  const policySetIdCol = policiesTableInfo.find((r: unknown): boolean =>
    (r as TableInfoRow).name === "policy_set_id");
  if (policySetIdCol !== undefined && (policySetIdCol as { notnull?: number }).notnull === 1) {
    // Rebuild of the policies table.
    // - PRAGMA foreign_keys must be toggled OUTSIDE any transaction (it is a
    //   no-op inside one), so manage it around the rebuild steps below.
    // - DROP TABLE IF EXISTS policies_new makes the rebuild idempotent and
    //   recovers from an interrupted prior startup.
    runSql("PRAGMA foreign_keys = OFF;");
    try {
      runSql("DROP TABLE IF EXISTS policies_new;");
      runSql(`
        CREATE TABLE policies_new (
          id TEXT PRIMARY KEY NOT NULL,
          org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
          policy_set_id TEXT REFERENCES policy_sets(id) ON DELETE CASCADE,
          policy_set_version_id TEXT REFERENCES policy_set_versions(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          description TEXT,
          enforcement_level TEXT DEFAULT 'soft-mandatory' NOT NULL,
          query TEXT,
          source TEXT,
          source_path TEXT,
          created_at INTEGER NOT NULL
        );
      `);
      runSql(`
        INSERT INTO policies_new (id, org_id, policy_set_id, policy_set_version_id, name, description, enforcement_level, query, source, source_path, created_at)
          SELECT id, org_id, policy_set_id, policy_set_version_id, name, description, enforcement_level, query, source, source_path, created_at FROM policies;
      `);
      runSql(`
        UPDATE policies_new SET org_id = (SELECT ps.org_id FROM policy_sets ps WHERE ps.id = policies_new.policy_set_id)
          WHERE org_id IS NULL AND policy_set_id IS NOT NULL;
      `);
      // Promote under the SAME name — no intermediate rename, so child FKs
      // referencing `policies` stay correct.
      runSql("DROP TABLE policies;");
      runSql("ALTER TABLE policies_new RENAME TO policies;");
    } finally {
      runSql("PRAGMA foreign_keys = ON;");
    }
  }

  // Repair any DB that ran an earlier rename-based rebuild (which rewired
  // policy_checks.policy_id to the dropped policies_old) or that crashed mid-
  // swap leaving an orphan policies_old. Regardless of current state, drop any
  // lingering policies_old and rebuild policy_checks when its policy FK no
  // longer points at the live `policies`.
  if (tableRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policies_old'").length > 0) {
    runSql("DROP TABLE IF EXISTS policies_old;");
  }
  try {
    const pcFks = tableRows("PRAGMA foreign_key_list(policy_checks)");
    const policiesFk = pcFks.find((f: unknown): boolean =>
      (f as { from: string }).from === "policy_id");
    const target = (policiesFk as { table?: string } | undefined)?.table;
    if (target !== undefined && target !== "policies") {
      // Re-point the child FK to the live `policies`: rebuild the table with
      // corrected references (data preserved).
      runSql("PRAGMA foreign_keys = OFF;");
      try {
        runSql("DROP TABLE IF EXISTS policy_checks_new;");
        runSql(`
          CREATE TABLE policy_checks_new (
            id text PRIMARY KEY NOT NULL,
            run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            policy_id text REFERENCES policies(id) ON DELETE SET NULL,
            policy_set_id text REFERENCES policy_sets(id) ON DELETE SET NULL,
            status text NOT NULL DEFAULT 'pending',
            result text,
            created_at integer NOT NULL
          );
        `);
        runSql(`
          INSERT INTO policy_checks_new (id, run_id, policy_id, policy_set_id, status, result, created_at)
            SELECT id, run_id, policy_id, policy_set_id, status, result, created_at FROM policy_checks;
        `);
        runSql("DROP TABLE policy_checks;");
        runSql("ALTER TABLE policy_checks_new RENAME TO policy_checks;");
      } finally {
        runSql("PRAGMA foreign_keys = ON;");
      }
    }
  } catch {
    // policy_checks or its FK was already consistent — nothing to repair.
  }
}

// Create tag-selector rows for policy sets (tag inclusion/exclusion).
runSql(`
  CREATE TABLE IF NOT EXISTS policy_set_tag_selectors (
    id TEXT PRIMARY KEY,
    policy_set_id TEXT NOT NULL REFERENCES policy_sets(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    is_exclude INTEGER DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS policy_set_tag_selectors_pset_idx ON policy_set_tag_selectors (policy_set_id);
  CREATE TABLE IF NOT EXISTS policy_set_project_exclusions (
    id TEXT PRIMARY KEY,
    policy_set_id TEXT NOT NULL REFERENCES policy_sets(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS policy_set_project_exclusions_idx ON policy_set_project_exclusions (policy_set_id, project_id);
`);

// Create admin version tables if they don't exist
runSql(`
CREATE TABLE IF NOT EXISTS admin_terraform_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    url TEXT,
    sha TEXT,
    deprecated INTEGER DEFAULT false,
    enabled INTEGER DEFAULT true,
    is_default INTEGER DEFAULT false,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sentinel_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    url TEXT,
    sha TEXT,
    deprecated INTEGER DEFAULT false,
    enabled INTEGER DEFAULT true,
    is_default INTEGER DEFAULT false,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_opa_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    url TEXT,
    sha TEXT,
    deprecated INTEGER DEFAULT false,
    enabled INTEGER DEFAULT true,
    is_default INTEGER DEFAULT false,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provider_sets (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    provider_source TEXT NOT NULL,
    configuration_hcl TEXT,
    global INTEGER DEFAULT false,
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
  CREATE TABLE IF NOT EXISTS agent_pool_excluded_workspaces (
    id TEXT PRIMARY KEY,
    agent_pool_id TEXT NOT NULL REFERENCES agent_pools(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_pool_excluded_workspaces_pool_workspace_idx ON agent_pool_excluded_workspaces (agent_pool_id, workspace_id);
  CREATE TABLE IF NOT EXISTS org_token_ttl_policies (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    token_type TEXT NOT NULL,
    max_ttl_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS org_token_ttl_policies_org_type_idx ON org_token_ttl_policies (org_id, token_type);
  CREATE TABLE IF NOT EXISTS oidc_configs (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    config_type TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hyok_configurations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kek_id TEXT NOT NULL,
    kms_options TEXT,
    agent_pool_id TEXT REFERENCES agent_pools(id) ON DELETE SET NULL,
    oidc_config_id TEXT NOT NULL,
    oidc_config_type TEXT NOT NULL,
    is_primary INTEGER DEFAULT false,
    status TEXT NOT NULL DEFAULT 'ok',
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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

// Backfill `enabled` on admin version tables that predate the column (older
// installs created them without it; the provider reads `enabled`).
for (const table of ["admin_terraform_versions", "admin_sentinel_versions", "admin_opa_versions"] as const) {
  const cols = getColumnNames(tableRows(`PRAGMA table_info(${table})`));
  if (cols.size > 0 && !cols.has("enabled")) {
    runSql(`ALTER TABLE ${table} ADD COLUMN enabled INTEGER DEFAULT true NOT NULL;`);
  }
}

// Enforce unique provider-set names per organization. Legacy DBs can carry
// duplicate names, so purge the later duplicates first (keep the earliest row
// per org/name) rather than silently skipping the constraint.
const providerSetIdxExists = tableRows("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'provider_sets_org_name_idx'").length > 0;
if (!providerSetIdxExists) {
  runSql("DELETE FROM provider_sets WHERE id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY org_id, name ORDER BY created_at, rowid) AS rn FROM provider_sets) WHERE rn = 1);");
  runSql("CREATE UNIQUE INDEX IF NOT EXISTS provider_sets_org_name_idx ON provider_sets (org_id, name);");
}

// Upgrade the project-exclusions index to UNIQUE for DBs that created it
// non-unique before the constraint existed (fresh tables already create it
// unique). Dedupe first so the upgrade cannot fail on legacy duplicates.
const projExclIdx = tableRows("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'policy_set_project_exclusions_idx'");
if (projExclIdx.length > 0 && !String((projExclIdx[0] as { sql?: string }).sql ?? "").toUpperCase().includes("UNIQUE")) {
  runSql("DELETE FROM policy_set_project_exclusions WHERE id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY policy_set_id, project_id ORDER BY rowid) AS rn FROM policy_set_project_exclusions) WHERE rn = 1);");
  runSql("DROP INDEX IF EXISTS policy_set_project_exclusions_idx;");
  runSql("CREATE UNIQUE INDEX IF NOT EXISTS policy_set_project_exclusions_idx ON policy_set_project_exclusions (policy_set_id, project_id);");
}

// Backfill the test-variable (module_id, key) uniqueness constraint on DBs
// whose table predates the index (fresh tables create it unique). Dedupe
// legacy duplicates first so the constraint installs cleanly.
const tvIdx = tableRows("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'test_variables_module_key_idx'");
if (tvIdx.length === 0) {
  runSql("DELETE FROM test_variables WHERE id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY module_id, key ORDER BY created_at, rowid) AS rn FROM test_variables) WHERE rn = 1);");
  runSql("CREATE UNIQUE INDEX IF NOT EXISTS test_variables_module_key_idx ON test_variables (module_id, key);");
}


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
// Batch the whole upgrade into a single UPDATE (per-row CASE) instead of a
// separate UPDATE per key, so startup scales with keys that need re-encrypting.
// Deliberately NOT awaited at module scope: any top-level await makes this a
// TLA module, and Bun's worker threads can resolve importers while TLA code
// is still pending (leaving this tail of the module half-evaluated, which
// manifests as missing guarded ALTER columns in bun test). The backfill runs
// concurrently; new writes are encrypted at the route layer anyway.
void (async (): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      const storedSshKeys = await db.query.sshKeys.findMany();
      const pendingKeys: { id: string; value: string }[] = [];
      for (const key of storedSshKeys) {
        if (!isEncryptedSecret(key.value)) pendingKeys.push({ id: key.id, value: key.value });
      }
      if (pendingKeys.length === 1) {
        const only = pendingKeys[0];
        if (only !== undefined) {
          await client.prepare("UPDATE ssh_keys SET value = ? WHERE id = ?")
            .run(await encryptSecret(only.value), only.id);
        }
      } else if (pendingKeys.length > 1) {
        const encrypted: { id: string; value: string }[] = [];
        for (const key of pendingKeys) encrypted.push({ id: key.id, value: await encryptSecret(key.value) });
        const whenClauses = encrypted.map((): string => "WHEN id = ? THEN ?").join(" ");
        const idPlaceholders = encrypted.map((): string => "?").join(",");
        const params: string[] = [];
        for (const row of encrypted) params.push(row.id, row.value);
        for (const row of encrypted) params.push(row.id);
        client.prepare(
          `UPDATE ssh_keys SET value = CASE ${whenClauses} END WHERE id IN (${idPlaceholders})`,
        ).run(...params);
      }
      return;
    } catch (error) {
      // Startup backfill is best-effort (route layer encrypts new writes);
      // retry briefly, then give up rather than leaving an unobserved
      // rejection or blocking boot.
      console.error(`[db] ssh-key backfill attempt ${attempt} failed:`, error);
      if (attempt >= 3) return;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
})();

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

// ---------------------------------------------------------------------------
// Id-format migration: re-key persisted rows that predate the current ID
// scheme (e.g. workspaces `w-*` -> `ws-*`, users `u-*` -> `usr-*`, orgs `o-*`
// -> `org-*`, raw-UUID runs/state refs -> prefixed). Both the primary key and
// every column that foreign-keys to it are rewritten so relational integrity
// holds after upgrade. Idempotent: rows already in the current shape are left
// untouched, so this is a no-op once the data is migrated.
// ---------------------------------------------------------------------------
{
  const ID_FORMATS: ReadonlyArray<Readonly<{ table: string; prefix: string; fullUuidSuffix: boolean }>> = [
    { table: "organizations", prefix: "org-", fullUuidSuffix: true },
    { table: "users", prefix: "usr-", fullUuidSuffix: true },
    { table: "workspaces", prefix: "ws-", fullUuidSuffix: false },
    { table: "projects", prefix: "prj-", fullUuidSuffix: false },
    { table: "runs", prefix: "run-", fullUuidSuffix: false },
  ];

  const isNewId = (id: string, prefix: string, fullUuidSuffix: boolean): boolean => {
    if (!id.startsWith(prefix)) return false;
    const suffix = id.slice(prefix.length);
    if (fullUuidSuffix) {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(suffix);
    }
    return /^[0-9a-f]{16}$/.test(suffix);
  };

  // 1. Compute old -> new id maps per entity.
  const rekeyMaps = new Map<string, Map<string, string>>();
  for (const fmt of ID_FORMATS) {
    const rows = client.prepare(`SELECT id FROM "${fmt.table}"`).all() as { id: string }[];
    const map = new Map<string, string>();
    for (const { id } of rows) {
      if (isNewId(id, fmt.prefix, fmt.fullUuidSuffix)) continue;
      const suffix = fmt.fullUuidSuffix
        ? crypto.randomUUID()
        : crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      map.set(id, `${fmt.prefix}${suffix}`);
    }
    if (map.size > 0) rekeyMaps.set(fmt.table, map);
  }
  if (rekeyMaps.size > 0) {
    // Build a table -> [{column, ref}] for every column that references each
    // entity, discovered from the live foreign_key metadata.
    const refs = new Map<string, Array<{ table: string; column: string }>>();
    const allTables = client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const { name } of allTables) {
      const fks = client.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string }[];
      for (const fk of fks) {
        if (rekeyMaps.has(fk.table)) {
          if (!refs.has(fk.table)) refs.set(fk.table, []);
          refs.get(fk.table)?.push({ table: name, column: fk.from });
        }
      }
    }

    client.run("PRAGMA foreign_keys = OFF");
    try {
      for (const [parent, map] of rekeyMaps) {
        for (const { table, column } of refs.get(parent) ?? []) {
          const stmt = client.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`);
          for (const [old, next] of map) stmt.run(next, old);
        }
        const pkStmt = client.prepare(`UPDATE "${parent}" SET id = ? WHERE id = ?`);
        for (const [old, next] of map) pkStmt.run(next, old);
      }
    } finally {
      client.run("PRAGMA foreign_keys = ON");
    }
    const entityNames = [...rekeyMaps.keys()].join(", ");
    const total = [...rekeyMaps.values()].reduce((acc, m) => acc + m.size, 0);
    console.warn(`[terrence] Migrated ${total} ids to the current format (${entityNames}).`);
  }
}
