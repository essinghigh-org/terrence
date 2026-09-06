import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle as sqliteDrizzle } from "drizzle-orm/bun-sqlite";
import { migrate as migrateSqlite } from "drizzle-orm/bun-sqlite/migrator";
import { drizzle as pgDrizzle } from "drizzle-orm/bun-sql";
import { migrate as migratePostgres } from "drizzle-orm/bun-sql/migrator";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseConstraint } from "../../src/lib/database-errors";
import { decryptSecret, encryptSecret } from "../../src/lib/secrets";
import { decryptStatePayload, encryptStatePayload } from "../../src/lib/validation";
import { variableValueForRead } from "../../src/lib/variable-crypto";
import { verifyArtifactReferences } from "../../src/lib/migration/artifacts";

const postgres = process.env["DATABASE_URL"]?.startsWith("postgres") === true;
const bundled = join(import.meta.dir, postgres ? "../../drizzle/pg" : "../../drizzle");
const journal = JSON.parse(await readFile(join(bundled, "meta/_journal.json"), "utf8")) as { entries: unknown[] };

async function hasColumn(
  execute: (query: string, parameters?: readonly (string | number)[]) => Promise<unknown[]>,
  table: string,
  column: string,
): Promise<boolean> {
  if (postgres) {
    const rows = await execute(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
      [table, column],
    );
    return rows.length > 0;
  }
  const rows = await execute(`PRAGMA table_info("${table}")`);
  return rows.some((row) => (row as { name?: unknown }).name === column);
}

