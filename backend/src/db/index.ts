import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import * as schema from './schema';
import { encryptSecret, isEncryptedSecret } from '../lib/secrets';

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, '../../storage'));
await mkdir(storageDir, { recursive: true });

const sqlite = createClient({
  url: process.env.DATABASE_URL ?? `file:${join(storageDir, 'terrence.db')}`,
});
await sqlite.executeMultiple(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
`);

type TableInfoRow = { name: string; notnull?: number };

function getColumnNames(info: { readonly rows: readonly unknown[] }): Set<string> {
  return new Set(info.rows.map((r: unknown): string => (r as TableInfoRow).name));
}



export const db = drizzle(sqlite, { schema });
await migrate(db, { migrationsFolder: join(import.meta.dir, '../../drizzle') });

// Apply schema additions that may not be in the migration history
const tableInfo = await sqlite.execute("PRAGMA table_info(runs)");
const existingRunsColumns = getColumnNames(tableInfo);
const runsAdditions: [string, string][] = [
  ["allow_empty_apply", "integer DEFAULT false NOT NULL"],
  ["save_plan", "integer DEFAULT false NOT NULL"],
  ["allow_config_generation", "integer DEFAULT false NOT NULL"],
  ["status_timestamps", "text"],
  ["plan_resource_additions", "integer DEFAULT 0"],
  ["plan_resource_changes", "integer DEFAULT 0"],
  ["plan_resource_destructions", "integer DEFAULT 0"],
  ["apply_resource_additions", "integer DEFAULT 0"],
  ["apply_resource_changes", "integer DEFAULT 0"],
  ["apply_resource_destructions", "integer DEFAULT 0"],
];
for (const [col, def] of runsAdditions) {
  if (!existingRunsColumns.has(col)) {
    await sqlite.execute(`ALTER TABLE runs ADD COLUMN ${col} ${def}`);
  }
}

// Check state_versions for missing columns too
const svTableInfo = await sqlite.execute("PRAGMA table_info(state_versions)");
const existingSvCols = getColumnNames(svTableInfo);
const svAdditions: [string, string][] = [
  ["status", "text DEFAULT 'finalized'"],
  ["json_state", "text"],
  ["json_state_outputs", "text"],
  ["vcs_commit_sha", "text"],
  ["vcs_commit_url", "text"],
  ["run_id", "text REFERENCES runs(id)"],
];
for (const [col, def] of svAdditions) {
  if (!existingSvCols.has(col)) {
    await sqlite.execute(`ALTER TABLE state_versions ADD COLUMN ${col} ${def}`);
  }
}

// Check workspaces for created_at column
const wsTableInfo = await sqlite.execute("PRAGMA table_info(workspaces)");
const existingWsCols = getColumnNames(wsTableInfo);
if (!existingWsCols.has("created_at")) {
  await sqlite.execute("ALTER TABLE workspaces ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)");
}

// Check state_versions for created_at column
const svCreatedAtInfo = await sqlite.execute("PRAGMA table_info(state_versions)");
const existingSvCreatedAtCols = getColumnNames(svCreatedAtInfo);
if (!existingSvCreatedAtCols.has("created_at")) {
  await sqlite.execute("ALTER TABLE state_versions ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)");
}

// Check policy_sets for missing columns
const psTableInfo = await sqlite.execute("PRAGMA table_info(policy_sets)");
const existingPsCols = getColumnNames(psTableInfo);
const psAdditions: [string, string][] = [
  ["agent_enabled", "integer DEFAULT false"],
  ["policy_tool_version", "text"],
  ["policies_path", "text"],
  ["vcs_repo", "text"],
];
for (const [col, def] of psAdditions) {
  if (!existingPsCols.has(col)) {
    await sqlite.execute(`ALTER TABLE policy_sets ADD COLUMN ${col} ${def}`);
  }
}

// Create admin version tables if they don't exist
await sqlite.executeMultiple(`
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
`);

// Check notification_configurations for missing columns
const ncTableInfo = await sqlite.execute("PRAGMA table_info(notification_configurations)");
const existingNcCols = getColumnNames(ncTableInfo);
const ncAdditions: [string, string][] = [
  ["team_id", "text REFERENCES teams(id)"],
  ["project_id", "text REFERENCES projects(id)"],
];
for (const [col, def] of ncAdditions) {
  if (!existingNcCols.has(col)) {
    await sqlite.execute(`ALTER TABLE notification_configurations ADD COLUMN ${col} ${def}`);
  }
}
const workspaceNotificationColumn = ncTableInfo.rows
  .map((row: unknown): TableInfoRow => row as TableInfoRow)
  .find((column: Readonly<TableInfoRow>): boolean => column.name === "workspace_id");
if (workspaceNotificationColumn?.notnull === 1) {
  await sqlite.executeMultiple(`
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
const pcTableInfo = await sqlite.execute("PRAGMA table_info(policy_checks)");
const existingPcCols = getColumnNames(pcTableInfo);
const pcAdditions: [string, string][] = [
  ["policy_id", "text REFERENCES policies(id)"],
  ["policy_set_id", "text REFERENCES policy_sets(id)"],
];
for (const [col, def] of pcAdditions) {
  if (!existingPcCols.has(col)) {
    await sqlite.execute(`ALTER TABLE policy_checks ADD COLUMN ${col} ${def}`);
  }
}

// Encrypt private keys created by older releases before serving requests.
const storedSshKeys = await db.query.sshKeys.findMany();
for (const key of storedSshKeys) {
  if (!isEncryptedSecret(key.value)) {
    await sqlite.execute({
      sql: "UPDATE ssh_keys SET value = ? WHERE id = ?",
      args: [await encryptSecret(key.value), key.id],
    });
  }
}

await sqlite.execute('PRAGMA foreign_keys = ON');
