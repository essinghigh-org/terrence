import { deleteOrganization } from "../../src/lib/lifecycle";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../src/db";
import {
  organizations,
  policyChecks,
  policies,
  policySetParameters,
  policySets,
  policySetWorkspaces,
  runs,
  workspaces,
} from "../../src/db/schema";
import { probePolicyEngine, redactSecrets, runPolicyChecks, splitSentinelParams } from "../../src/worker";
import { variableValueForWrite } from "../../src/lib/variable-crypto";
import { eq, inArray } from "drizzle-orm";

// Policy engine coverage (issue #596): OPA and Sentinel execute for real
// when their binaries resolve, and report unreachable (never a bare
// failure) when the engine is missing.
//
// Real-execution cases gate on engine resolvability so CI without the
// binaries skips them: OPA via OPA_BINARY_PATH or PATH, Sentinel via
// SENTINEL_BINARY_PATH or PATH. The availability probes below opt out of
// the managed OPA download ({ managed: false }) so test collection never
// performs a network install; the managed tier is covered by
// tests/unit/opa-bin.test.ts and runs on demand in production only. The
// missing-engine cases are deterministic and run everywhere by pointing the
// overrides at nonexistent paths. Each engine gets its own workspace so
// verdicts cannot leak across cases.

const opaAvailable = await probePolicyEngine("opa", { managed: false }).then(
  (probed): boolean => !("missing" in probed),
);
const sentinelAvailable = await probePolicyEngine("sentinel", { managed: false }).then(
  (probed): boolean => !("missing" in probed),
);