async function tfectlVersion(): Promise<string> {
  const bun = Bun.which("bun");
  if (bun === null) throw new Error("bun is required for the upgrade fixture CLI check");
  const process = Bun.spawn([bun, join(import.meta.dir, "../../scripts/tfectl.ts"), "--version"], {
    cwd: join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`tfectl --version failed: ${stderr.trim()}`);
  return stdout.trim();
}

for (const count of new Set([1, Math.max(1, journal.entries.length - 1)])) {
  test(`${postgres ? "PostgreSQL" : "SQLite"} upgrade from ${count} bundled migration(s) preserves state, secrets, artifacts and CLI behavior`, async () => {
    const folder = await mkdtemp(join(tmpdir(), "terrence-upgrade-"));
    const artifactRoot = await mkdtemp(join(tmpdir(), "terrence-upgrade-artifacts-"));
    let sqlite: Database | undefined;
    let client: Bun.SQL | undefined;
    let admin: Bun.SQL | undefined;
    const databaseName = `upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await cp(bundled, folder, { recursive: true });
      await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }));
      let execute: (query: string, parameters?: readonly (string | number)[]) => Promise<unknown[]>;
      let migrate: (path: string) => Promise<void>;
      if (postgres) {
        const url = new URL(process.env["DATABASE_URL"] ?? "");
        admin = new Bun.SQL(url.toString());
        await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
        url.pathname = `/${databaseName}`;
        const connection = new Bun.SQL(url.toString());
        client = connection;
        execute = async (query, parameters = []) => connection.unsafe(query, [...parameters]);
        migrate = async (path) => { await migratePostgres(pgDrizzle(connection), { migrationsFolder: path }); };
      } else {
        const connection = new Database(":memory:");
        sqlite = connection;
        execute = async (query, parameters = []) => connection.query(query.replace(/\$\d+/g, "?")).all(...parameters);
        migrate = async (path) => { migrateSqlite(sqliteDrizzle(connection), { migrationsFolder: path }); };
      }
      await migrate(folder);

      const userId = `prior-user-${crypto.randomUUID()}`;
      const username = `prior-username-${crypto.randomUUID()}`;
      const organizationId = `prior-org-${crypto.randomUUID()}`;
      const workspaceId = `prior-workspace-${crypto.randomUUID()}`;
      const stateId = `prior-state-${crypto.randomUUID()}`;
      const variableId = `prior-variable-${crypto.randomUUID()}`;
      const configurationVersionId = `prior-configuration-${crypto.randomUUID()}`;
      const mfaSeed = "JBSWY3DPEHPK3PXP";
      const sensitiveValue = "prior-release-sensitive-value";
      const stateJson = JSON.stringify({
        version: 4,
        serial: 7,
        lineage: "prior-release-lineage",
        resources: [{ mode: "managed", type: "fixture_resource", name: "retained", instances: [] }],
      });
      const encryptedState = await encryptStatePayload(stateJson);
      if (encryptedState === null) throw new Error("state fixture encryption unexpectedly returned null");

      await mkdir(join(artifactRoot, "configuration"));
      await writeFile(join(artifactRoot, "configuration", "main.tf"), "terraform { required_version = \">= 1.0\" }\n");
      const archivePath = join(artifactRoot, "configuration.tar.gz");
      const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", join(artifactRoot, "configuration"), "main.tf"], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [tarExitCode, tarStderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
      if (tarExitCode !== 0) throw new Error(`configuration artifact fixture failed: ${tarStderr.trim()}`);

      await execute("INSERT INTO users (id, username, password_hash, is_site_admin) VALUES ($1, $2, $3, FALSE)", [userId, username, "retained-hash"]);
      await execute("INSERT INTO organizations (id, name) VALUES ($1, $2)", [organizationId, `prior-organization-${crypto.randomUUID()}`]);
      await execute("INSERT INTO workspaces (id, name, org_id, created_at) VALUES ($1, $2, $3, $4)", [workspaceId, "prior-workspace", organizationId, Date.now()]);
      await execute(
        "INSERT INTO state_versions (id, workspace_id, serial, state_payload, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [stateId, workspaceId, 7, encryptedState, "finalized", Date.now()],
      );
      await execute(
        "INSERT INTO configuration_versions (id, workspace_id, status, archive_path, created_at) VALUES ($1, $2, $3, $4, $5)",
        [configurationVersionId, workspaceId, "uploaded", archivePath, Date.now()],
      );

      const hasEncryptedVariable = await hasColumn(execute, "workspace_variables", "value_encrypted");
      if (hasEncryptedVariable) {
        const valueEnvelope = await encryptSecret(sensitiveValue);
        await execute(
          "INSERT INTO workspace_variables (id, workspace_id, key, value, value_encrypted, sensitive, hcl, category) VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, $6)",
          [variableId, workspaceId, "prior_secret", "", valueEnvelope, "terraform"],
        );
      } else {
        await execute(
          "INSERT INTO workspace_variables (id, workspace_id, key, value, sensitive, hcl, category) VALUES ($1, $2, $3, $4, TRUE, FALSE, $5)",
          [variableId, workspaceId, "prior_secret", sensitiveValue, "terraform"],
        );
      }

      const hasEncryptedMfa = await hasColumn(execute, "user_2fa", "secret_encrypted");
      if (hasEncryptedMfa) {
        const mfaEnvelope = await encryptSecret(mfaSeed);
        await execute(
          "INSERT INTO user_2fa (user_id, secret, secret_encrypted, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)",
          [userId, "", mfaEnvelope, Date.now()],
        );
      } else {
        await execute(
          "INSERT INTO user_2fa (user_id, secret, enabled, created_at) VALUES ($1, $2, TRUE, $3)",
          [userId, mfaSeed, Date.now()],
        );
      }

      await migrate(bundled);
      await migrate(bundled);
      const rows = await execute("SELECT id, username, password_hash, is_site_admin FROM users WHERE id = $1", [userId]);
      expect(rows).toEqual([{ id: userId, username, password_hash: "retained-hash", is_site_admin: postgres ? false : 0 }]);

      const stateRows = await execute("SELECT state_payload FROM state_versions WHERE id = $1", [stateId]);
      expect(stateRows).toHaveLength(1);
      expect(decryptStatePayload(String((stateRows[0] as { state_payload: unknown }).state_payload))).toBe(stateJson);

      const variableRows = await execute("SELECT value, value_encrypted FROM workspace_variables WHERE id = $1", [variableId]);
      expect(variableRows).toHaveLength(1);
      const variable = variableRows[0] as { value: unknown; value_encrypted: unknown };
      expect(await variableValueForRead({
        value: typeof variable.value === "string" ? variable.value : "",
        valueEncrypted: typeof variable.value_encrypted === "string" ? variable.value_encrypted : null,
      })).toBe(sensitiveValue);

      const mfaRows = await execute("SELECT secret, secret_encrypted FROM user_2fa WHERE user_id = $1", [userId]);
      expect(mfaRows).toHaveLength(1);
      const mfa = mfaRows[0] as { secret: unknown; secret_encrypted: unknown };
      const storedMfa = typeof mfa.secret_encrypted === "string" && mfa.secret_encrypted !== ""
        ? mfa.secret_encrypted
        : typeof mfa.secret === "string" ? mfa.secret : "";
      expect(await decryptSecret(storedMfa)).toBe(mfaSeed);

      const configurationRows = await execute("SELECT archive_path FROM configuration_versions WHERE id = $1", [configurationVersionId]);
      expect(configurationRows).toEqual([{ archive_path: archivePath }]);
      expect(await Bun.file(archivePath).exists()).toBe(true);
      if (sqlite !== undefined) {
        const checks = await verifyArtifactReferences(sqlite);
        expect(checks.find((check) => check.table === "configuration_versions")).toEqual({
          table: "configuration_versions", column: "archive_path", checked: 1, unavailable: 0,
        });
      }
      expect(await tfectlVersion()).toBe("tfectl 2.0.0-compatible");

      let conflict: unknown;
      try { await execute("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)", ["duplicate-user", username, "unused"]); } catch (error: unknown) { conflict = error; }
      expect(databaseConstraint(conflict)).toBe("unique");
      const applied = await execute(`SELECT COUNT(*) AS n FROM ${postgres ? "drizzle." : ""}__drizzle_migrations`);
      expect(Number((applied[0] as { n: unknown }).n)).toBe(journal.entries.length);
    } finally {
      sqlite?.close();
      await client?.close();
      if (admin !== undefined) {
        try { await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`); } finally { await admin.close(); }
      }
      await rm(folder, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
    }
  }, 30_000);
}
