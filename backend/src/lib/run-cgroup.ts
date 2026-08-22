/**
 * Cgroup v2 management for IaC run subprocesses (kanban 8, 9).
 *
 * When the host delegates a cgroup hierarchy to the worker (writable
 * `/sys/fs/cgroup` or `TERRENCE_RUN_CGROUP_ROOT`), each run gets its own
 * cgroup:
 *
 *   - resource ceilings: CPU weight, memory.max, pids.max (todo 8)
 *   - hard cancellation: writing to cgroup.kill kills every process in the
 *     group atomically — SIGKILL cannot be caught, so daemonized or
 *     double-forked descendants that escape process-group termination
 *     are still reaped (todo 9)
 *
 * Everything degrades gracefully: when no writable hierarchy exists the
 * module reports disabled and callers fall back to process-group
 * termination. All writes are best-effort — a controller file that is
 * absent on a given kernel never fails the run.
 */
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Ceiling for a single run's process count. Generous: tofu + providers +
 * local-exec shells stay well below this; fork bombs do not. */
const DEFAULT_PID_LIMIT = 512;

/** Memory ceiling per run. Runs materialize configuration archives and
 * provider caches on disk, not RAM; 2 GiB absorbs realistic plans while
 * capping fork-bomb memory pressure. Overridable via
 * TERRENCE_RUN_CGROUP_MEMORY_MAX (bytes, "max"). */
const DEFAULT_MEMORY_MAX = "2147483648";

/** CPU weight (100 = default share). Runs yield to the control plane under
 * contention rather than starving it. */
const CPU_WEIGHT = "100";

export type RunCgroupLimits = Readonly<{
  /** bytes or "max" */
  readonly memoryMax: string;
  /** maximum concurrent processes in the run's cgroup */
  readonly pidMax: number;
  /** cpu.weight value */
  readonly cpuWeight: string;
}>;

export function resolveCgroupLimits(env: NodeJS.ProcessEnv = process.env): RunCgroupLimits {
  const rawMemory = env.TERRENCE_RUN_CGROUP_MEMORY_MAX?.trim();
  return {
    memoryMax: rawMemory !== undefined && rawMemory !== "" ? rawMemory : DEFAULT_MEMORY_MAX,
    pidMax: parsePositiveInt(env.TERRENCE_RUN_CGROUP_PIDS_MAX) ?? DEFAULT_PID_LIMIT,
    cpuWeight: env.TERRENCE_RUN_CGROUP_CPU_WEIGHT?.trim() || CPU_WEIGHT,
  };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Writable cgroup v2 root for per-run groups, or null when unavailable.
 * Probed once per call site via {@link probeCgroupRoot} (cached). */
export function findCgroupRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.TERRENCE_RUN_CGROUP_ROOT?.trim();
  if (configured !== undefined && configured !== "") {
    return isWritableCgroupRoot(configured) ? configured : null;
  }
  if (!env.TERRENCE_RUN_CGROUPS_DISABLED?.match(/^(1|true|yes)$/i)) {
    // Standard delegation point and the plain mount, both common.
    for (const candidate of ["/sys/fs/cgroup/terrence", "/sys/fs/cgroup"]) {
      if (isWritableCgroupRoot(candidate)) return candidate;
    }
  }
  return null;
}

function isWritableCgroupRoot(root: string): boolean {
  try {
    const controllers = readFileSync(join(root, "cgroup.controllers"), "utf8");
    if (!controllers.split(/\s+/).includes("pids")) return false;
    accessSync(root, constants.W_OK);
    // Creating a child requires "+" enabled on subtree_control for the
    // controllers we need. Enable them (idempotent); failure means no go.
    try {
      writeFileSync(join(root, "cgroup.subtree_control"), "+pids +memory +cpu");
    } catch {
      /* may already be enabled or delegated differently */
    }
    return true;
  } catch {
    return false;
  }
}

let cachedRoot: { value: string | null } | null = null;

/** Cached probe. Call resetCgroupRootCache() after changing env in tests. */
export function probeCgroupRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  cachedRoot ??= { value: findCgroupRoot(env) };
  return cachedRoot.value;
}

