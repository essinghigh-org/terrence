import { expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

test("migration 0002 backfills existing tokens and preserves nullable account data", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-token-migration-"));
  const client = createClient({ url: `file:${join(testDir, "terrence.db")}` });
  const migration = async (name: string) => {
    const sql = await readFile(join(import.meta.dir, "../../drizzle", name), "utf8");
    await client.executeMultiple(sql.replaceAll("--> statement-breakpoint", ""));
  };

  try {
    await migration("0000_bizarre_nico_minoru.sql");
    await migration("0001_flippant_lady_deathstrike.sql");

    await client.execute({
      sql: "INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)",
      args: ["existing-user", "existing", "unused"],
    });
    await client.execute({
      sql: "INSERT INTO organizations (id, name) VALUES (?, ?)",
      args: ["existing-org", "existing"],
    });
    await client.execute({
      sql: "INSERT INTO workspaces (id, name, org_id) VALUES (?, ?, ?)",
      args: ["existing-workspace", "existing", "existing-org"],
    });
    await client.execute({
      sql: "INSERT INTO workspace_variables (id, workspace_id, key, value) VALUES (?, ?, ?, ?)",
      args: ["existing-var", "existing-workspace", "key", "value"],
    });
    await client.execute({
      sql: "INSERT INTO api_tokens (id, token, user_id, description) VALUES (?, ?, ?, ?)",
      args: ["existing-token", "secret", "existing-user", "existing"],
    });

    const beforeMigration = Date.now();
    await migration("0002_token_account_fields.sql");

    const token = (await client.execute({
      sql: "SELECT created_at, last_used_at, expires_at FROM api_tokens WHERE id = ?",
      args: ["existing-token"],
    })).rows[0]!;
    expect(Number(token.created_at)).toBeGreaterThanOrEqual(beforeMigration - 1_000);
    expect(token.last_used_at).toBeNull();
    expect(token.expires_at).toBeNull();

    const user = (await client.execute("SELECT email FROM users WHERE id = 'existing-user'")).rows[0]!;
    const variable = (await client.execute("SELECT hcl FROM workspace_variables WHERE id = 'existing-var'")).rows[0]!;
    expect(user.email).toBeNull();
    expect(Number(variable.hcl)).toBe(0);

    const columns = (await client.execute("PRAGMA table_info(api_tokens)")).rows;
    expect(columns.find(column => column.name === "created_at")?.notnull).toBe(1);
  } finally {
    client.close();
    await rm(testDir, { recursive: true, force: true });
  }
});
