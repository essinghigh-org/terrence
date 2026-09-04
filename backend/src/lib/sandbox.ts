import { isAbsolute, join, dirname, resolve } from "path";
import { mkdir, rm } from "fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "os";
import { envEnabled } from "./env";
import type { Subprocess } from "bun";

/**
 * Landlock-based run sandbox for Terraform/OpenTofu execution.
 *
 * Instead of chroot (which requires root / CAP_SYS_CHROOT and device nodes),
 * Terrence executes IaC through `landlock-runner` — a tiny static helper that
 * applies a Linux Landlock filesystem allow-list to itself and then execs the
 * target. The restrictions are inherited by provider plugins and local-exec
 * provisioner shells, so untrusted IaC code can only reach:
 *
 *   - the run work directory            (read/write/execute — where tfstate,
 *     tfplan, .terraform and injected tfvars live)
 *   - the terraform/tofu binary dir     (read/execute)
 *   - system libraries and /bin,/usr/bin (read/execute, for the shell used by
 *     local-exec provisioners)
 *   - the system DNS configuration and CA certificate paths (read-only),
 *     /dev (read/write for /dev/null etc.)
 *
 * Everything else — including STORAGE_DIR (the database, .encryption-key,
 * configuration archives and other workspaces' state) — is unreachable.
 *
 * Requirements: Linux kernel >= 5.13 with Landlock enabled (CONFIG_SECURITY_LANDLOCK).
 * No privileges, no capabilities, no Docker seccomp/capability changes needed.
 * Fail-closed: the sandbox is REQUIRED by default (TERRENCE_RUN_SANDBOX unset
 * means sandboxed); disable it explicitly with TERRENCE_RUN_SANDBOX=false.
 */

const SANDBOX_DISABLED = ["false", "0", "none", "no", "off"].includes(
  (process.env["TERRENCE_RUN_SANDBOX"] ?? "true").toLowerCase(),
);

export function runNetPolicy(): "allow" | "deny" {
  const raw = (process.env["TERRENCE_RUN_NET_POLICY"] ?? "allow").toLowerCase().trim();
  return raw === "deny" ? "deny" : "allow";
}
export function runNetDenyEnabled(): boolean {
  return runNetPolicy() === "deny";
}

/**
 * Whether the run sandbox is required on this deployment. Single source of
 * truth shared by worker.ts (fail-closed guard) and health.ts (meta endpoint).
 * Fail-closed: the sandbox is required unless TERRENCE_RUN_SANDBOX is
 * explicitly set to false (the insecure opt-out).
 */
export function runSandboxRequired(): boolean {
  return !SANDBOX_DISABLED;
}

/** Candidate locations for the landlock-runner helper binary. */
function runnerCandidates(): string[] {
  const candidates: string[] = [];
  const envPath = process.env["TERRENCE_LANDLOCK_RUNNER"];
  if (typeof envPath === "string" && envPath !== "") candidates.push(envPath);
  candidates.push(join(import.meta.dir, "../../bin/landlock-runner"));
  candidates.push("/usr/local/bin/landlock-runner");
  candidates.push("/usr/bin/landlock-runner");
  return candidates;
}

function findRunner(): string | null {
  for (const candidate of runnerCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve a bare command name to an absolute regular executable file via
 * PATH. Returns null if not found, a directory, or not executable. */
function findExecutable(name: string): string | null {
  if (name === "") return null;
  if (isAbsolute(name)) return (existsSync(name) && statIsExecutable(name)) ? name : null;
  if (name.includes("/")) return null;
  const pathDirs = (process.env["PATH"] ?? "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    if (dir === "") continue;
    const candidate = join(resolve(dir), name);
    if (existsSync(candidate) && statIsExecutable(candidate)) return candidate;
  }
  return null;
}

const EXECUTABLE_BITS = 0o111;
function statIsExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & EXECUTABLE_BITS) !== 0;
  } catch {
    return false;
  }
}

let cachedAbi: number | null = null;

