import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { buildStateSummary, readStateSummary } from "../../src/lib/state-summary";
import { encryptStatePayload } from "../../src/lib/validation";

describe("bounded committed state summary", () => {
  it("binds safe metadata to exact canonical bytes including whitespace and large numbers", async () => {
    const payload = '{ "version":4,"serial":1,"lineage":"test","terraform_version":"1.9.0","resources":[{"mode":"managed","instances":[{"attributes":{"secret":"never-public","number":9007199254740993}}]}],"outputs":{"secret":{"value":"never-public","sensitive":true}} }';
    const summary = buildStateSummary((await encryptStatePayload(payload))!);
    expect(summary.digest).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(summary).toMatchObject({ status: "ready", resourceCount: 1, managedCount: 1, outputCount: 1 });
    const encoded = JSON.stringify(summary);
    expect(encoded).not.toContain("never-public");
    expect(encoded.length).toBeLessThan(4096);
    expect(readStateSummary(encoded, summary.digest)).toEqual(summary);
    expect(readStateSummary(encoded, "different-digest")).toBeNull();
    expect(readStateSummary(encoded.replace('"version":1', '"version":2'), summary.digest)).toBeNull();
    expect(readStateSummary(null, summary.digest)).toBeNull();
  });

  it("bounds oversized metadata and identifies opaque and invalid representations", () => {
    const summary = buildStateSummary(JSON.stringify({ version: 4, lineage: "x".repeat(10000), terraform_version: "y".repeat(10000) }));
    expect(summary.lineage).toBeNull();
    expect(summary.terraformVersion).toBeNull();
    expect(JSON.stringify(summary).length).toBeLessThan(4096);
    expect(buildStateSummary('{"encryption_version":"v0","encrypted_data":"secret"}').status).toBe("opaque");
    expect(buildStateSummary("invalid").status).toBe("invalid");
  });
});
