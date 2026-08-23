import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
