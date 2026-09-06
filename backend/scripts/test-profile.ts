import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  managedCommand,
  normalizeOperationalTestSeed,
  operationalTestProfiles,
  parseOperationalTestProfile,
  redactOperationalDiagnostic,
  redactOperationalEnvironment,
  terminateManagedProcess,
  type OperationalTestProfile,
  type OperationalTestProfileName,
} from "../src/lib/operational-test-profile";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI_MATRIX_PATH = join(REPO_ROOT, "backend/tests/e2e/cli_matrix.json");
const MAX_DIAGNOSTIC_BYTES = 200_000;
const PROFILE_ENV_NAMES = new Set(["TERRENCE_E2E_PROFILE", "TERRENCE_E2E_ROOT", "TERRENCE_E2E_RESULTS_DIR", "TERRENCE_E2E_SEED"]);

type ParsedArgs = Readonly<{
  profile: OperationalTestProfileName | undefined;
  seed: string | undefined;
  artifactDirectory: string | undefined;
  keepArtifacts: boolean;
  list: boolean;
  help: boolean;
}>;

type CliTier = "floor" | "current" | "canary";
type CliMatrix = Readonly<Record<"terraform" | "tofu", Readonly<{ floor: string; current: string }>>>;

type ProfileArtifact = {
  schemaVersion: 1;
  profile: OperationalTestProfileName;
  description: string;
  seed: string;
  mode: OperationalTestProfile["mode"];
  database: OperationalTestProfile["database"];
  sandbox: OperationalTestProfile["sandbox"];
  command: string;
  cwd: string;
  temporaryRoot: string;
  artifactDirectory: string;
  environment: Readonly<Record<string, string>>;
  cli: Readonly<{ filter: string | null; tier: string | null; pinnedVersions: Readonly<Record<string, string>> }>;
  status: "running" | "passed" | "failed" | "cleanup-failed";
  exitCode: number | null;
  startedAt: string;
  completedAt?: string;
  cleanupErrors?: readonly string[];
  reproductionCommand: string;
};

