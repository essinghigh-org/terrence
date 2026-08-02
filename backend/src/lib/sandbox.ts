import { join, dirname } from "path";
import { mkdir, rm } from "fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "os";
import { spawn } from "bun";
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
 *   - /etc (read-only: resolv.conf, CA certs), the resolv.conf realpath dir
 *     (systemd-resolved stub), /dev (read/write for /dev/null etc.)
 *
 * Everything else — including STORAGE_DIR (the database, .encryption-key,
 * configuration archives and other workspaces' state) — is unreachable.
 *
 * Requirements: Linux kernel >= 5.13 with Landlock enabled (CONFIG_SECURITY_LANDLOCK).
 * No privileges, no capabilities, no Docker seccomp/capability changes needed.
 * Disable with TERRENCE_RUN_SANDBOX=false.
 */

const SANDBOX_DISABLED = ["false", "0", "none", "no", "off"].includes(
  (process.env.TERRENCE_RUN_SANDBOX ?? "true").toLowerCase(),
);

/**
 * Whether the run sandbox is required on this deployment. Single source of
 * truth shared by worker.ts (fail-closed guard) and health.ts (meta endpoint).
 * Any value other than the explicit disable set keeps the sandbox required.
 */
export function runSandboxRequired(): boolean {
  return !SANDBOX_DISABLED;
}

/** Candidate locations for the landlock-runner helper binary. */
function runnerCandidates(): string[] {
  const candidates: string[] = [];
  const envPath = process.env.TERRENCE_LANDLOCK_RUNNER;
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

  /**
   * Spawn a terraform/tofu command under the Landlock allow-list.
   * `args[0]` is the host binary path; `opts.cwd` is the host execution dir
   * (inside the run workdir). The helper applies the rules to itself, chdirs,
   * then execs — restrictions flow to provider and provisioner children.
   */
  public spawn(
    args: readonly string[],
    opts: Readonly<{ cwd: string; env: Readonly<Record<string, string>> }>,
  ): Subprocess<"ignore", "pipe", "pipe"> {
    const binaryPath = args[0] ?? "";
    if (this.runner === null) {
      throw new Error("landlock-runner binary not found; cannot sandbox run");
    }

    const workDir = this.workDirForRunCwd(opts.cwd);
    const binaryDir = dirname(binaryPath);
    const resolvDir = resolvConfDir();

    const env: Record<string, string> = {
      ...opts.env,
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: workDir,
      TMPDIR: join(workDir, "tmp"),
      USER: process.env.USER ?? "nobody",
    };

    const runnerArgs = [
      this.runner,
      `--rwx=${workDir}`,
      `--rx=${binaryDir}`,
      ...systemRuleArgs(),
      "--ro=/etc",
      `--rw-files=/dev`,
      ...(resolvDir !== null ? [`--ro=${resolvDir}`] : []),
      ...extraRwArgs(),
      `--cwd=${opts.cwd}`,
      "--",
      ...args,
    ];

    return spawn(runnerArgs, { env, stdout: "pipe", stderr: "pipe" });
  }

  /** Resolve the run workdir containing a cwd (execution dir). */
  private workDirForRunCwd(cwd: string): string {
    // The run workdir is the tmpdir/terrence/runs/<runId> ancestor of cwd.
    const runsBase = join(tmpdir(), "terrence", "runs");
    if (cwd.startsWith(runsBase + "/")) {
      const rest = cwd.slice(runsBase.length + 1);
      const runId = rest.split("/")[0] ?? "";
      return join(runsBase, runId);
    }
    // Fallback: use the cwd itself (e.g. assessment dirs under tmpdir).
    return cwd;
  }
}

let cachedResolvDir: string | null | undefined;

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
  if (process.env.TERRENCE_SANDBOX_EXTRA_RW_ALLOWED !== "true") return [];
  const raw = process.env.TERRENCE_SANDBOX_EXTRA_RW_PATHS;
  if (raw === undefined || raw === "") return [];
  return raw.split(":").filter((p): boolean => p !== "").map((p): string => `--rw=${p}`);
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