export function resetCgroupRootCache(): void {
  cachedRoot = null;
}

export function cgroupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return probeCgroupRoot(env) !== null;
}

/** Sanitize a run id into a safe cgroup directory name. Run ids are UUID-ish,
 * but defense-in-depth against traversal via crafted ids. */
function safeGroupName(runId: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(runId)) return null;
  if (runId.startsWith(".")) return null;
  return runId;
}

/** Create the per-run cgroup and apply limits. Returns the group path, or
 * null when cgroups are unavailable (callers proceed without one). */
export function createRunCgroup(runId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = probeCgroupRoot(env);
  if (root === null) return null;
  const name = safeGroupName(runId);
  if (name === null) return null;
  const path = join(root, name);
  try {
    mkdirSync(path, { recursive: true });
    const limits = resolveCgroupLimits(env);
    writeIfPossible(join(path, "memory.max"), limits.memoryMax);
    writeIfPossible(join(path, "pids.max"), String(limits.pidMax));
    writeIfPossible(join(path, "cpu.weight"), limits.cpuWeight);
    return path;
  } catch {
    // Partial creation is harmless: an empty cgroup consumes nothing.
    destroyRunCgroup(runId, env);
    return null;
  }
}

/** Attach a PID to the run's cgroup. Best-effort: ENOENT/ESRCH just means the
 * process already exited. */
export function attachToRunCgroup(pid: number, groupPath: string | null): void {
  if (groupPath === null || !Number.isFinite(pid) || pid <= 0) return;
  writeIfPossible(join(groupPath, "cgroup.procs"), String(pid));
}

/** Hard-kill everything in the run's cgroup (todo 9). cgroup.kill is
 * atomic kernel-side: no signal handling, no reparenting race. Returns
 * true when a kill was issued. */
export function killRunCgroup(runId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = runCgroupPath(runId, env);
  if (path === null) return false;
  let procs: string;
  try {
    procs = readFileSync(join(path, "cgroup.procs"), "utf8").trim();
  } catch {
    return false;
  }
  if (procs === "") return false;
  // cgroup.kill is the primary path: atomic kernel-side termination with no
  // PID-reuse risk. Fallback SIGKILL only when cgroup.kill is unavailable
  // (pre-5.14 kernels) so we never kill a recycled PID when the kernel op
  // succeeds.
  try {
    writeFileSync(join(path, "cgroup.kill"), "1");
    return true;
  } catch {
    /* older kernels lack cgroup.kill — fall back to per-PID SIGKILL */
  }
  return fallbackKillAll(path);
}

function fallbackKillAll(path: string): boolean {
  let killed = false;
  try {
    for (const line of readFileSync(join(path, "cgroup.procs"), "utf8").split("\n")) {
      const pid = Number.parseInt(line.trim(), 10);
      if (!Number.isFinite(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
        killed = true;
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* group gone */
  }
  return killed;
}

/** Whether any live process remains in the run's cgroup. */
export function runCgroupHasProcesses(runId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = runCgroupPath(runId, env);
  if (path === null) return false;
  try {
    return readFileSync(join(path, "cgroup.procs"), "utf8").trim() !== "";
  } catch {
    return false;
  }
}

/** Resolve the current group path for a run (null when cgroups off). */
export function runCgroupPath(runId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = probeCgroupRoot(env);
  if (root === null) return null;
  const name = safeGroupName(runId);
  if (name === null) return null;
  return join(root, name);
}

/** Remove the run's cgroup once its processes are gone. Safe to call even
 * while processes linger — rmdir only succeeds on empty groups, so cleanup
 * can be retried later without killing anything. */
export function destroyRunCgroup(runId: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = runCgroupPath(runId, env);
  if (path === null) return;
  try {
    rmSync(path, { recursive: false, force: false });
  } catch {
    /* non-empty or already gone — retried by sweep/cleanup paths */
  }
}

function writeIfPossible(file: string, value: string): void {
  try {
    accessSync(file, constants.W_OK);
    writeFileSync(file, value);
  } catch {
    /* controller not exposed on this kernel — skip */
  }
}