/** Query the Landlock ABI via the runner's --probe mode (0 = unavailable). */
export function probeLandlockAbi(): number {
  if (cachedAbi !== null) return cachedAbi;
  cachedAbi = 0;
  try {
    const runner = findRunner();
    if (runner === null) return 0;
    const proc = Bun.spawnSync([runner, "--probe"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode === 0) {
      const parsed = Number.parseInt(proc.stdout.toString().trim(), 10);
      if (Number.isSafeInteger(parsed) && parsed >= 1) cachedAbi = parsed;
    }
  } catch {
    cachedAbi = 0;
  }
  return cachedAbi;
}

/** Test hook: drop the cached ABI so a swapped TERRENCE_LANDLOCK_RUNNER takes effect. */
export function resetLandlockAbiCache(): void {
  cachedAbi = null;
}

/**
 * Mirror of landlock-runner.c's `abi_mask`: which filesystem access bits the
 * kernel accepts at a given Landlock ABI. REFER (rename/link between
 * hierarchies) requires ABI >= 2; TRUNCATE requires ABI >= 3. The C source
 * masks both the ruleset attr and every rule by probed ABI; this pure
 * function pins that truth table in unit tests without a kernel farm.
 */
function netRuleArgs(): string[] {
  if (!runNetDenyEnabled()) return [];
  const abi = probeLandlockAbi();
  if (abi < 4) {
    throw new Error(`Run network isolation requires Landlock ABI >= 4. Host ABI is ${abi}. Upgrade the kernel or set TERRENCE_RUN_NET_POLICY=allow.`);
  }
  return ["--deny-net"];
}

export function landlockAccessFlagsForAbi(abi: number): {
  refer: boolean;
  truncate: boolean;
  ioctlDevice: boolean;
  scopedIpc: boolean;
  resolveUnix: boolean;
} {
  return {
    refer: abi >= 2,
    truncate: abi >= 3,
    ioctlDevice: abi >= 5,
    scopedIpc: abi >= 6,
    resolveUnix: abi >= 9,
  };
}

/** Directories that must be traversable/readable for any dynamically linked
 *  binary or provisioner shell. */
function systemRuleArgs(): string[] {
  return [
    "/bin",
    "/usr/bin",
    "/sbin",
    "/usr/sbin",
    "/lib",
    "/lib64",
    "/usr/lib",
    "/usr/lib64",
  ].filter(existsSync).map((path): string => `--rx=${path}`);
}

/** Minimal system configuration allow-list needed by network clients. */
function systemEtcRuleArgs(): string[] {
  const candidates = [
    "/etc/resolv.conf",
    "/etc/ssl/certs",
    "/etc/ssl/cert.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ca-certificates",
  ];
  const paths = new Set<string>();
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      paths.add(realpathSync(candidate));
    } catch {
      paths.add(candidate);
    }
  }
  const resolvDir = resolvConfDir();
  if (resolvDir !== null) paths.add(resolvDir);
  return [...paths].map((path): string => `--ro=${path}`);
}

/** Minimal /dev allow-list (todo 10). The previous --rw-files=/dev granted
 *  read/write beneath the entire /dev tree. Prefer explicitly required
 *  devices so a compromised provisioner cannot reach /dev/shm, device nodes,
 *  or container sockets. /dev/shm is intentionally NOT allow-listed. */
function devRuleArgs(): string[] {
  const required = ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/full", "/dev/tty"] as const;
  const args: string[] = [];
  for (const p of required) {
    if (!existsSync(p)) continue;
    args.push(`--rw-files=${p}`);
  }
  return args;
}

/**
 * Landlock run sandbox. Instance methods mirror the chroot-era API so the
 * worker's call sites stay stable.
 */
export class RunSandbox {
  public readonly runner: string | null;
  public readonly abi: number;

  constructor() {
    this.runner = findRunner();
    this.abi = probeLandlockAbi();
  }

  /** True when the sandbox can be used on this host. */
  public static isUsable(): boolean {
    if (SANDBOX_DISABLED) return false;
    return probeLandlockAbi() >= 1;
  }

