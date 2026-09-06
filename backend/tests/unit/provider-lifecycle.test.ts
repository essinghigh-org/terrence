import { describe, expect, test } from "bun:test";
import contract from "../../src/data/provider_lifecycle_contract.json" with { type: "json" };
import {
  assertLifecycleEvidence,
  lifecycleEvidenceGaps,
  normalizeProviderState,
  normalizedStateDigest,
  normalizedStatesEqual,
  type LifecycleContract,
  type LifecycleEvidence,
} from "../../src/lib/provider-lifecycle";

const lifecycleContract = contract as LifecycleContract;

describe("provider lifecycle contract", () => {
  test("normalizes generated IDs, timestamps, serials and secrets while preserving behavior", () => {
    const first = {
      serial: 4,
      values: {
        id: "ws-first",
        name: "workspace",
        "created-at": "2026-09-06T10:00:00.000Z",
        variable_id: "var-first",
        token: "secret-first",
        tags: [{ id: "tag-first", key: "environment", value: "test" }],
      },
    };
    const second = {
      serial: 7,
      values: {
        id: "ws-second",
        name: "workspace",
        "created-at": "2026-09-07T10:00:00.000Z",
        variable_id: "var-second",
        token: "secret-second",
        tags: [{ id: "tag-second", key: "environment", value: "test" }],
      },
    };
    expect(normalizedStatesEqual(first, second)).toBe(true);
    expect(normalizedStateDigest(first)).toBe(normalizedStateDigest(second));
    expect(normalizeProviderState(first)).toEqual({ values: { name: "workspace", tags: [{ key: "environment", value: "test" }], token: "[redacted]" } });
  });

  test("requires every named fixture and behavior before evidence can be published", () => {
    const evidence: LifecycleEvidence = { contract_version: lifecycleContract.version, fixtures: [] };
    const gaps = lifecycleEvidenceGaps(lifecycleContract, evidence);
    expect(gaps).toContain("workspace-lifecycle: missing fixture evidence");
    expect(() => assertLifecycleEvidence(lifecycleContract, evidence)).toThrow("Incomplete provider lifecycle evidence");
  });

  test("rejects a fixture that reports a passing status without its required behaviors", () => {
    const fixture = lifecycleContract.fixtures[0]!;
    const evidence: LifecycleEvidence = {
      contract_version: lifecycleContract.version,
      fixtures: [{
        id: fixture.id,
        status: "passed",
        resources: fixture.resources,
        behaviors: ["create"],
      }],
    };
    const gaps = lifecycleEvidenceGaps(lifecycleContract, evidence);
    expect(gaps.some((gap): boolean => gap.startsWith(`${fixture.id}: missing behavior`))).toBe(true);
  });

  test("requires normalized baseline and restored state for convergence claims", () => {
    const fixture = lifecycleContract.fixtures.find((item): boolean => item.id === "workspace-lifecycle")!;
    const evidence: LifecycleEvidence = {
      contract_version: lifecycleContract.version,
      fixtures: [{
        id: fixture.id,
        status: "passed",
        resources: fixture.resources,
        behaviors: [...fixture.required_behaviors],
      }],
    };
    expect(lifecycleEvidenceGaps(lifecycleContract, evidence)).toContain("workspace-lifecycle: normalized state did not converge");
  });

  test("does not accept a false normalized-state equality claim", () => {
    const fixture = lifecycleContract.fixtures.find((item): boolean => item.id === "workspace-lifecycle")!;
    const evidence: LifecycleEvidence = {
      contract_version: lifecycleContract.version,
      fixtures: [{
        id: fixture.id,
        status: "passed",
        resources: fixture.resources,
        behaviors: [...fixture.required_behaviors],
        normalized_state: { baseline_sha256: "a".repeat(64), restored_sha256: "b".repeat(64), equivalent: true },
      }],
    };
    expect(lifecycleEvidenceGaps(lifecycleContract, evidence)).toContain("workspace-lifecycle: normalized state did not converge");
  });
});
