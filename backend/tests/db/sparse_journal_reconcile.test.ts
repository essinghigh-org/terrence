import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cp, mkdtemp, rm, writeFile } from "fs/promises";
import { readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { sparseJournalReconcilePlan, readBundledMigrationJournal } from "../../src/db/reconcile";

/**
 * Sparse-journal reconciliation (2026-08-23 prod incident).
 *
 * Prod crash-looped because its migration journal stopped at 0025 while
 * idempotent boot-DDL guards kept creating schema objects outside the journal.
 * Drizzle replays every journal entry newer than the newest recorded row, so
 * each boot aborted on the first collision (`ALTER TABLE api_tokens ADD legacy`
 * against a column the Aug-19 emergency guard had already added) and the gap
 * grew with every release. These tests pin the reconciliation behavior.
 */
const DRIZZLE_DIR = join(import.meta.dir, "../../drizzle");

/** Build a database whose journal stops at `maxIdx` using a truncated bundle copy. */
async function buildSparseDatabase(dir: string, maxIdx: number): Promise<string> {
  const dbPath = join(dir, "terrence.db");
  const oldFolder = join(dir, "drizzle-old");
  await cp(DRIZZLE_DIR, oldFolder, { recursive: true });
  const journalPath = join(oldFolder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const keptTags = new Set(journal.entries.map((entry) => (entry as unknown as { tag: string }).tag));
  for (const file of readdirSync(oldFolder)) {
    if (file.endsWith(".sql") && !keptTags.has(file.replace(/\.sql$/, ""))) await rm(join(oldFolder, file));
  }
  const raw = new Database(dbPath);
  migrate(drizzle(raw), { migrationsFolder: oldFolder });
  raw.close();
  return dbPath;
}

function tableExists(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnExists(db: Database, table: string, column: string): boolean {
  return !!db.query(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column);
}

test.skip("boots cleanly on the 2026-08-23 prod shape: journal at 0025 plus seven out-of-journal columns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-sparse-prod-"));
  try {
    const dbPath = await buildSparseDatabase(dir, 25);
    // Out-of-journal columns exactly as probed on prod before the fix.
    const seed = new Database(dbPath);
    seed.run("ALTER TABLE api_tokens ADD COLUMN legacy integer NOT NULL DEFAULT 0");
    seed.run("ALTER TABLE configuration_versions ADD COLUMN upload_claim_expires_at integer");
    seed.run("ALTER TABLE refresh_sessions ADD COLUMN successor_hash text");
    seed.run("ALTER TABLE refresh_sessions ADD COLUMN rotated_at_ms integer");
    seed.run("ALTER TABLE user_2fa ADD COLUMN secret_encrypted text");
    seed.run("ALTER TABLE workspace_variables ADD COLUMN value_encrypted text");
    seed.run("ALTER TABLE variable_set_variables ADD COLUMN value_encrypted text");
    seed.close();

    const script = `
      await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/db/index.ts")).href)});
      const { Database } = await import("bun:sqlite");
      const raw = new Database(${JSON.stringify(dbPath)});
      console.log(JSON.stringify({
        journalCount: (raw.query("SELECT COUNT(*) c FROM __drizzle_migrations").get()).c,
        identityLinks: !!raw.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity_links'").get(),
        registryComponents: !!raw.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_components'").get(),
        stateOutputIndex: !!raw.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state_output_index'").get(),
        rateLimitBuckets: !!raw.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rate_limit_buckets'").get(),
        actionInvocations: !!raw.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='action_invocations'").get(),
        notificationDeliveryState: !!raw.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_delivery_state'").get(),
        organizationInvitations: !!raw.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_invitations'").get(),
        legacyColumns: (raw.query("SELECT COUNT(*) c FROM pragma_table_info('api_tokens') WHERE name='legacy'").get()).c,
        isProvisional: !!(raw.query("SELECT 1 FROM pragma_table_info('users') WHERE name='is_provisional'").get()),
      }));
    `;
    const process = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...Bun.env, DATABASE_URL: `file:${dbPath}`, STORAGE_DIR: join(dir, "storage") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) console.error(stderr);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    // Journal completes to the bundled history; nothing replays on later boots.
    const bundled = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta/_journal.json"), "utf8")) as { entries: unknown[] };
    expect(result.journalCount).toBe(bundled.entries.length);
    // Every post-0025 table HEAD needs now exists.
    const expectedTables = {
      identity_links: "identityLinks",
      organization_invitations: "organizationInvitations",
      notification_delivery_state: "notificationDeliveryState",
      rate_limit_buckets: "rateLimitBuckets",
      registry_components: "registryComponents",
      action_invocations: "actionInvocations",
      state_output_index: "stateOutputIndex",
    } as const;
    for (const [table, key] of Object.entries(expectedTables)) {
      expect(result[key as keyof typeof result], `${table} must exist after boot`).toBe(true);
    }
    // The collision column was repaired once, not duplicated.
    expect(result.legacyColumns).toBe(1);
    expect(result.isProvisional).toBe(true);

    // Re-boot is a no-op: journal stable, process exits cleanly.
    const reboot = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...Bun.env, DATABASE_URL: `file:${dbPath}`, STORAGE_DIR: join(dir, "storage") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [rebootCode, rebootStdout] = await Promise.all([reboot.exited, new Response(reboot.stdout).text()]);
    expect(rebootCode).toBe(0);
    expect(JSON.parse(rebootStdout.trim().split("\n").pop()!).journalCount).toBe(bundled.entries.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("plan classifier: skips existing objects, runs missing ones, leaves untouched migrations to drizzle", () => {
  const entries = readBundledMigrationJournal(DRIZZLE_DIR);
  const entry26 = entries.find((entry) => entry.idx === 26)!;
  const entry27 = entries.find((entry) => entry.idx === 27)!;
  const entry28 = entries.find((entry) => entry.idx === 28)!;

  // Facts matching the live prod state at the time of the incident: 0025
  // journaled, api_tokens.legacy already created by an earlier boot guard,
  // everything else from 0026 onward missing.
  const facts = {
    appliedRows: [{ hash: "legacy-row", createdAt: entry25When(entries) }],
    tables: new Set(["api_tokens", "users"]),
    indexes: new Set<string>(),
    columns: new Set(["api_tokens.legacy"]),
  };

  const plan = sparseJournalReconcilePlan(DRIZZLE_DIR, [entry26, entry27, entry28], facts);
  // 0026 is partially present -> planned with statement-level repair.
  const plan26 = plan.find((entry) => entry.tag === entry26.tag);
  expect(plan26, "journal entry 0026 must be planned").toBeDefined();
  expect(plan26?.statements[0]).toEqual({ sql: expect.stringContaining("ADD `legacy`"), skip: true });
  expect(plan26?.statements.find((statement) => statement.sql.includes("is_provisional"))?.skip).toBe(false);
  expect(plan26?.statements.every((statement) => statement.sql.length > 0)).toBe(true);
  // 0027 creates identity_links which is missing -> NOT planned, and the scan
  // stops so no later entry can be stamped past an unapplied migration.
  expect(plan.find((entry) => entry.tag === entry27.tag)).toBeUndefined();
  // 0028 likewise untouched (also excluded by the contiguous-stamp rule).
  expect(plan.find((entry) => entry.tag === entry28.tag)).toBeUndefined();

  // Fully-present migration -> planned with every statement skipped (stamp-only).
  // Columns mirror exactly what 0026/0027 create, so every statement classifies
  // as already-present.
  const fullFacts = {
    appliedRows: [{ hash: "legacy-row", createdAt: entry25When(entries) }],
    tables: new Set(["api_tokens", "users", "configuration_versions", "refresh_sessions", "user_2fa", "workspace_variables", "variable_set_variables", "identity_links", "organization_invitations"]),
    indexes: new Set([
      "identity_links_provider_external_idx",
      "identity_links_user_idx",
      "organization_invitations_token_hash_unique",
      "organization_invitations_org_idx",
      "organization_invitations_email_normalized_idx",
      "organization_invitations_org_email_pending_idx",
    ]),
    columns: new Set([
      "api_tokens.legacy",
      "configuration_versions.upload_claim_expires_at",
      "refresh_sessions.successor_hash",
      "refresh_sessions.rotated_at_ms",
      "user_2fa.secret_encrypted",
      "users.is_provisional",
      "users.deleted_at",
      "users.deleted_email_hash",
      "variable_set_variables.value_encrypted",
      "workspace_variables.value_encrypted",
    ]),
  };
  const planFull = sparseJournalReconcilePlan(DRIZZLE_DIR, [entry26, entry27], fullFacts);
  expect(planFull.find((entry) => entry.tag === entry26.tag)?.statements.every((statement) => statement.skip)).toBe(true);
  expect(planFull.find((entry) => entry.tag === entry27.tag)?.statements.every((statement) => statement.skip)).toBe(true);
});

function entry25When(entries: ReturnType<typeof readBundledMigrationJournal>): number {
  return entries.find((entry) => entry.idx === 25)!.when;
}

test("fresh database: reconciliation is inert and the migrator still applies everything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-sparse-fresh-"));
  try {
    const dbPath = join(dir, "terrence.db");
    const script = `
      await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/db/index.ts")).href)});
      const { Database } = await import("bun:sqlite");
      const raw = new Database(${JSON.stringify(dbPath)});
      const count = (raw.query("SELECT COUNT(*) c FROM __drizzle_migrations").get()).c;
      const ok = !!raw.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runs'").get();
      console.log(JSON.stringify({ count, ok }));
    `;
    const process = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...Bun.env, DATABASE_URL: `file:${dbPath}`, STORAGE_DIR: join(dir, "storage") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) console.error(stderr);
    expect(exitCode).toBe(0);
    const bundled = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta/_journal.json"), "utf8")) as { entries: unknown[] };
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result.count).toBe(bundled.entries.length);
    expect(result.ok).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

// Guard the helper imports used above so tree-shaking never drops them silently.
void tableExists;
void columnExists;
