import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../src/db";
import {
  organizations, policyChecks, policies, policySetParameters, policySets, policySetWorkspaces, runs, workspaces,
} from "../../src/db/schema";
import { probePolicyEngine, runPolicyChecks, splitSentinelParams } from "../../src/worker";
import { variableValueForWrite } from "../../src/lib/variable-crypto";
import { eq, inArray } from "drizzle-orm";

// Policy engine coverage (issue #596): OPA and Sentinel execute for real
// when their binaries resolve, and report unreachable (never a bare
// failure) when the engine is missing.
//
// Real-execution cases gate on engine resolvability so CI without the
// binaries skips them: OPA via OPA_BINARY_PATH or PATH, Sentinel via
// SENTINEL_BINARY_PATH or PATH. The missing-engine cases are deterministic
// and run everywhere by pointing the overrides at nonexistent paths. Each
// engine gets its own workspace so verdicts cannot leak across cases.

const opaAvailable = await probePolicyEngine("opa").then(
  (probed): boolean => !("missing" in probed),
);
const sentinelAvailable = await probePolicyEngine("sentinel").then(
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
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      return await fn();
    } finally {
      if (saved === undefined) delete process.env[name];
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
      { id: opaPassId, orgId, policySetId: opaSetId, name: "opa-pass", kind: "opa", enforcementLevel: "advisory", query: "data.terrence", source: OPA_PASS_REGO },
      { id: opaFailId, orgId, policySetId: opaSetId, name: "opa-fail", kind: "opa", enforcementLevel: "hard-mandatory", query: "data.terrence", source: OPA_FAIL_REGO },
      { id: senPassId, orgId, policySetId: sentinelSetId, name: "sen-pass", kind: "sentinel", enforcementLevel: "advisory", source: SENTINEL_PASS },
      { id: senParamId, orgId, policySetId: senParamSetId, name: "sen-param", kind: "sentinel", enforcementLevel: "advisory", source: SENTINEL_PARAM },
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
    await db.delete(policyChecks).where(inArray(policyChecks.runId, [opaRunId, senRunId])).catch((): void => {});
    await db.delete(policySetParameters).where(inArray(policySetParameters.policySetId, [senParamSetId])).catch((): void => {});
    await db.delete(policies).where(inArray(policies.id, [opaPassId, opaFailId, senPassId, senParamId])).catch((): void => {});
    await db.delete(policySetWorkspaces).where(inArray(policySetWorkspaces.workspaceId, [opaWsId, senWsId])).catch((): void => {});
    await db.delete(policySets).where(inArray(policySets.id, [opaSetId, sentinelSetId, senParamSetId])).catch((): void => {});
    await db.delete(runs).where(inArray(runs.id, [opaRunId, senRunId])).catch((): void => {});
    await db.delete(workspaces).where(inArray(workspaces.id, [opaWsId, senWsId])).catch((): void => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch((): void => {});
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
        expect("missing" in await probePolicyEngine("opa")).toBe(true);
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
      expect(result.proceed).toBe(true);
      const rows = await checksFor(senPassId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.status).toBe("unreachable");
      expect(JSON.stringify(rows[0]?.result ?? {})).toContain("Sentinel");
    });
  });

  it("executes OPA policies for real when the engine resolves", async () => {
    if (!opaAvailable) return;
    await db.delete(policyChecks).where(eq(policyChecks.runId, opaRunId));
    const result = await runPolicyChecks(opaRunId, opaWsId, orgId, undefined, undefined, {});
    expect(result.hardFailed).toBe(true);
    expect(result.proceed).toBe(false);
    const passed = await checksFor(opaPassId);
    expect(passed[0]?.status).toBe("passed");
    const failed = await checksFor(opaFailId);
    expect(failed[0]?.status).toBe("failed");
  });

  it("executes Sentinel policies for real when the engine resolves", async () => {
    if (!sentinelAvailable) return;
    await db.delete(policyChecks).where(eq(policyChecks.runId, senRunId));
    const result = await runPolicyChecks(senRunId, senWsId, orgId, undefined, undefined, {});
    expect(result.proceed).toBe(true);
    const passed = await checksFor(senPassId);
    expect(passed[0]?.status).toBe("passed");
  });

  it("delivers sensitive Sentinel params via config file for real", async () => {
    // End-to-end proof for the CWE-200 fix: the encrypted secret_word
    // parameter reaches the real engine through sentinel.json (the policy
    // passes only if the value arrives), while the unit test above proves
    // it never appears in argv.
    if (!sentinelAvailable) return;
    await db.delete(policyChecks).where(eq(policyChecks.runId, senRunId));
    const result = await runPolicyChecks(senRunId, senWsId, orgId, undefined, undefined, {});
    expect(result.proceed).toBe(true);
    const rows = await checksFor(senParamId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.status).toBe("passed");
  });
});