  /** True when the runner helper binary is present. */
  public static hasRunner(): boolean {
    return findRunner() !== null;
  }

  /** Host path for a run's working directory. Runs live under tmpdir (the
   *  same layout as the pre-sandbox worker). */
  public workDirFor(runId: string): string {
    return join(tmpdir(), "terrence", "runs", runId);
  }

  /**
   * No-op in the Landlock design: the binary is executed in place (its
   * directory is allow-listed per spawn), so no copy into a rootfs is needed.
   */
  public async ensureTool(_tool: string, _version: string, hostBinaryPath: string): Promise<string> {
    return hostBinaryPath;
  }

  /** Create the run workdir (writable by the sandboxed process — same user). */
  public async prepareWorkDir(runId: string): Promise<string> {
    const workDir = this.workDirFor(runId);
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    // TMPDIR points inside the workdir (the sandbox only allows writes there).
    await mkdir(join(workDir, "tmp"), { recursive: true, mode: 0o700 });
    return workDir;
  }

  /** Spawn a generic command (sentinel, etc.) under the Landlock allow-list.
     * Uses the same rules as terraform/tofu but with a custom binary. */
    public spawnGeneric(
      args: readonly string[],
      opts: Readonly<{ cwd: string; env: Readonly<Record<string, string>>; cgroup?: string | null }>,
    ): Subprocess<"ignore", "pipe", "pipe"> {
      let binaryPath = args[0] ?? "";
      if (this.runner === null) {
        throw new Error("landlock-runner binary not found; cannot sandbox run");
      }

      // Resolve bare commands (e.g. "sentinel") to absolute paths before
      // constructing Landlock rules. If unresolved, fail fast instead of
      // treating as current directory.
      if (binaryPath === "" || !isAbsolute(binaryPath)) {
        const found = findExecutable(binaryPath);
        if (found === null) {
          throw new Error(`executable not found: ${binaryPath}`);
        }
        binaryPath = found;
      }
      const resolvedArgs = [binaryPath, ...args.slice(1)];

      const workDir = this.workDirForRunCwd(opts.cwd);
      const binaryDir = dirname(binaryPath);
      const env: Record<string, string> = {
        ...opts.env,
        PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: workDir,
        TMPDIR: join(workDir, "tmp"),
        USER: process.env["USER"] ?? "nobody",
      };

      const runnerArgs = [
        this.runner,
        `--rwx=${workDir}`,
        `--rx=${binaryDir}`,
        ...systemRuleArgs(),
        ...systemEtcRuleArgs(),
        ...devRuleArgs(),
        ...netRuleArgs(),
        ...extraRwArgs(),
        `--cwd=${opts.cwd}`,
        "--",
        ...resolvedArgs,
      ];

      const spawnOpts: Record<string, unknown> = {
        env,
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      };
      if (typeof opts.cgroup === "string" && opts.cgroup !== "") {
        spawnOpts["cgroup"] = opts.cgroup;
      }

      return Bun.spawn(runnerArgs, spawnOpts as never);
    }

    /** Spawn a terraform/tofu command under the Landlock allow-list.
     * `args[0]` is the host binary path; `opts.cwd` is the host execution dir
     * (inside the run workdir). The helper applies the rules to itself, chdirs,
     * then execs — restrictions flow to provider and provisioner children.
     */
    public spawn(
      args: readonly string[],
      opts: Readonly<{ cwd: string; env: Readonly<Record<string, string>>; cgroup?: string | null }>,
    ): Subprocess<"ignore", "pipe", "pipe"> {
      return this.spawnGeneric(args, opts);
    }

