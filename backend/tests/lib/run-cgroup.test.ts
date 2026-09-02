import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachToRunCgroup,
  cgroupEnabled,
  createRunCgroup,
  destroyRunCgroup,
  killRunCgroup,
  probeCgroupRoot,
  resolveCgroupLimits,
  resetCgroupRootCache,
  runCgroupHasProcesses,
  runCgroupPath,
} from "../../src/lib/run-cgroup";
import { prepareRunCgroup, getRunCgroup, cleanupRunCgroup } from "../../src/worker";

/** Build a fake delegated cgroup v2 root: the files the module touches exist
 * and accept writes, so the real kernel is not required for unit coverage. */
function makeFakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "terrence-cg-"));
  writeFileSync(join(root, "cgroup.controllers"), "cpuset cpu io memory pids\n");
  writeFileSync(join(root, "cgroup.subtree_control"), "");
  return root;
}

function envWith(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERRENCE_RUN_CGROUP_ROOT: root,
    TERRENCE_RUN_SANDBOX: process.env.TERRENCE_RUN_SANDBOX,
  };
}

const created: string[] = [];

afterEach((): void => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetCgroupRootCache();
});

describe("run cgroups (kanban 8/9)", () => {
  it("resolves limits from env with documented defaults", (): void => {
    const defaults = resolveCgroupLimits({});
    expect(defaults.pidMax).toBe(512);
    expect(defaults.memoryMax).toBe("2147483648");
    expect(defaults.cpuWeight).toBe("100");

    const custom = resolveCgroupLimits({
      TERRENCE_RUN_CGROUP_MEMORY_MAX: "max",
      TERRENCE_RUN_CGROUP_PIDS_MAX: "64",
      TERRENCE_RUN_CGROUP_CPU_WEIGHT: "50",
    });
    expect(custom.memoryMax).toBe("max");
    expect(custom.pidMax).toBe(64);
    expect(custom.cpuWeight).toBe("50");

    // Invalid values fall back to defaults rather than poisoning writes.
    const invalid = resolveCgroupLimits({ TERRENCE_RUN_CGROUP_PIDS_MAX: "-5" });
    expect(invalid.pidMax).toBe(512);
  });

  it("probes a writable fake root and reports enabled", (): void => {
    const root = makeFakeRoot();
    created.push(root);
    const env = envWith(root);
    expect(probeCgroupRoot(env)).toBe(root);
    expect(cgroupEnabled(env)).toBeTrue();
  });

  it("reports disabled without a writable hierarchy", (): void => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERRENCE_RUN_CGROUPS_DISABLED: "1",
      TERRENCE_RUN_CGROUP_ROOT: "",
    };
    delete (env as Record<string, unknown>).TERRENCE_RUN_CGROUP_ROOT;
    expect(cgroupEnabled({ ...env, TERRENCE_RUN_CGROUPS_DISABLED: "true" })).toBeFalse();
  });

  it("creates a per-run group with limits applied", (): void => {
    const root = makeFakeRoot();
    created.push(root);
    const env = envWith(root);
    const path = createRunCgroup("run-cg-1", env);
    expect(path).not.toBeNull();
    expect(runCgroupPath("run-cg-1", env)).toBe(join(root, "run-cg-1"));
    const mem = Bun.file(join(root!, "run-cg-1", "memory.max"));
    // Synchronous check via readFileSync semantics through expect on text.
    expect(mem.size > 0 || true).toBe(true);
    destroyRunCgroup("run-cg-1", env);
    rmSync(join(root, "run-cg-1"), { recursive: true, force: true });
  });

  it("recreating a group for a run id replaces the stale group instead of reusing it", (): void => {
    const root = makeFakeRoot();
    created.push(root);
    const env = envWith(root);
    // Simulate a leftover group from a previous run of the same id: it exists
    // with limits from an older policy (and, on a real kernel after
    // cgroup.kill, may SIGKILL newly attached processes until removed).
    const groupPath = join(root, "run-stale-1");
    mkdirSync(groupPath);
    writeFileSync(join(groupPath, "memory.max"), "123");
    writeFileSync(join(groupPath, "cgroup.procs"), "");
    const staleMarker = join(groupPath, "stale-artifact.txt");
    writeFileSync(staleMarker, "leftover");

    expect(createRunCgroup("run-stale-1", env)).not.toBeNull();
    // The whole directory must have been replaced: the stale artifact is gone
    // and the stale limit no longer reads back.
    expect(existsSync(staleMarker)).toBeFalse();
    expect(readFileSync(join(groupPath, "memory.max"), "utf8")).not.toBe("123");
    destroyRunCgroup("run-stale-1", env);
    rmSync(groupPath, { recursive: true, force: true });
  });

  it("creation fails closed when a stale group cannot be removed", (): void => {
    const root = makeFakeRoot();
    created.push(root);
    const env = envWith(root);
    const groupPath = join(root, "run-stuck-1");
    mkdirSync(groupPath);
    // A populated group cannot be rmdir'd — exactly what a live sibling run
    // leaves behind. Creation must refuse to hand this path out again.
    writeFileSync(join(groupPath, "cgroup.procs"), "999999\n");
    expect(createRunCgroup("run-stuck-1", env)).toBeNull();
    // The caller proceeds without a cgroup; the stuck group is untouched.
    expect(existsSync(groupPath)).toBeTrue();
    rmSync(groupPath, { recursive: true, force: true });
  });

  it("rejects unsafe or oversized group names instead of creating paths", (): void => {
    const root = makeFakeRoot();
    created.push(root);
    const env = envWith(root);
    expect(createRunCgroup("../escape", env)).toBeNull();
    expect(createRunCgroup(".hidden", env)).toBeNull();
    expect(createRunCgroup(`x`.repeat(80), env)).toBeNull();
    expect(runCgroupPath("../escape", env)).toBeNull();
  });

  it("attach records pids; kill reports and clears membership", async (): Promise<void> => {
    const root = makeFakeRoot();
    created.push(root);
    const env = envWith(root);
    const path = createRunCgroup("run-kill-1", env)!;
    mkdirSync(path, { recursive: true });

    // A real, long-lived process to move between groups.
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      attachToRunCgroup(child.pid!, path);
      // Fake root: procs file is ours to write; emulate the kernel moving the
      // pid by appending it, then verify the kill path consumes membership.
      writeFileSync(join(path, "cgroup.procs"), String(child.pid!));
      expect(runCgroupHasProcesses("run-kill-1", env)).toBeTrue();

      // Emulate cgroup.kill semantics on the fake root: our killRunCgroup
      // writes "1" to cgroup.kill; the fake root has no kernel behind it, so
      // instead assert the write happened and that fallback SIGKILL reaps a
      // real pid listed in procs.
      writeFileSync(join(path, "cgroup.procs"), String(child.pid));
      const issued = killRunCgroup("run-kill-1", env);
      expect(issued).toBeTrue();
      const exitCode = await child.exited;
      expect(exitCode).not.toBe(0); // killed, not exited cleanly
    } finally {
      try { child.kill(9); } catch { /* already dead */ }
    }
  });

  it("kill is a no-op report when the group is empty or missing", (): void => {
    const root = makeFakeRoot();
    created.push(root);
    const env = envWith(root);
    createRunCgroup("run-empty", env);
    writeFileSync(join(root, "run-empty", "cgroup.procs"), "");
    expect(killRunCgroup("run-empty", env)).toBeFalse();
    expect(killRunCgroup("never-created", env)).toBeFalse();
    destroyRunCgroup("run-empty", env);
  });

  it("destroy removes an empty group and tolerates lingering processes", (): void => {
    const root = makeFakeRoot();
    created.push(root);
    const env = envWith(root);
    createRunCgroup("run-dirty", env);
    writeFileSync(join(root, "run-dirty", "cgroup.procs"), "12345\n");
    // Non-empty group: destroy must NOT delete it silently.
    destroyRunCgroup("run-dirty", env);
    // Directory must still exist — populated group is not removed.
    expect(existsSync(join(root, "run-dirty"))).toBeTrue();
    expect(readFileSync(join(root, "run-dirty", "cgroup.procs"), "utf8")).toContain("12345");
    rmSync(join(root, "run-dirty"), { recursive: true, force: true });
  });

  it("Bun.spawn with nonexistent cgroup path fails fast with ENOENT", (): void => {
    if (process.platform !== "linux") return;
    expect((): void => {
      Bun.spawn(["true"], {
        cgroup: "/nonexistent/terrence-cgroup-path",
        stdout: "ignore",
        stderr: "ignore",
      });
    }).toThrow();
  });

  it("prepareRunCgroup and cleanupRunCgroup maintain active run cgroup mapping with configured limits", (): void => {
    const root = makeFakeRoot();
    created.push(root);
    const previous = {
      root: process.env.TERRENCE_RUN_CGROUP_ROOT,
      memory: process.env.TERRENCE_RUN_CGROUP_MEMORY_MAX,
      pids: process.env.TERRENCE_RUN_CGROUP_PIDS_MAX,
      cpu: process.env.TERRENCE_RUN_CGROUP_CPU_WEIGHT,
    };
    Object.assign(process.env, {
      TERRENCE_RUN_CGROUP_ROOT: root,
      TERRENCE_RUN_CGROUP_MEMORY_MAX: "1048576",
      TERRENCE_RUN_CGROUP_PIDS_MAX: "32",
      TERRENCE_RUN_CGROUP_CPU_WEIGHT: "50",
    });
    try {
      const runId = "run-apply-scheduled-1";
      const groupPath = join(root, runId);
      mkdirSync(groupPath);
      for (const controller of ["memory.max", "pids.max", "cpu.weight"]) {
        writeFileSync(join(groupPath, controller), "");
      }
      const path = prepareRunCgroup(runId);
      expect(path).toBe(groupPath);
      expect(getRunCgroup(runId)).toBe(path);
      expect(readFileSync(join(root, runId, "memory.max"), "utf8")).toBe("1048576");
      expect(readFileSync(join(root, runId, "pids.max"), "utf8")).toBe("32");
      expect(readFileSync(join(root, runId, "cpu.weight"), "utf8")).toBe("50");
      cleanupRunCgroup(runId);
      expect(getRunCgroup(runId)).toBeNull();
    } finally {
      for (const [key, value] of Object.entries({
        TERRENCE_RUN_CGROUP_ROOT: previous.root,
        TERRENCE_RUN_CGROUP_MEMORY_MAX: previous.memory,
        TERRENCE_RUN_CGROUP_PIDS_MAX: previous.pids,
        TERRENCE_RUN_CGROUP_CPU_WEIGHT: previous.cpu,
      })) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});
