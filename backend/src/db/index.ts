import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import * as schema from './schema';

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, '../../storage'));
await mkdir(storageDir, { recursive: true });

const sqlite = createClient({
  url: process.env.DATABASE_URL ?? `file:${join(storageDir, 'terrence.db')}`,
});
await sqlite.executeMultiple(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
`);

export const db = drizzle(sqlite, { schema });
await migrate(db, { migrationsFolder: join(import.meta.dir, '../../drizzle') });

// Apply schema additions that may not be in the migration history
const tableInfo = await sqlite.execute("PRAGMA table_info(runs)");
const existingRunsColumns = new Set(tableInfo.rows.map((r: any) => r.name));
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
const existingSvCols = new Set(svTableInfo.rows.map((r: any) => r.name));
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

// Check policy_sets for missing columns
const psTableInfo = await sqlite.execute("PRAGMA table_info(policy_sets)");
const existingPsCols = new Set(psTableInfo.rows.map((r: any) => r.name));
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
`);

// Check notification_configurations for missing columns
const ncTableInfo = await sqlite.execute("PRAGMA table_info(notification_configurations)");
const existingNcCols = new Set(ncTableInfo.rows.map((r: any) => r.name));
const ncAdditions: [string, string][] = [
  ["team_id", "text REFERENCES teams(id)"],
  ["project_id", "text REFERENCES projects(id)"],
];
for (const [col, def] of ncAdditions) {
  if (!existingNcCols.has(col)) {
    await sqlite.execute(`ALTER TABLE notification_configurations ADD COLUMN ${col} ${def}`);
  }
}

// Check policy_checks for missing columns
const pcTableInfo = await sqlite.execute("PRAGMA table_info(policy_checks)");
const existingPcCols = new Set(pcTableInfo.rows.map((r: any) => r.name));
const pcAdditions: [string, string][] = [
  ["policy_id", "text REFERENCES policies(id)"],
  ["policy_set_id", "text REFERENCES policy_sets(id)"],
];
for (const [col, def] of pcAdditions) {
  if (!existingPcCols.has(col)) {
    await sqlite.execute(`ALTER TABLE policy_checks ADD COLUMN ${col} ${def}`);
  }
}

await sqlite.execute('PRAGMA foreign_keys = ON');
