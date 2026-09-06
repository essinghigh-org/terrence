import { describe, expect, it } from "bun:test";
import { decryptSecret } from "../../src/lib/secrets";
import { buildRunProvenanceCapsule, canonicalJson } from "../../src/lib/run-provenance";

describe("run provenance capsule", () => {
  it("hashes a canonical public manifest and keeps execution values encrypted", async () => {
    const input = {
      runId: "run-provenance-fixture",
      createdAt: Date.UTC(2026, 0, 2),
      configurationVersionId: "cv-1",
      configurationSource: "github",
      configurationIngress: { branch: "main", commitSha: "a".repeat(40), commitUrl: "https://github.example/commit/a" },
      configurationDigest: "b".repeat(64),
      engine: "terraform",
      engineVersion: "1.9.0",
      workspaceId: "ws-1",
      workingDirectory: "infra",
      executionMode: "remote",
      agentPoolId: null,
      inputStateId: "state-1",
      inputStateDigest: "c".repeat(64),
      runVariables: [{ key: "token", value: "TOP-SECRET", category: "env", sensitive: true }],
      effectiveVariables: [{ source: "varset" as const, key: "region", category: "terraform", sensitive: false, variableSetId: "set-1" }],
      effectiveExecutionVariables: [],
    };
    const capsule = await buildRunProvenanceCapsule(input);
    expect(JSON.stringify(capsule.publicManifest)).not.toContain("TOP-SECRET");
    expect(capsule.executionMaterial).toStartWith("enc:v1:");
    const material = JSON.parse(await decryptSecret(capsule.executionMaterial)) as { variables: readonly { value: string }[] };
    expect(material.variables[0]?.value).toBe("TOP-SECRET");
    expect(capsule.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(capsule.publicManifest.variables).toEqual([
      { key: "token", category: "env", source: "run", variableSetId: null, sensitive: true },
      { key: "region", category: "terraform", source: "variable-set", variableSetId: "set-1", sensitive: false },
    ]);
  });
});
