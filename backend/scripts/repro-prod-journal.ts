/**
 * Local reproduction of the 2026-08-23 prod crash loop (throwaway script, not committed).
 * Builds a prod-shaped DB: journal stops at 0025 (old image), api_tokens.legacy added
 * out-of-journal by the Aug-19 boot guard — then boots the CURRENT db module.
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const dir = "/tmp/terrence-prod-shape";
rmSync(dir, { recursive: true, force: true });
mkdirSync(`${dir}/storage`, { recursive: true });

// 1. Fresh DB through the OLD image's migrator: journal + files stop at 0025.
const dbPath = `${dir}/terrence.db`;
const oldFolder = `${dir}/drizzle-old`;
cpSync(new URL("../drizzle", import.meta.url).pathname, oldFolder, { recursive: true });
const journal = JSON.parse(readFileSync(`${oldFolder}/meta/_journal.json`, "utf8")) as { entries: { idx: number }[] };
journal.entries = journal.entries.filter((entry): boolean => entry.idx <= 25);
writeFileSync(`${oldFolder}/meta/_journal.json`, `${JSON.stringify(journal, null, 2)}\n`);
for (const file of readdirSync(oldFolder)) {
  if (/^00(2[6-9]|3\d)_.*\.sql$/.test(file)) rmSync(`${oldFolder}/${file}`);
}
const raw = new Database(dbPath);
migrate(drizzle(raw), { migrationsFolder: oldFolder });
console.log("journal rows after old-image migrate:", (raw.query("SELECT count(*) c FROM __drizzle_migrations").get() as { c: number }).c);

// 2. Reproduce the Aug-19 boot-DDL side effects EXACTLY as prod has them
//    (probed live on terrence-terrence-1's DB, 2026-08-23): seven out-of-journal
//    columns from earlier idempotent boot guards, zero post-0025 objects.
raw.run("ALTER TABLE api_tokens ADD COLUMN legacy integer NOT NULL DEFAULT 0");
raw.run("ALTER TABLE configuration_versions ADD COLUMN upload_claim_expires_at integer");
raw.run("ALTER TABLE refresh_sessions ADD COLUMN successor_hash text");
raw.run("ALTER TABLE refresh_sessions ADD COLUMN rotated_at_ms integer");
raw.run("ALTER TABLE user_2fa ADD COLUMN secret_encrypted text");
raw.run("ALTER TABLE workspace_variables ADD COLUMN value_encrypted text");
raw.run("ALTER TABLE variable_set_variables ADD COLUMN value_encrypted text");

// 3. Boot the NEW code against this DB (module import runs the full boot path).
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.STORAGE_DIR = `${dir}/storage`;
await import("../src/db/index.ts");
console.log("boot OK (no throw)");
console.log("journal rows after new-code boot:", (raw.query("SELECT count(*) c FROM __drizzle_migrations").get() as { c: number }).c);
const tables = raw
  .query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('identity_links','organization_invitations','notification_delivery_state','rate_limit_buckets','registry_components','action_invocations','state_output_index')",
  )
  .all() as { name: string }[];
console.log("0027+ tables now present:", tables.map((t: { readonly name: string }): string => t.name).sort().join(","));
const col = (table: string, column: string): boolean => {
  const row = raw.query(`SELECT 1 FROM pragma_table_info('${table}') WHERE name='${column}'`).get();
  return row !== null;
};
console.log("users.is_provisional:", col("users", "is_provisional"));
console.log("configuration_versions.upload_claim_token:", col("configuration_versions", "upload_claim_token"));
console.log("workspaces.lock_owner_type:", col("workspaces", "lock_owner_type"));
console.log("agent_jobs.requeue_attempts:", col("agent_jobs", "requeue_attempts"));
