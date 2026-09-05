import { describe, expect, it } from "bun:test";
import { buildRunPhaseEnv, buildSanitizedEnv, normalizeRunVariables } from "../../src/worker";

// Issue #577: per-run variables respect category. Env-category keys land in
// the environment directly (never TF_VAR_-prefixed, never -var flags);
// sensitive terraform keys arrive as TF_VAR_ entries; non-sensitive
// terraform keys are left for the run tfvars file (absent from env).
describe("run variable normalization and env composition (#577)", () => {
  it("defaults missing category to terraform", () => {
    expect(normalizeRunVariables([{ key: "region", value: "us-east-1" }])).toEqual([
      { key: "region", value: "us-east-1", category: "terraform", sensitive: false },
    ]);
  });

  it("keeps env category and sensitivity flags", () => {
    expect(normalizeRunVariables([
      { key: "AWS_SECRET_ACCESS_KEY", value: "s", category: "env", sensitive: true },
      { key: "VERBOSE", value: "1", category: "env", sensitive: false },
    ])).toEqual([
      { key: "AWS_SECRET_ACCESS_KEY", value: "s", category: "env", sensitive: true },
      { key: "VERBOSE", value: "1", category: "env", sensitive: false },
    ]);
  });

  it("skips malformed entries", () => {
    expect(normalizeRunVariables([
      null,
      "nope",
      { key: "ok", value: "v", category: "env" },
      { key: 42, value: "v" },
      { key: "novalue" },
    ])).toEqual([{ key: "ok", value: "v", category: "env", sensitive: false }]);
    expect(normalizeRunVariables(undefined)).toEqual([]);
    expect(normalizeRunVariables("nope")).toEqual([]);
  });

  it("injects env run variables directly without TF_VAR_ prefix", () => {
    const env = buildSanitizedEnv(normalizeRunVariables([
      { key: "AWS_SECRET_ACCESS_KEY", value: "s", category: "env", sensitive: true },
      { key: "VERBOSE", value: "1", category: "env", sensitive: false },
    ]));
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBe("s");
    expect(env["VERBOSE"]).toBe("1");
    expect(env["TF_VAR_AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["TF_VAR_VERBOSE"]).toBeUndefined();
  });

  it("maps sensitive terraform run variables to TF_VAR_ entries", () => {
    const env = buildSanitizedEnv(normalizeRunVariables([
      { key: "db_password", value: "s", category: "terraform", sensitive: true },
    ]));
    expect(env["TF_VAR_db_password"]).toBe("s");
    expect(env["db_password"]).toBeUndefined();
  });

  it("leaves non-sensitive terraform run variables out of env (tfvars file)", () => {
    const env = buildSanitizedEnv(normalizeRunVariables([
      { key: "region", value: "us-east-1", category: "terraform", sensitive: false },
    ]));
    expect(env["region"]).toBeUndefined();
    expect(env["TF_VAR_region"]).toBeUndefined();
  });

  it("still blocks protected keys from run variables", () => {
    const env = buildSanitizedEnv(normalizeRunVariables([
      { key: "LD_PRELOAD", value: "evil", category: "env" },
      { key: "PATH", value: "evil", category: "env" },
    ]));
    expect(env["LD_PRELOAD"]).toBeUndefined();
    expect(env["PATH"]).not.toBe("evil");
  });
});

// Issues #607, #608: plan and apply build their environments from one
// recipe, so provider credentials injected at plan time are present at apply
// time with identical routing — env keys verbatim (never TF_VAR_-prefixed),
// sensitive terraform as TF_VAR_, non-sensitive terraform left for the
// tfvars files.
describe("run variable env parity across phases (#607, #608)", () => {
  const workspaceVars = [
    { key: "WS_REGION", value: "us-east-1", category: "env" },
    { key: "ws_secret", value: "s", category: "terraform", sensitive: true },
  ];
  const runVariables = [
    { key: "AWS_SECRET_ACCESS_KEY", value: "s", category: "env", sensitive: true },
    { key: "VERBOSE", value: "1", category: "env", sensitive: false },
    { key: "db_password", value: "s", category: "terraform", sensitive: true },
    { key: "region", value: "us-west-2", category: "terraform", sensitive: false },
    { key: "legacy", value: "v" },
  ];

  it("routes run variables identically for plan and apply", () => {
    const plan = buildRunPhaseEnv(workspaceVars, runVariables, { TF_CLI_CONFIG_FILE: "/plan" });
    const apply = buildRunPhaseEnv(workspaceVars, runVariables, { TF_CLI_CONFIG_FILE: "/apply" });
    expect(plan).toEqual({ ...apply, TF_CLI_CONFIG_FILE: "/plan" });
  });

  it("keeps env credentials verbatim and terraform secrets TF_VAR_-prefixed in both phases", () => {
    for (const phase of ["plan", "apply"]) {
      const env = buildRunPhaseEnv(workspaceVars, runVariables, { TF_CLI_CONFIG_FILE: `/${phase}` });
      expect(env["AWS_SECRET_ACCESS_KEY"]).toBe("s");
      expect(env["TF_VAR_AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
      expect(env["TF_VAR_db_password"]).toBe("s");
      expect(env["db_password"]).toBeUndefined();
      expect(env["region"]).toBeUndefined();
      expect(env["TF_VAR_region"]).toBeUndefined();
      expect(env["WS_REGION"]).toBe("us-east-1");
      expect(env["TF_VAR_ws_secret"]).toBe("s");
    }
  });
});
