import { describe, expect, it } from "bun:test";
import {
  comparePlanJson,
  compareStateVersions,
  dependencyImpact,
  driftFingerprint,
  importConfiguration,
  policyPlaygroundResult,
  stateInventoryObservations,
  upgradeRehearsalResult,
  validateImportMappings,
} from "../../src/lib/platform-comparison";

function state(serial: number, resources: readonly Record<string, unknown>[], outputs: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 4,
    serial,
    lineage: "platform-comparison-fixture",
    terraform_version: "1.9.0",
    outputs,
    resources,
  });
}

function resource(name: string, id: string, secret: string): Record<string, unknown> {
  return {
    mode: "managed",
    type: "example_resource",
    name,
    provider: "provider[\"registry.example/example\"]",
    instances: [{ attributes: { id, name, secret } }],
  };
}

function version(id: string, serial: number, payload: string): Parameters<typeof compareStateVersions>[0] {
  return { id, workspaceId: "ws-1", serial, statePayload: payload, stateSummary: null, uploadSha256: null, runId: `run-${serial}`, createdAt: Date.UTC(2026, 0, serial) };
}

describe("platform comparison projections", () => {
  it("reports state additions and masks sensitive resource changes", () => {
    const before = version("state-1", 1, state(1, [resource("web", "i-1", "before")], { endpoint: { value: "old", sensitive: false } }));
    const after = version("state-2", 2, state(2, [resource("web", "i-1", "after"), resource("worker", "i-2", "new")], { endpoint: { value: "new", sensitive: false } }));
    const comparison = compareStateVersions(before, after);
    expect(comparison.mode).toBe("detailed");
    expect(comparison.resources.added).toEqual([{ address: "example_resource.worker", mode: "managed", type: "example_resource", provider: "provider[\"registry.example/example\"]" }]);
    // The projection cannot claim a sensitive value changed after masking it.
    expect(comparison.resources.changed).toEqual([]);
    expect(JSON.stringify(comparison)).not.toContain("secret");
    expect(comparison.outputs.changed).toHaveLength(1);
    expect(comparison.provenance.liveCloudChangeProven).toBe(false);
  });

  it("falls back to a bounded limited comparison for opaque state", () => {
    const opaque = "{\"encryption_version\":\"v1\",\"encrypted_data\":\"opaque\"}";
    const comparison = compareStateVersions(version("state-1", 1, opaque), version("state-2", 2, opaque));
    expect(comparison.mode).toBe("limited");
    expect(comparison.resources.added).toEqual([]);
    expect(comparison.provenance.liveCloudChangeProven).toBe(false);
  });

  it("compares sanitized plans without exposing sensitive values", () => {
    const plan = (action: string, value: string) => ({
      format_version: "1.2",
      resource_changes: [{ address: "example_resource.web", change: { actions: [action], before: { token: value }, after: { token: value }, before_sensitive: { token: true }, after_sensitive: { token: true } } }],
    });
    const comparison = comparePlanJson(plan("update", "secret-a"), plan("delete", "secret-b"));
    expect(comparison["resources"]).toMatchObject({ changed: [{ "newly-destructive": true }] });
    expect(JSON.stringify(comparison)).not.toContain("secret-");
  });
});

describe("platform workflow safety helpers", () => {
  it("coalesces equivalent drift observations across assessment IDs", () => {
    const checks = [{ address: "example_resource.web", status: "drifted", kind: "attribute" }];
    expect(driftFingerprint({ workspaceId: "ws-1", assessmentId: "assessment-a", drifted: true, checks }))
      .toBe(driftFingerprint({ workspaceId: "ws-1", assessmentId: "assessment-b", drifted: true, checks }));
  });

  it("bounds dependency fanout and identifies a cycle", () => {
    const result = dependencyImpact({ rootWorkspaceId: "ws-1", maxFanout: 1, edges: [
      { from: "ws-1", to: "ws-2", source: "explicit" },
      { from: "ws-1", to: "ws-3", source: "observed-output" },
      { from: "ws-2", to: "ws-1", source: "inferred" },
    ] });
    expect(result.truncated).toBe(true);
    expect(result.cycles).toEqual([["ws-1", "ws-2", "ws-1"]]);
  });

  it("validates import mappings and emits reviewable import blocks", () => {
    const valid = validateImportMappings([{ address: "module.network.example_vpc.main", "provider-id": "vpc-123" }]);
    expect(valid.errors).toEqual([]);
    expect(importConfiguration(valid.mappings[0]!)).toContain('id = "vpc-123"');
    const invalid = validateImportMappings([{ address: "bad address", "provider-id": "vpc-123" }, { address: "example_vpc.main", "provider-id": "vpc-123" }]);
    expect(invalid.errors).toHaveLength(2);
  });

  it("keeps upgrade rehearsal and policy playground review-only", () => {
    expect(upgradeRehearsalResult({ engine: "terraform", version: "1.9.0", baselineFresh: true, candidateLockDigest: null }))
      .toMatchObject({ status: "ready-for-speculative-plan", "apply-authority": false });
    expect(policyPlaygroundResult({ kind: "opa", source: "package terrence\ndefault allow := true", plan: {} }))
      .toMatchObject({ status: "review-only", "apply-authority": false });
    expect(policyPlaygroundResult({ kind: "opa", source: "default allow := true", plan: {} })["status"]).toBe("invalid");
  });

  it("builds inventory observations only from retained Terraform state", () => {
    const observations = stateInventoryObservations(version("state-1", 1, state(1, [resource("web", "i-1", "secret")])))
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ identity: "provider[\"registry.example/example\"]|example_resource|i-1", identitySource: "provider-id", stateVersionId: "state-1" });
  });
});