  /** Resolve the run workdir containing a cwd (execution dir). */
  private workDirForRunCwd(cwd: string): string {
    // Canonicalize before trusting ancestry (todo 11): string-prefix checks
    // are symlink/traversal-sensitive. Resolve/realpath and prove containment.
    const runsBase = resolve(join(tmpdir(), "terrence", "runs"));
    let resolvedCwd: string;
    try {
      resolvedCwd = resolve(cwd);
      // Best-effort realpath to collapse symlinks when the path exists.
      try { resolvedCwd = realpathSync(resolvedCwd); } catch { /* use resolved */ }
    } catch {
      return cwd;
    }
    let resolvedBase = runsBase;
    try { resolvedBase = realpathSync(runsBase); } catch { /* use resolved */ }
    const prefix = resolvedBase.endsWith("/") ? resolvedBase : resolvedBase + "/";
    if (resolvedCwd === resolvedBase || resolvedCwd.startsWith(prefix)) {
      const rest = resolvedCwd === resolvedBase ? "" : resolvedCwd.slice(prefix.length);
      const runId = rest.split("/")[0] ?? "";
      if (runId !== "" && !runId.includes("/") && !runId.includes("\\")) {
        return join(resolvedBase, runId);
      }
    }
    // Fallback: use the canonicalized cwd itself (e.g. assessment dirs).
    return resolvedCwd;
  }
}

let cachedResolvDir: string | null | undefined;

function storageProtectionPrefix(allowStorage: boolean): string | null {
  if (allowStorage) return null;
  try {
    const { storageDir } = require("../db/driver") as { storageDir: string };
    const resolvedStorageDir = resolve(storageDir);
    return resolvedStorageDir.endsWith("/") ? resolvedStorageDir : resolvedStorageDir + "/";
  } catch { /* best-effort */ }
  return null;
}

/**
 * Extra read-write paths for the sandbox allow-list, from
 * TERRENCE_SANDBOX_EXTRA_RW_PATHS (colon-separated). TEST-ONLY: lets the
 * sandboxed fake-tofu write observability files outside the run workdir.
 *
 * SECURITY: this widens the sandbox boundary. It is honoured only when the
 * explicit opt-in TERRENCE_SANDBOX_EXTRA_RW_ALLOWED=true is set, so a
 * misconfigured deployment cannot silently enlarge the allow-list by setting
 * only the paths variable.
 */
function extraRwArgs(): string[] {
  if (!envEnabled(process.env["TERRENCE_SANDBOX_EXTRA_RW_ALLOWED"])) return [];
  const raw = process.env["TERRENCE_SANDBOX_EXTRA_RW_PATHS"];
  if (raw === undefined || raw === "") return [];
  const allowStorage = envEnabled(process.env["TERRENCE_SANDBOX_EXTRA_RW_ALLOW_STORAGE"]);
  const storagePrefix = storageProtectionPrefix(allowStorage);
  const out: string[] = [];
  for (const p of raw.split(":")) {
    if (p === "") continue;
    if (!isAbsolute(p)) continue;
    let canon = resolve(p);
    try { canon = realpathSync(canon); } catch { /* use resolved */ }
    // 71: unless explicitly allowed, never widen the sandbox beneath storage (protect DB/key).
    if (storagePrefix !== null && (canon === storagePrefix.slice(0, -1) || canon.startsWith(storagePrefix))) continue;
    out.push(`--rw=${canon}`);
  }
  if (out.length > 0) {
    // Todo 67: observable record so operators (and the UI banner from 66)
    // can correlate which widened paths are actually in effect.
    try {
      const { log } = require("./log") as { log: { warn: (msg: string, data?: unknown) => void } };
      log.warn("sandbox extra RW paths active", { paths: out.map((a) => a.slice("--rw=".length)) });
    } catch { /* logging is best-effort during early boot */ }
  }
  return out;
}

/** Directory holding the real resolv.conf (follows systemd-resolved symlinks). */
function resolvConfDir(): string | null {
  if (cachedResolvDir !== undefined) return cachedResolvDir;
  cachedResolvDir = null;
  try {
    const path = realpathSync("/etc/resolv.conf");
    if (path !== "/etc/resolv.conf") cachedResolvDir = dirname(path);
  } catch {
    cachedResolvDir = null;
  }
  return cachedResolvDir;
}

/** Delete a run workdir (worker cleanup). */
export async function removeSandboxWorkDir(runId: string): Promise<void> {
  await rm(join(tmpdir(), "terrence", "runs", runId), { recursive: true, force: true });
}
