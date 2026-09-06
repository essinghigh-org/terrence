/**
 * Execute the local, network-independent parts of the operations runbook.
 *
 * This intentionally uses a disposable SQLite directory.  It verifies that
 * the generated configuration contract is current, that the doctor command
 * can inspect a bootstrapped copy, and that a copy/restore retains the files
 * the backup instructions require.  Network checks are reported by doctor but
 * do not make this offline verification flaky.
 */
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const timeoutMs = 60_000;

type DoctorOutput = Readonly<{ checks: readonly Readonly<{ name: string; status: string }> [] }>;

function runBun(args: readonly string[], env: Readonly<Record<string, string>> = {}): string {
  const result = spawnSync("bun", [...args], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`bun ${args.join(" ")} failed (${String(result.status)}): ${(result.stderr ?? result.stdout).trim()}`);
  }
  return result.stdout;
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

async function main(): Promise<void> {
  const operations = await readFile(join(root, "backend/docs/operations.md"), "utf8");
  const upgrading = await readFile(join(root, "backend/docs/upgrading.md"), "utf8");
  const quickstart = await readFile(join(root, "backend/docs/quickstart.md"), "utf8");
  assertRunbookText(operations, ["tar --create", "sha256sum --check", "doctor.ts --json", "verify-operations-docs.ts"], "operations.md");
  assertRunbookText(upgrading, ["vX.Y.Z@sha256", "upgrade-invariants.test.ts", "forward-only"], "upgrading.md");
  assertRunbookText(quickstart, ["terraform login", "terraform init", "terraform plan"], "quickstart.md");
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
    sourceDatabase.run("CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL)");
    sourceDatabase.run("INSERT INTO users VALUES ('doc-user', 'admin')");
    sourceDatabase.close();
    await mkdir(join(source, "secrets"), { recursive: true });
    await writeFile(join(source, ".encryption-key"), "disposable-key\n", { mode: 0o600 });
    await writeFile(join(source, ".encryption-salt"), "disposable-salt\n", { mode: 0o600 });
    await writeFile(join(source, "secrets", "database-url"), "encrypted-envelope\n", { mode: 0o600 });

    const archive = join(backup, "storage.tar");
    runBun(["-e", `const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); execFileSync('tar',['--create','--file',${JSON.stringify(archive)},'--directory',${JSON.stringify(source)},'.']);`]);
    const digest = await sha256(archive);
    await writeFile(join(backup, "SHA256SUMS"), `${digest}  storage.tar\n`);
    if ((await sha256(archive)) !== digest) throw new Error("backup checksum changed before restore");
    await mkdir(restored, { recursive: true });
    runBun(["-e", `const {execFileSync}=require('node:child_process'); execFileSync('tar',['--extract','--file',${JSON.stringify(archive)},'--directory',${JSON.stringify(restored)}]);`]);
    if ((await sha256(archive)) !== (await readFile(join(backup, "SHA256SUMS"), "utf8")).split(/\s+/)[0]) {
      throw new Error("backup checksum verification failed");
    }
    for (const path of ["terrence.db", ".encryption-key", ".encryption-salt", "secrets/database-url"]) {
      if (!(await Bun.file(join(restored, path)).exists())) throw new Error(`restored backup is missing ${path}`);
    }

    const output = runBun(["backend/scripts/doctor.ts", "--json"], {
      STORAGE_DIR: restored,
      DATABASE_URL: `file:${join(restored, "terrence.db")}`,
      TERRENCE_DISABLE_WORKER: "true",
      TERRENCE_RUN_SANDBOX: "false",
    });
    const report = JSON.parse(output) as DoctorOutput;
    if (!Array.isArray(report.checks) || report.checks.some((check) => typeof check.name !== "string")) {
      throw new Error("doctor --json did not return a checks array");
    }
    const database = report.checks.find((check) => check.name === "database");
    if (database?.status !== "ok") throw new Error(`restored database diagnostic was ${database?.status ?? "missing"}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, checks: ["configuration-contract", "backup-checksum", "restore-files", "doctor"] }));
}

if (import.meta.main) await main();