describe("policy engine execution and availability (#596)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const orgId = `org-poleng-${suffix}`;
  const opaWsId = `ws-poleng-opa-${suffix}`;
  const senWsId = `ws-poleng-sen-${suffix}`;
  const opaRunId = `run-poleng-opa-${suffix}`;
  const senRunId = `run-poleng-sen-${suffix}`;

  const opaSetId = `ps-poleng-opa-${suffix}`;
  const sentinelSetId = `ps-poleng-sen-${suffix}`;
  const opaPassId = `pol-poleng-opapass-${suffix}`;
  const opaFailId = `pol-poleng-opafail-${suffix}`;
  const senPassId = `pol-poleng-senpass-${suffix}`;
  const senParamSetId = `ps-poleng-senparam-${suffix}`;
  const senParamId = `pol-poleng-senparam-${suffix}`;

  const OPA_PASS_REGO = `package terrence

violations := []
`;
  const OPA_FAIL_REGO = `package terrence

violations := ["always denied"]
`;
  const SENTINEL_PASS = `main = rule { true }
`;
  const SENTINEL_PARAM = `param secret_word

main = rule { secret_word == "s3cret" }
`;

  const withEnv = async <T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const saved = process.env[name];
    try {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
      return await fn();
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = saved;
    }
  };

  const checksFor = async (policyId: string) =>
    db.query.policyChecks.findMany({ where: eq(policyChecks.policyId, policyId) });

  beforeAll(async () => {
    await db.insert(organizations).values({ id: orgId, name: `poleng-${suffix}` });
    await db.insert(workspaces).values([
      { id: opaWsId, name: `poleng-opa-ws-${suffix}`, orgId, executionMode: "remote" },
      { id: senWsId, name: `poleng-sen-ws-${suffix}`, orgId, executionMode: "remote" },
    ]);
    await db.insert(runs).values([
      { id: opaRunId, workspaceId: opaWsId, status: "planned", logToken: crypto.randomUUID(), createdAt: Date.now() },
      { id: senRunId, workspaceId: senWsId, status: "planned", logToken: crypto.randomUUID(), createdAt: Date.now() },
    ]);
    await db.insert(policySets).values([
      { id: opaSetId, orgId, name: `poleng-opa-${suffix}`, kind: "opa" },
      { id: sentinelSetId, orgId, name: `poleng-sen-${suffix}`, kind: "sentinel" },
      { id: senParamSetId, orgId, name: `poleng-senparam-${suffix}`, kind: "sentinel" },
    ]);
    await db.insert(policySetWorkspaces).values([
      { id: `psw-poleng-opa-${suffix}`, policySetId: opaSetId, workspaceId: opaWsId },
      { id: `psw-poleng-sen-${suffix}`, policySetId: sentinelSetId, workspaceId: senWsId },
      { id: `psw-poleng-senparam-${suffix}`, policySetId: senParamSetId, workspaceId: senWsId },
    ]);
    await db.insert(policies).values([
      {
        id: opaPassId,
        orgId,
        policySetId: opaSetId,
        name: "opa-pass",
        kind: "opa",
        enforcementLevel: "advisory",
        query: "data.terrence",
        source: OPA_PASS_REGO,
      },
      {
        id: opaFailId,
        orgId,
        policySetId: opaSetId,
        name: "opa-fail",
        kind: "opa",
        enforcementLevel: "hard-mandatory",
        query: "data.terrence",
        source: OPA_FAIL_REGO,
      },
      {
        id: senPassId,
        orgId,
        policySetId: sentinelSetId,
        name: "sen-pass",
        kind: "sentinel",
        enforcementLevel: "advisory",
        source: SENTINEL_PASS,
      },
      {
        id: senParamId,
        orgId,
        policySetId: senParamSetId,
        name: "sen-param",
        kind: "sentinel",
        enforcementLevel: "advisory",
        source: SENTINEL_PARAM,
      },
    ]);
    // Sensitive parameter stored encrypted at rest; the worker must deliver
    // it via the config file, never argv (CWE-200).
    const stored = await variableValueForWrite(true, "s3cret");
    await db.insert(policySetParameters).values({
      id: `psp-poleng-sen-${suffix}`,
      policySetId: senParamSetId,
      key: "secret_word",
      value: stored.value,
      valueEncrypted: stored.valueEncrypted,
      sensitive: true,
      hcl: false,
    });
  });

  afterAll(async () => {
    await db
      .delete(policyChecks)
      .where(inArray(policyChecks.runId, [opaRunId, senRunId]))
      .catch((): void => undefined);
    await db
      .delete(policySetParameters)
      .where(inArray(policySetParameters.policySetId, [senParamSetId]))
      .catch((): void => undefined);
    await db
      .delete(policies)
      .where(inArray(policies.id, [opaPassId, opaFailId, senPassId, senParamId]))
      .catch((): void => undefined);
    await db
      .delete(policySetWorkspaces)
      .where(inArray(policySetWorkspaces.workspaceId, [opaWsId, senWsId]))
      .catch((): void => undefined);
    await db
      .delete(policySets)
      .where(inArray(policySets.id, [opaSetId, sentinelSetId, senParamSetId]))
      .catch((): void => undefined);
    await db
      .delete(runs)
      .where(inArray(runs.id, [opaRunId, senRunId]))
      .catch((): void => undefined);
    await db
      .delete(workspaces)
      .where(inArray(workspaces.id, [opaWsId, senWsId]))
      .catch((): void => undefined);
    await db
      .delete(organizations)
      .where(eq(organizations.id, orgId))
      .catch((): void => undefined);
  });

  it("blocks a tfpolicy set even when it has no individual policy rows", async () => {
    const setId = `ps-tfpolicy-${suffix}`;
    const workspaceId = `ws-tfpolicy-${suffix}`;
    const runId = `run-tfpolicy-${suffix}`;
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId });
    await db
      .insert(runs)
      .values({ id: runId, workspaceId, status: "planned", logToken: crypto.randomUUID(), createdAt: Date.now() });
    await db.insert(policySets).values({ id: setId, name: setId, orgId, kind: "tfpolicy" });
    await db.insert(policySetWorkspaces).values({ id: `psw-tfpolicy-${suffix}`, policySetId: setId, workspaceId });
    try {
      expect(await runPolicyChecks(runId, workspaceId, orgId, undefined, undefined, {})).toEqual({
        proceed: false,
        hardFailed: true,
        softFailed: false,
      });
      const checks = await db.query.policyChecks.findMany({ where: eq(policyChecks.policySetId, setId) });
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: "unreachable", policySetId: setId, policyId: null });
      expect(checks[0]?.result?.["error"]).toContain("tfpolicy");
      expect(checks[0]?.result?.["error"]).toContain("not supported");
    } finally {
      await db.delete(runs).where(eq(runs.id, runId));
      await db.delete(policySets).where(eq(policySets.id, setId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    }
  });

  it("probe reports a missing engine with install guidance", async () => {
    await withEnv("OPA_BINARY_PATH", "/nonexistent/opa-xyz", async () => {
      const probed = await probePolicyEngine("opa");
      expect("missing" in probed).toBe(true);
      if ("missing" in probed) {
        expect(probed.missing).toContain("OPA");
        expect(probed.missing).toContain("OPA_BINARY_PATH");
      }
    });
    await withEnv("SENTINEL_BINARY_PATH", "/nonexistent/sentinel-xyz", async () => {
      const probed = await probePolicyEngine("sentinel");
      expect("missing" in probed).toBe(true);
      if ("missing" in probed) {
        expect(probed.missing).toContain("Sentinel");
        expect(probed.missing).toContain("SENTINEL_BINARY_PATH");
      }
    });
  });

  it("probe resolves an override pointing at an executable file", async () => {
    // The override must be an absolute executable: the engine spawns with
    // cwd set to the run workdir, so a relative path would resolve wrong,
    // and a non-executable match must report unavailable instead of
    // failing at spawn (CodeRabbit P1-sweep review).
    const dir = await mkdtemp(join(tmpdir(), "poleng-probe-"));
    try {
      const exePath = join(dir, "fake-opa");
      const inertPath = join(dir, "notes.txt");
      await writeFile(exePath, "#!/bin/sh\nexit 0\n");
      await writeFile(inertPath, "not an engine");
      await chmod(exePath, 0o755);
      await withEnv("OPA_BINARY_PATH", exePath, async () => {
        expect(await probePolicyEngine("opa")).toEqual({ path: exePath });
      });
      await withEnv("OPA_BINARY_PATH", inertPath, async () => {
        expect("missing" in (await probePolicyEngine("opa"))).toBe(true);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("splits Sentinel params so secrets never reach argv (CWE-200)", async () => {
    const { configParams, argvParams } = splitSentinelParams([
      { key: "db_password", hcl: false, sensitive: true, plaintext: "s3cret" },
      { key: "region", hcl: false, sensitive: false, plaintext: "us-east-1" },
      { key: "replicas", hcl: true, sensitive: true, plaintext: "3" },
    ]);
    expect(configParams).toEqual({
      db_password: { value: "s3cret" },
      replicas: { value: 3 },
    });
    expect(argvParams).toEqual(["-param", 'region="us-east-1"']);
    expect(argvParams.join(" ")).not.toContain("s3cret");
  });

  it("redacts sensitive plaintexts from persisted engine output (CWE-312)", async () => {
    // Synthetic echo: the pinned engine does not echo evaluated values, but
    // failure traces may in other versions, so the mechanism itself is proven
    // here with a fabricated output blob.
    const echoed = {
      result: false,
      trace: { rules: { main: { value: false, message: "expected s3cret" } }, print: ["s3cret"] },
      nested: [{ stderr: "s3cret leaked" }],
      duration: 3,
      ok: true,
    };
    const scrubbed = redactSecrets(echoed, ["s3cret"]) as Record<string, unknown>;
    expect(JSON.stringify(scrubbed)).not.toContain("s3cret");
    expect(JSON.stringify(scrubbed)).toContain("[redacted]");
    expect(scrubbed["duration"]).toBe(3);
    expect(scrubbed["ok"]).toBe(true);
    expect(redactSecrets("plain", [])).toBe("plain");
    expect(redactSecrets(42, ["s3cret"])).toBe(42);
  });

  it("reports unreachable (not failed) when the OPA engine is missing", async () => {
    await withEnv("OPA_BINARY_PATH", "/nonexistent/opa-xyz", async () => {
      await db.delete(policyChecks).where(eq(policyChecks.runId, opaRunId));
      const result = await runPolicyChecks(opaRunId, opaWsId, orgId, undefined, undefined, {});
      expect(result.proceed).toBe(false);
      expect(result.hardFailed).toBe(true);
      const failRows = await checksFor(opaFailId);
      expect(failRows.length).toBeGreaterThan(0);
      expect(failRows[0]?.status).toBe("unreachable");
      expect(JSON.stringify(failRows[0]?.result ?? {})).toContain("OPA");
    });
  });

  it("reports unreachable when the Sentinel engine is missing", async () => {
    await withEnv("SENTINEL_BINARY_PATH", "/nonexistent/sentinel-xyz", async () => {
      await db.delete(policyChecks).where(eq(policyChecks.runId, senRunId));
      const result = await runPolicyChecks(senRunId, senWsId, orgId, undefined, undefined, {});
      expect(result.proceed).toBe(false);
      expect(result.hardFailed).toBe(true);
      const rows = await checksFor(senPassId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.status).toBe("unreachable");
      expect(JSON.stringify(rows[0]?.result ?? {})).toContain("Sentinel");
    });
  });

  it.skipIf(!opaAvailable)("executes OPA policies for real when the engine resolves", async () => {
    await db.delete(policyChecks).where(eq(policyChecks.runId, opaRunId));
    const result = await runPolicyChecks(opaRunId, opaWsId, orgId, undefined, undefined, {});
    expect(result.hardFailed).toBe(true);
    expect(result.proceed).toBe(false);
    const passed = await checksFor(opaPassId);
    expect(passed[0]?.status).toBe("passed");
    const failed = await checksFor(opaFailId);
    expect(failed[0]?.status).toBe("failed");
  });

  it.skipIf(!sentinelAvailable)("executes Sentinel policies for real when the engine resolves", async () => {
    await db.delete(policyChecks).where(eq(policyChecks.runId, senRunId));
    const result = await runPolicyChecks(senRunId, senWsId, orgId, undefined, undefined, {});
    expect(result.proceed).toBe(true);
    const passed = await checksFor(senPassId);
    expect(passed[0]?.status).toBe("passed");
  });

  it.skipIf(!sentinelAvailable)("delivers sensitive Sentinel params via config file for real", async () => {
    // End-to-end proof for the CWE-200 fix: the encrypted secret_word
    // parameter reaches the real engine through sentinel.json (the policy
    // passes only if the value arrives), while the unit test above proves
    // it never appears in argv.
    await db.delete(policyChecks).where(eq(policyChecks.runId, senRunId));
    const result = await runPolicyChecks(senRunId, senWsId, orgId, undefined, undefined, {});
    expect(result.proceed).toBe(true);
    const rows = await checksFor(senParamId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.status).toBe("passed");
    // CWE-312: the persisted check result must not retain the secret even if
    // a future engine version echoes evaluated values in its trace.
    expect(JSON.stringify(rows[0]?.result ?? {})).not.toContain("s3cret");
  });
});

describe("policy decisions fail closed at the worker boundary", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-decision-${suffix}`;
  const workspaceId = `ws-decision-${suffix}`;
  const setId = `ps-decision-${suffix}`;
  const policyId = `pol-decision-${suffix}`;
  const runId = `run-decision-${suffix}`;
  let engineDirectory: string;

  beforeAll(async () => {
    engineDirectory = await mkdtemp(join(tmpdir(), "terrence-policy-decision-"));
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(workspaces).values({ id: workspaceId, orgId, name: workspaceId });
    await db.insert(runs).values({ id: runId, workspaceId, status: "planned", createdAt: Date.now() });
    await db.insert(policySets).values({ id: setId, orgId, name: setId, kind: "opa", global: true });
    await db.insert(policies).values({ id: policyId, orgId, policySetId: setId, name: policyId, kind: "opa" });
  });

  afterAll(async () => {
    await deleteOrganization(orgId);
    await rm(engineDirectory, { recursive: true, force: true });
  });

  const opaDecision = (value: unknown): string => JSON.stringify({ result: [{ expressions: [{ value }] }] });
  const sentinelDecision = (result: boolean): string =>
    JSON.stringify({
      result,
      error: null,
      policies: [{ result, error: null, trace: { result, error: null } }],
    });
  const cases: {
    name: string;
    kind: string;
    output: string;
    status: string;
    proceed: boolean;
    enforcement?: string;
    exit?: number;
  }[] = [
    { name: "OPA empty deny array passes", kind: "opa", output: opaDecision([]), status: "passed", proceed: true },
    {
      name: "OPA nonempty deny array blocks mandatory",
      kind: "opa",
      output: opaDecision(["denied"]),
      status: "failed",
      proceed: false,
    },
    {
      name: "OPA advisory denial remains nonblocking",
      kind: "opa",
      output: opaDecision(["denied"]),
      enforcement: "advisory",
      status: "failed",
      proceed: true,
    },
    {
      name: "OPA legacy explicit violations envelope",
      kind: "opa",
      output: opaDecision({ violations: [] }),
      status: "passed",
      proceed: true,
    },
    ...[
      {},
      { result: [] },
      { result: null },
      { result: [{ expressions: [] }] },
      { result: [{ expressions: [{ value: [] }, { value: [] }] }] },
    ].map((output, index) => ({
      name: `OPA malformed envelope ${index}`,
      kind: "opa",
      output: JSON.stringify(output),
      enforcement: "advisory",
      status: "errored",
      proceed: false,
    })),
    ...[null, true, false, "pass", {}, { deny: [] }, { violations: "none" }].map((value, index) => ({
      name: `OPA invalid decision ${index}`,
      kind: "opa",
      output: opaDecision(value),
      enforcement: "advisory",
      status: "errored",
      proceed: false,
    })),
    {
      name: "OPA malformed JSON",
      kind: "opa",
      output: "not json",
      enforcement: "advisory",
      status: "errored",
      proceed: false,
    },
    {
      name: "OPA errors cannot accompany a pass",
      kind: "opa",
      output: JSON.stringify({ result: [{ expressions: [{ value: [] }] }], errors: [{ message: "engine error" }] }),
      enforcement: "advisory",
      status: "errored",
      proceed: false,
    },
    {
      name: "OPA engine nonzero exit",
      kind: "opa",
      output: opaDecision([]),
      exit: 1,
      enforcement: "advisory",
      status: "errored",
      proceed: false,
    },
    { name: "Sentinel valid pass", kind: "sentinel", output: sentinelDecision(true), status: "passed", proceed: true },
    {
      name: "Sentinel advisory denial remains nonblocking",
      kind: "sentinel",
      output: sentinelDecision(false),
      exit: 1,
      enforcement: "advisory",
      status: "failed",
      proceed: true,
    },
    {
      name: "Sentinel soft denial requires override",
      kind: "sentinel",
      output: sentinelDecision(false),
      exit: 1,
      enforcement: "soft-mandatory",
      status: "soft_failed",
      proceed: false,
    },
    {
      name: "Sentinel hard denial blocks",
      kind: "sentinel",
      output: sentinelDecision(false),
      exit: 1,
      status: "failed",
      proceed: false,
    },
    ...[2, 3, 9].map((exit) => ({
      name: `Sentinel exit ${exit} is not an overridable denial`,
      kind: "sentinel",
      output: sentinelDecision(false),
      exit,
      enforcement: "advisory",
      status: "errored",
      proceed: false,
    })),
    ...[
      "not json",
      "{}",
      "[]",
      '{"result":null}',
      sentinelDecision(false),
      '{"result":true,"policies":[]}',
      '{"result":true,"error":"runtime error"}',
      '{"result":true,"trace":{"error":"runtime error"}}',
      '{"result":true,"skipped":true}',
      '{"result":true,"policies":[{"result":true,"skipped":true}]}',
      '{"result":true,"policies":[{"result":true,"error":"runtime error"}]}',
      '{"result":true,"policies":[{"result":true,"trace":{"error":"runtime error"}}]}',
    ].map((output, index) => ({
      name: `Sentinel malformed or inconsistent result ${index}`,
      kind: "sentinel",
      output,
      enforcement: "advisory",
      status: "errored",
      proceed: false,
    })),
  ];

  for (const fixture of cases) {
    it(fixture.name, async () => {
      const variable = fixture.kind === "opa" ? "OPA_BINARY_PATH" : "SENTINEL_BINARY_PATH";
      const oldPath = process.env[variable];
      const executable = join(engineDirectory, fixture.kind);
      await writeFile(
        executable,
        `#!/bin/sh\ncat <<'POLICY_RESULT'\n${fixture.output}\nPOLICY_RESULT\nexit ${fixture.exit ?? 0}\n`,
        { mode: 0o700 },
      );
      process.env[variable] = executable;
      try {
        await db.update(policySets).set({ kind: fixture.kind }).where(eq(policySets.id, setId));
        await db
          .update(policies)
          .set({
            kind: fixture.kind,
            enforcementLevel: fixture.enforcement ?? (fixture.kind === "opa" ? "mandatory" : "hard-mandatory"),
            query: "data.deny",
            source: fixture.kind === "opa" ? "package test\ndeny := []" : "main = rule { true }",
          })
          .where(eq(policies.id, policyId));
        await db.delete(policyChecks).where(eq(policyChecks.runId, runId));
        const outcome = await runPolicyChecks(runId, workspaceId, orgId, undefined, undefined, {});
        const checks = await db.query.policyChecks.findMany({ where: eq(policyChecks.policySetId, setId) });
        expect(checks).toHaveLength(1);
        expect(checks[0]?.status).toBe(fixture.status);
        expect(outcome.proceed).toBe(fixture.proceed);
        if (fixture.status === "errored") expect(outcome.hardFailed).toBe(true);
      } finally {
        if (oldPath === undefined) Reflect.deleteProperty(process.env, variable);
        else process.env[variable] = oldPath;
      }
    });
  }
});
