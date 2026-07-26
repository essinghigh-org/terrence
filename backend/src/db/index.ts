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

await sqlite.execute('PRAGMA foreign_keys = ON');
