import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

test("migration 0002 backfills existing tokens and preserves nullable account data", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-token-migration-"));
  const db = new Database(join(testDir, "terrence.db"));
  const migration = async (name: string) => {
    const sql = await readFile(join(import.meta.dir, "../../drizzle", name), "utf8");
    db.exec(sql.replaceAll("--> statement-breakpoint", ""));
  };

  try {
    await migration("0000_bizarre_nico_minoru.sql");
    await migration("0001_flippant_lady_deathstrike.sql");

    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)").run("existing-user", "existing", "unused");
    db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").run("existing-org", "existing");
    db.prepare("INSERT INTO workspaces (id, name, org_id) VALUES (?, ?, ?)").run("existing-workspace", "existing", "existing-org");
    db.prepare("INSERT INTO workspace_variables (id, workspace_id, key, value) VALUES (?, ?, ?, ?)").run("existing-var", "existing-workspace", "key", "value");
    db.prepare("INSERT INTO api_tokens (id, token, user_id, description) VALUES (?, ?, ?, ?)").run("existing-token", "secret", "existing-user", "existing");

    const beforeMigration = Date.now();
    await migration("0002_token_account_fields.sql");

    const token = db.prepare("SELECT created_at, last_used_at, expires_at FROM api_tokens WHERE id = ?").get("existing-token") as Record<string, unknown>;
    expect(Number(token.created_at)).toBeGreaterThanOrEqual(beforeMigration - 1_000);
    expect(token.last_used_at).toBeNull();
    expect(token.expires_at).toBeNull();

    const user = db.prepare("SELECT email FROM users WHERE id = ?").get("existing-user") as Record<string, unknown>;
    const variable = db.prepare("SELECT hcl FROM workspace_variables WHERE id = ?").get("existing-var") as Record<string, unknown>;
    expect(user.email).toBeNull();
    expect(Number(variable.hcl)).toBe(0);

    const columns = db.prepare("PRAGMA table_info(api_tokens)").all();
    expect((columns as { name: string; notnull: number }[]).find(column => column.name === "created_at")?.notnull).toBe(1);
  } finally {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  }
});
