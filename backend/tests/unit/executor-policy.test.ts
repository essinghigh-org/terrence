import { describe, expect, it } from "bun:test";
import { EXECUTOR_BACKENDS, executorBackendFromEnv, executorPolicyAllows, executorPolicyAllowsLocal, hasHardIsolation } from "../../src/worker/executor-policy";

describe("executor policy (35-39)", () => {
  it("defaults to landlock when env is unset or unknown", () => {
    const orig = process.env.TERRENCE_EXECUTOR_BACKEND;
    try {
      delete process.env.TERRENCE_EXECUTOR_BACKEND;
      expect(executorBackendFromEnv()).toBe("landlock");
      process.env.TERRENCE_EXECUTOR_BACKEND = "nonsense";
      expect(executorBackendFromEnv()).toBe("landlock");
      process.env.TERRENCE_EXECUTOR_BACKEND = "container";
      expect(executorBackendFromEnv()).toBe("container");
    } finally {
      if (orig === undefined) delete process.env.TERRENCE_EXECUTOR_BACKEND;
      else process.env.TERRENCE_EXECUTOR_BACKEND = orig;
    }
  });

  it("executorPolicyAllowsLocal checks landlock membership", () => {
    expect(executorPolicyAllowsLocal(["landlock", "container"])).toBe(true);
    expect(executorPolicyAllowsLocal(["container"])).toBe(false);
  });

  it("executorPolicyAllows enforces workspace untrusted", () => {
    expect(executorPolicyAllows("landlock", { trustedExecution: false }, null, null).allowed).toBe(false);
    expect(executorPolicyAllows("container", { trustedExecution: false }, null, null).allowed).toBe(true);
  });

  it("executorPolicyAllows enforces project allowedExecutionModes", () => {
    expect(executorPolicyAllows("landlock", null, { allowedExecutionModes: "agent" }, null).allowed).toBe(false);
    expect(executorPolicyAllows("agent", null, { allowedExecutionModes: "agent" }, null).allowed).toBe(true);
    expect(executorPolicyAllows("landlock", null, { allowedExecutionModes: "remote" }, null).allowed).toBe(true);
  });

  it("executorPolicyAllows enforces org hard isolation", () => {
    expect(executorPolicyAllows("landlock", null, null, { requireHardIsolation: true }).allowed).toBe(false);
    expect(executorPolicyAllows("container", null, null, { requireHardIsolation: true }).allowed).toBe(true);
  });

  it("hasHardIsolation reflects non-landlock backends", () => {
    expect(hasHardIsolation(["landlock"])).toBe(false);
    expect(hasHardIsolation(["container", "landlock"])).toBe(true);
    expect(hasHardIsolation(["microvm"])).toBe(true);
  });

  it("EXECUTOR_BACKENDS exhausts the known set", () => {
    expect(EXECUTOR_BACKENDS).toEqual(["landlock", "container", "kubernetes", "agent", "microvm"]);
  });
});
