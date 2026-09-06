/**
 * Execute the local, network-independent parts of the operations runbook.
 *
 * This intentionally uses a disposable SQLite directory.  It verifies that
 * the generated configuration contract is current, that a migrated database
 * and encrypted state/run inputs survive a copy/restore, and that the doctor
 * command can inspect the restored copy. Network checks are reported by doctor
 * but do not make this offline verification flaky.
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const timeoutMs = 60_000;

function runProcess(command: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): string {
  const result = spawnSync(command, [...args], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${String(result.status)}): ${(result.stderr ?? result.stdout).trim()}`);
  }
  return result.stdout;
}

function runBun(args: readonly string[], env: Readonly<Record<string, string>> = {}): string {
  return runProcess("bun", args, env);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(Buffer.from(await Bun.file(path).arrayBuffer()));
  return hash.digest("hex");
}

function assertRunbookText(text: string, required: readonly string[], label: string): void {
  for (const phrase of required) {
    if (!text.includes(phrase)) throw new Error(`${label} is missing documented command or claim: ${phrase}`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main(): Promise<void> {
  const operations = await readFile(join(root, "backend/docs/operations.md"), "utf8");
  const upgrading = await readFile(join(root, "backend/docs/upgrading.md"), "utf8");
  const quickstart = await readFile(join(root, "backend/docs/quickstart.md"), "utf8");
  const security = await readFile(join(root, "backend/docs/security.md"), "utf8");
  const configuration = await readFile(join(root, "backend/docs/configuration.md"), "utf8");
  assertRunbookText(operations, ["tar --create", "sha256sum --check", "doctor.ts --json", "verify-operations-docs.ts", "terrence-backup-manifest.json", "restore-rehearsals", "last-verified-restore-at", "GET /healthz", "GET /readyz", "GET /api/v1/metadata", "## Diagnostics", "## Storage layout", "## Backups"], "operations.md");
  assertRunbookText(upgrading, ["vX.Y.Z@sha256", "upgrade-invariants.test.ts", "forward-only"], "upgrading.md");
  assertRunbookText(quickstart, ["terraform login", "terraform init", "terraform plan"], "quickstart.md");
  assertRunbookText(security, ["TERRENCE_RUN_SANDBOX=false", "artifact-specific", "operations#storage-layout"], "security.md");
  assertRunbookText(configuration, ["configuration contract", "Values must be at least 100 ms", "It must be at least 1 ms", "Unknown values fail startup"], "configuration.md");
  if (operations.includes("There is no backup manifest, hashing, encryption, restore test")) {
    throw new Error("operations.md still contains the retired backup-manifest guarantee");
  }

  runBun(["backend/scripts/configuration-reference.ts", "--check"]);

  const work = await mkdtemp(join(tmpdir(), "terrence-operations-docs-"));
  const source = join(work, "source");
  const backup = join(work, "backup");
  const restored = join(work, "restored");
  await mkdir(source, { recursive: true });
  await mkdir(backup, { recursive: true });
  try {
    const dbPath = join(source, "terrence.db");
    const sourceDatabase = new Database(dbPath, { create: true });
    migrate(drizzle(sourceDatabase), { migrationsFolder: join(root, "backend/drizzle") });
    const fixture = JSON.parse(runBun(["-e", `
      const { encryptSecret } = await import(${JSON.stringify(join(root, "backend/src/lib/secrets.ts"))});
      const { encryptStatePayload } = await import(${JSON.stringify(join(root, "backend/src/lib/validation.ts"))});
      const { runVariablesForWrite } = await import(${JSON.stringify(join(root, "backend/src/lib/run-variables.ts"))});
      const state = { version: 4, terraform_version: "1.6.0", serial: 1, lineage: "docs-lineage", outputs: {}, resources: [] };
      const variables = await runVariablesForWrite([
        { key: "region", value: "eu-west-2", category: "terraform" },
        { key: "TF_TOKEN_example", value: "restored-secret", category: "env", sensitive: true },
      ]);
      console.log(JSON.stringify({
        statePayload: await encryptStatePayload(JSON.stringify(state)),
        databaseUrl: await encryptSecret("postgres://example.invalid/terrence"),
        variables,
      }));
    `], {
      STORAGE_DIR: source,
      DATABASE_URL: `file:${dbPath}`,
      ENCRYPTION_PASSWORD: "operations-docs-password",
      TERRENCE_RUN_SANDBOX: "false",
    })) as Readonly<{ statePayload: string; databaseUrl: string; variables: readonly Record<string, unknown>[] }>;
    const now = Date.now();
    sourceDatabase.run("INSERT INTO organizations (id, name) VALUES (?, ?)", ["doc-org", "Documentation Org"]);
    sourceDatabase.run("INSERT INTO workspaces (id, name, org_id, created_at) VALUES (?, ?, ?, ?)", ["doc-workspace", "Restore Fixture", "doc-org", now]);
    sourceDatabase.run("INSERT INTO runs (id, workspace_id, status, operation, variables, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      "doc-run", "doc-workspace", "planned", "plan_and_apply", JSON.stringify(fixture.variables), now,
    ]);
    sourceDatabase.run("INSERT INTO state_versions (id, workspace_id, serial, state_payload, json_state, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      "doc-state", "doc-workspace", 1, fixture.statePayload, fixture.statePayload, "doc-run", now,
    ]);
    sourceDatabase.close();
    await mkdir(join(source, "secrets"), { recursive: true });
    await writeFile(join(source, "secrets", "database-url"), fixture.databaseUrl, { mode: 0o600 });
    await mkdir(join(source, "plan-json"), { recursive: true });
    await writeFile(join(source, "plan-json", "doc-run.json"), JSON.stringify({ resource_changes: [] }), { mode: 0o600 });

    const archive = join(backup, "storage.tar");
    runProcess("tar", ["--create", "--file", archive, "--directory", source, "."]);
    const digest = await sha256(archive);
    await writeFile(join(backup, "SHA256SUMS"), `${digest}  storage.tar\n`);
    if ((await sha256(archive)) !== digest) throw new Error("backup checksum changed before restore");
    await mkdir(restored, { recursive: true });
    runProcess("tar", ["--extract", "--file", archive, "--directory", restored]);
    if ((await sha256(archive)) !== (await readFile(join(backup, "SHA256SUMS"), "utf8")).split(/\s+/)[0]) {
      throw new Error("backup checksum verification failed");
    }
    for (const path of ["terrence.db", ".encryption-salt", "secrets/database-url", "plan-json/doc-run.json"]) {
      if (!(await Bun.file(join(restored, path)).exists())) throw new Error(`restored backup is missing ${path}`);
    }

    const restoredState = runBun(["-e", `
      const { decryptSecret } = await import(${JSON.stringify(join(root, "backend/src/lib/secrets.ts"))});
      const { decryptStatePayload, parseTerraformStatePayload } = await import(${JSON.stringify(join(root, "backend/src/lib/validation.ts"))});
      const { normalizeRunVariables } = await import(${JSON.stringify(join(root, "backend/src/lib/run-variables.ts"))});
      const statePayload = ${JSON.stringify(fixture.statePayload)};
      const state = parseTerraformStatePayload(decryptStatePayload(statePayload));
      const variables = normalizeRunVariables(${JSON.stringify(fixture.variables)});
      const databaseUrl = await decryptSecret(${JSON.stringify(fixture.databaseUrl)});
      if (state?.lineage !== "docs-lineage" || state?.serial !== 1) throw new Error("restored state did not parse");
      if (variables.find((entry) => entry.key === "TF_TOKEN_example")?.value !== "restored-secret") throw new Error("restored sensitive run variable did not decrypt");
      if (variables.find((entry) => entry.key === "region")?.value !== "eu-west-2") throw new Error("restored run variable did not survive");
      if (databaseUrl !== "postgres://example.invalid/terrence") throw new Error("restored database URL secret did not decrypt");
      console.log(JSON.stringify({ state: true, execution: true }));
    `], {
      STORAGE_DIR: restored,
      DATABASE_URL: `file:${join(restored, "terrence.db")}`,
      ENCRYPTION_PASSWORD: "operations-docs-password",
      TERRENCE_RUN_SANDBOX: "false",
    });
    const restoredReport = JSON.parse(restoredState) as unknown;
    if (!isRecord(restoredReport) || restoredReport["state"] !== true || restoredReport["execution"] !== true) {
      throw new Error("restored state/execution fixture did not verify");
    }

    const output = runBun(["backend/scripts/doctor.ts", "--json"], {
      STORAGE_DIR: restored,
      DATABASE_URL: `file:${join(restored, "terrence.db")}`,
      ENCRYPTION_PASSWORD: "operations-docs-password",
      TERRENCE_DISABLE_WORKER: "true",
      TERRENCE_RUN_SANDBOX: "false",
    });
    const report = JSON.parse(output) as unknown;
    const checks = isRecord(report) && Array.isArray(report["checks"]) ? report["checks"].filter(isRecord) : [];
    if (!isRecord(report) || !Array.isArray(report["checks"]) || checks.length !== report["checks"].length || checks.some((check) => typeof check["name"] !== "string")) {
      throw new Error("doctor --json did not return a checks array");
    }
    const database = checks.find((check) => check["name"] === "database");
    const databaseStatus = typeof database?.["status"] === "string" ? database["status"] : "missing";
    if (databaseStatus !== "ok") throw new Error(`restored database diagnostic was ${databaseStatus}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, checks: ["configuration-contract", "migrated-database", "backup-checksum", "restore-files", "state-decryption", "execution-variables", "doctor"] }));
}

if (import.meta.main) await main();
