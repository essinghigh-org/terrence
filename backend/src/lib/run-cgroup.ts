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
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
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
 * null when cgroups are unavailable (callers proceed without one).
 *
 * A leftover group with the same name (a previous run of the same id that was
 * killed but whose directory could not be removed yet) must not be reused: a
 * group whose members were culled via cgroup.kill SIGKILLs freshly attached
 * processes until it is deleted and recreated, and a still-populated group
 * would couple two runs' cancellation. When the stale removal fails the
 * creation fails closed (null) — runs proceed without a cgroup rather than
 * sharing one. */
export function createRunCgroup(runId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = probeCgroupRoot(env);
  if (root === null) return null;
  const name = safeGroupName(runId);
  if (name === null) return null;
  const path = join(root, name);
  // Remove any leftover group from a previous run of this id. Only ENOENT
  // counts as success; anything else leaves an unknown-state group behind.
  if (!removeCgroupDir(path)) return null;
  try {
    mkdirSync(path, { recursive: true });
    const limits = resolveCgroupLimits(env);
    // On a real cgroup the controller files always exist and accept plain
    // writes; cgroupfs serializes concurrent writers. There is deliberately
    // no existence check: writeFileSync opens with O_CREAT|O_TRUNC, so a
    // missing file is created and an existing virtual kernel file is simply
    // rewritten. Any failure (read-only fs, absent controller) skips that
    // limit exactly like the old best-effort behavior.
    const limitsByFile: Readonly<Record<string, string>> = {
      "memory.max": limits.memoryMax,
      "pids.max": String(limits.pidMax),
      "cpu.weight": limits.cpuWeight,
    };
    for (const [controller, value] of Object.entries(limitsByFile)) {
      const file = join(path, controller);
      try {
        writeFileSync(file, value);
      } catch { /* read-only or absent controller: skip */ }
    }
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
  // PID-reuse risk. On a fake/test root the write succeeds but does nothing
  // (no kernel behind the files), so also kill the listed PIDs when the file
  // did not exist before the call. Real kernels already have cgroup.kill; the
  // extra signals are harmless (ESRCH).
  const hadKillFile = (() => {
    try {
      accessSync(join(path, "cgroup.kill"), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  })();
  let cgroupKillOk = false;
  try {
    writeFileSync(join(path, "cgroup.kill"), "1");
    cgroupKillOk = true;
  } catch {
    /* older kernels lack cgroup.kill — fall back to per-PID SIGKILL */
  }
  if (cgroupKillOk && hadKillFile) return true;
  // No kernel cgroup.kill (fake root or missing file): kill the listed PIDs.
  // If cgroup.kill succeeded on a real kernel this second pass is redundant
  // but harmless — all PIDs are already ESRCH.
  const fallbackKilled = fallbackKillAll(path);
  return cgroupKillOk || fallbackKilled;
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
  removeCgroupDir(path);
}

/**
 * Delete an empty cgroup directory. `rmdirSync` (not rmSync) is required:
 * cgroup directories reject unlink(2) — only rmdir(2) works, and the kernel
 * removes them lazily once the last process leaves and no files are held.
 *
 * On a real cgroup the kernel owns every file inside, so a group whose
 * processes have drained is always rmdir-able. A non-kernel directory (fake
 * roots in tests) may hold plain files; those are unlinked before retrying.
 * Returns true when the directory is gone.
 */
function removeCgroupDir(path: string): boolean {
  // A populated group must never be deleted out from under its processes.
  try {
    const procs = readFileSync(join(path, "cgroup.procs"), "utf8").trim();
    if (procs !== "") return false;
  } catch (error: unknown) {
    // ENOENT is fine (kernel removed it already, or a fake root without the
    // file); any other read failure means we cannot prove it drained.
    const code = error !== null && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
    if (code !== "ENOENT") return false;
  }
  try {
    rmdirSync(path);
    return true;
  } catch (error: unknown) {
    // ENOENT means it is already gone — success from the caller's viewpoint.
    if (error !== null && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return true;
    }
    if (error !== null && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOTEMPTY") {
      // Kernel cgroups never reach here: their files are virtual and rmdir
      // succeeds once drained. Plain-file leftovers (fake/test roots) can be
      // cleared by hand before a final rmdir.
      try {
        for (const entry of readdirSync(path)) {
          const child = join(path, entry);
          const stat = lstatSync(child);
          if (!stat.isDirectory()) unlinkSync(child);
        }
        rmdirSync(path);
        return true;
      } catch {
        return false;
      }
    }
    /* EBUSY/EPERM: still populated or held open by a liveness watcher.
     * Reported to the caller, which must not reuse the group. */
    return false;
  }
}

function writeIfPossible(file: string, value: string): void {
  // No W_OK pre-check on purpose: check-then-write races the file away. The
  // write's own errno (ENOENT/EACCES/EROFS) carries the same information
  // without the TOCTOU window.
  try {
    writeFileSync(file, value);
  } catch {
    /* controller not exposed on this kernel — skip */
  }
}