function usage(): string {
  return [
    "Usage: bun run backend/scripts/test-profile.ts <profile> [options]",
    "",
    "Profiles:",
    ...Object.values(operationalTestProfiles).map((profile) => `  ${profile.name.padEnd(14)} ${profile.description}`),
    "",
    "Options:",
    "  --seed <id>             Stable fixture seed (default: eng21)",
    "  --keep-artifacts        Preserve the temporary profile directory",
    "  --artifact-dir <path>   Copy redacted artifacts to this directory",
    "  --list                  List profiles without running one",
    "  --help                  Show this help",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let profile: string | undefined;
  let seed: string | undefined;
  let artifactDirectory: string | undefined;
  let keepArtifacts = false;
  let list = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined || value === "--") continue;
    if (value === "--help" || value === "-h") {
      help = true;
      continue;
    }
    if (value === "--list") {
      list = true;
      continue;
    }
    if (value === "--keep-artifacts") {
      keepArtifacts = true;
      continue;
    }
    if (value === "--seed") {
      seed = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--artifact-dir") {
      artifactDirectory = argv[index + 1];
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option ${value}`);
    if (profile !== undefined) throw new Error(`Unexpected argument ${value}`);
    profile = value;
  }
  if (profile !== undefined) parseOperationalTestProfile(profile);
  return { profile: profile as OperationalTestProfileName | undefined, seed, artifactDirectory, keepArtifacts, list, help };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandText(command: readonly string[]): string {
  return command.map(shellQuote).join(" ");
}

function boundedDiagnostic(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_DIAGNOSTIC_BYTES) return value;
  const half = Math.floor(MAX_DIAGNOSTIC_BYTES / 2);
  const first = Buffer.from(value, "utf8").subarray(0, half).toString("utf8");
  const last = Buffer.from(value, "utf8").subarray(-half).toString("utf8");
  return `${first}\n...[diagnostic truncated; tail follows]...\n${last}`;
}

async function loadCliMatrix(): Promise<CliMatrix> {
  return JSON.parse(await readFile(CLI_MATRIX_PATH, "utf8")) as CliMatrix;
}

function selectedTier(): CliTier {
  const tier = process.env["TERRENCE_E2E_TIER"] ?? "current";
  if (tier === "floor" || tier === "current" || tier === "canary") return tier;
  throw new Error("TERRENCE_E2E_TIER must be floor, current or canary");
}

async function pinnedVersions(): Promise<Readonly<Record<string, string>>> {
  const tier = selectedTier();
  if (tier === "canary") return { terraform: "latest", tofu: "latest" };
  const matrix = await loadCliMatrix();
  const pinnedTier: "floor" | "current" = tier;
  return { terraform: matrix.terraform[pinnedTier], tofu: matrix.tofu[pinnedTier] };
}

function assertRealProfileEnvironment(profile: OperationalTestProfile): void {
  if (profile.mode !== "real-cli") return;
  const simulated = process.env["SIMULATED_RUNS"]?.toLowerCase();
  if (simulated === "1" || simulated === "true") {
    throw new Error(`${profile.name} is a real-cli profile and refuses SIMULATED_RUNS=true; use unit-api for simulated execution`);
  }
  if (profile.name === "sandbox" && process.env["TERRENCE_E2E_SECURITY_PROFILE"] === "disabled") {
    throw new Error("sandbox profile requires TERRENCE_E2E_SECURITY_PROFILE=required and will not downgrade to disabled");
  }
  if (profile.database === "postgres" && process.env["DATABASE_URL"] !== undefined && !/^postgres(?:ql)?:\/\//i.test(process.env["DATABASE_URL"] ?? "")) {
    throw new Error("postgres-cli requires a postgres:// or postgresql:// DATABASE_URL and will not fall back to SQLite");
  }
}

function childEnvironment(profile: OperationalTestProfile, root: string, artifacts: string, seed: string, versions: Readonly<Record<string, string>>): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined
    && !PROFILE_ENV_NAMES.has(entry[0])
    && entry[0] !== "DATABASE_URL"
    && entry[0] !== "STORAGE_DIR"));
  const environment: Record<string, string> = {
    ...inherited,
  };
  if (profile.mode === "simulated") {
    environment.NODE_ENV = "test";
    environment.SIMULATED_RUNS = "true";
    environment.TERRENCE_RUN_SANDBOX = "false";
    environment.TERRENCE_DISABLE_WORKER = "1";
    environment.DATABASE_URL = `file:${join(root, "unit.db")}`;
    environment.STORAGE_DIR = join(root, "storage");
  } else if (profile.mode === "real-cli") {
    environment.NODE_ENV = "production";
    environment.SIMULATED_RUNS = "false";
    environment.TERRENCE_E2E_PROFILE = profile.name;
    environment.TERRENCE_E2E_ROOT = root;
    environment.TERRENCE_E2E_RESULTS_DIR = artifacts;
    environment.TERRENCE_E2E_SEED = seed;
    environment.TERRENCE_E2E_TIER = process.env["TERRENCE_E2E_TIER"] ?? "current";
    environment.TERRENCE_E2E_SECURITY_PROFILE = profile.sandbox === "required" ? "required" : "disabled";
    environment.TERRENCE_E2E_TERRAFORM_VERSION = versions.terraform ?? "";
    environment.TERRENCE_E2E_TOFU_VERSION = versions.tofu ?? "";
    if (profile.database === "sqlite") {
      // `file:` is only a selector for the harness; startBackend allocates a
      // fresh database directory below TERRENCE_E2E_ROOT.
      environment.DATABASE_URL = "file:";
    } else if (profile.database === "postgres") {
      environment.DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://terrence:terrence@127.0.0.1:5432/terrence_test";
    }
  }
  if (profile.name === "sandbox") environment.TERRENCE_E2E_CLI = "terraform";
  return environment;
}

function reproductionCommand(profile: OperationalTestProfileName, seed: string): string {
  return `TERRENCE_E2E_SEED=${shellQuote(seed)} bun run test:profile -- ${shellQuote(profile)} --keep-artifacts`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function collectOutput(stream: ReadableStream<Uint8Array> | null | undefined, target: Pick<NodeJS.WriteStream, "write">): Promise<string> {
  if (stream === null || stream === undefined) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = decoder.decode(result.value, { stream: true });
    chunks.push(chunk);
    target.write(chunk);
  }
  const tail = decoder.decode();
  if (tail !== "") {
    chunks.push(tail);
    target.write(tail);
  }
  return chunks.join("");
}

async function copyArtifacts(sourceDirectory: string, targetDirectory: string, profile: OperationalTestProfileName, seed: string): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });
  const prefix = `${profile}-${seed}-`;
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = join(sourceDirectory, entry.name);
    await copyFile(source, join(targetDirectory, `${prefix}${entry.name}`));
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.list) {
    console.log(usage());
    return 0;
  }
  if (args.profile === undefined) throw new Error(usage());
  const profile = parseOperationalTestProfile(args.profile);
  assertRealProfileEnvironment(profile);
  const seed = normalizeOperationalTestSeed(args.seed ?? process.env["TERRENCE_E2E_SEED"]);
  const versions = profile.mode === "real-cli" ? await pinnedVersions() : {};
  // Short prefix on purpose: sandboxed CLI runs inherit a TMPDIR nested
  // below this root, and terraform's go-plugin binds its provider socket
  // under $TMPDIR where AF_UNIX paths cap at 107 usable bytes. Every
  // character saved here is socket headroom (see assertCliDirFitsSocket).
  const root = await mkdtemp(join(tmpdir(), `te2e-${profile.name}-`));
  const artifactDirectory = join(root, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const externalArtifactDirectory = args.artifactDirectory ?? process.env["TERRENCE_E2E_RESULTS_DIR"];
  const cwd = profile.cwd === "backend" ? join(REPO_ROOT, "backend") : REPO_ROOT;
  const command = profile.command;
  const childEnv = childEnvironment(profile, root, artifactDirectory, seed, versions);
  const commandForDisplay = commandText(command);
  const repro = reproductionCommand(profile.name, seed);
  const startedAt = new Date().toISOString();
  const artifact: ProfileArtifact = {
    schemaVersion: 1,
    profile: profile.name,
    description: profile.description,
    seed,
    mode: profile.mode,
    database: profile.database,
    sandbox: profile.sandbox,
    command: commandForDisplay,
    cwd,
    temporaryRoot: root,
    artifactDirectory,
    environment: redactOperationalEnvironment(childEnv),
    cli: {
      filter: process.env["TERRENCE_E2E_CLI"] ?? null,
      tier: profile.mode === "real-cli" ? (process.env["TERRENCE_E2E_TIER"] ?? "current") : null,
      pinnedVersions: versions,
    },
    status: "running",
    exitCode: null,
    startedAt,
    reproductionCommand: repro,
  };
  await writeJson(join(root, "profile.json"), artifact);
  await writeFile(join(root, "reproduce.sh"), `#!/bin/sh\nset -eu\ncd ${shellQuote(REPO_ROOT)}\nexec ${repro}\n`, { mode: 0o700 });
  console.log(`[profile] name=${profile.name} mode=${profile.mode} database=${profile.database} sandbox=${profile.sandbox} seed=${seed}`);
  console.log(`[profile] pinned-cli=${JSON.stringify(versions)}`);
  console.log(`[profile] reproduction: ${repro}`);

  let exitCode = 1;
  let stdout = "";
  let stderr = "";
  let processHandle: Bun.Subprocess | undefined;
  const onSignal = (): void => {
    if (processHandle !== undefined) void terminateManagedProcess(processHandle);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    processHandle = Bun.spawn(managedCommand(command), {
      cwd,
      env: childEnv,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await Promise.all([
      collectOutput(processHandle.stdout, process.stdout),
      collectOutput(processHandle.stderr, process.stderr),
      processHandle.exited,
    ]);
    stdout = output[0];
    stderr = output[1];
    exitCode = output[2];
  } catch (error) {
    stderr = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(stderr);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (processHandle !== undefined) {
      // Signal the session after normal exit too: a test runner can leave a
      // plugin child behind after its leader has reported a failure.
      await terminateManagedProcess(processHandle).catch((error: unknown): void => {
        stderr += `\nprocess cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      });
    }
  }

  await writeFile(join(artifactDirectory, "stdout.log"), boundedDiagnostic(redactOperationalDiagnostic(stdout)), { mode: 0o600 });
  await writeFile(join(artifactDirectory, "stderr.log"), boundedDiagnostic(redactOperationalDiagnostic(stderr)), { mode: 0o600 });
  if (exitCode !== 0) {
    await writeJson(join(artifactDirectory, "failure.json"), {
      profile: profile.name,
      seed,
      mode: profile.mode,
      command: commandForDisplay,
      reproductionCommand: repro,
      exitCode,
      stdout: boundedDiagnostic(redactOperationalDiagnostic(stdout)),
      stderr: boundedDiagnostic(redactOperationalDiagnostic(stderr)),
    });
  }

  const cleanupErrors: string[] = [];
  const completedAt = new Date().toISOString();
  const keep = args.keepArtifacts || externalArtifactDirectory !== undefined;
  const finalStatus = exitCode === 0 ? "passed" : "failed";
  const finalArtifact: ProfileArtifact = {
    ...artifact,
    status: finalStatus,
    exitCode,
    completedAt,
    ...(cleanupErrors.length === 0 ? {} : { cleanupErrors }),
  };
  await writeJson(join(root, "profile.json"), finalArtifact);
  if (externalArtifactDirectory !== undefined) {
    try {
      await copyArtifacts(artifactDirectory, externalArtifactDirectory, profile.name, seed);
      await copyFile(join(root, "profile.json"), join(externalArtifactDirectory, `${profile.name}-${seed}-profile.json`));
      await copyFile(join(root, "reproduce.sh"), join(externalArtifactDirectory, `${profile.name}-${seed}-reproduce.sh`));
    } catch (error) {
      cleanupErrors.push(`artifact copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (keep) {
    console.log(`[profile] artifacts kept: ${root}`);
  } else {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`temporary directory cleanup failed: ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (cleanupErrors.length > 0) {
    for (const error of cleanupErrors) console.error(`[profile] ${error}`);
    if (exitCode === 0) exitCode = 1;
  }
  if (exitCode !== 0) console.error(`[profile] failed; rerun with: ${repro}`);
  return exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(redactOperationalDiagnostic(error instanceof Error ? error.message : String(error)));
    console.error(`\n${usage()}`);
    process.exitCode = 2;
  }
}

export { main as runOperationalTestProfile, parseArgs };
