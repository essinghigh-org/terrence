import { describe, expect, test } from "bun:test";
import {
  changedSchemaPaths,
  productionFiles,
  renderReview,
  reviewEntries,
  schemaHash,
} from "../../scripts/lib/provider-drift";

describe("provider drift review", () => {
  test("hashes are canonical without losing array order", () => {
    expect(schemaHash({ a: 1, b: 2 })).toBe(schemaHash({ b: 2, a: 1 }));
    expect(schemaHash([1, 2])).not.toBe(schemaHash([2, 1]));
  });

  test("flags changed existing covered resources and nested schema flags", () => {
    const old = { block: { attributes: { kind: { type: "string", optional: true } } } };
    const next = { block: { attributes: { kind: { type: "string", required: true } } } };
    const lines = reviewEntries(
      [{ name: "tfe_policy_set", status: "covered", schema_hash: schemaHash(old) }],
      { tfe_policy_set: next },
      { tfe_policy_set: old },
    );
    expect(lines[0]).toContain("Schema changed: `tfe_policy_set`");
    expect(lines[0]).toContain("behavioral review required");
    expect(lines).toContain('  - `$["block"]["attributes"]["kind"]["optional"]`');
    expect(lines).toContain('  - `$["block"]["attributes"]["kind"]["required"]`');
  });

  test("reports additions, removals and missing provenance distinctly", () => {
    expect(
      reviewEntries(
        [
          { name: "removed", status: "covered" },
          { name: "unknown", status: "planned" },
        ],
        { added: {}, unknown: {} },
      ),
    ).toEqual([
      "- Added: `added` — backend gap",
      "- Removed: `removed`",
      "- Baseline missing: `unknown` (inventory status: planned; behavioral review required)",
    ]);
  });

  test("flags behavior-only source/dependency changes despite unchanged schema", () => {
    const files = productionFiles([
      { filename: "internal/provider/resource_tfe_policy_set.go", status: "modified" },
      { filename: "internal/provider/resource_tfe_policy_set_test.go", status: "modified" },
      { filename: "go.mod", status: "modified" },
    ]);
    const report = renderReview({
      current: "0.82.0",
      target: "0.83.0",
      resources: reviewEntries([], {}),
      dataSources: reviewEntries([], {}),
      files,
      truncated: false,
    });
    expect(report).toContain("No schema changes. This does not establish behavioral compatibility.");
    expect(report).toContain("resource_tfe_policy_set.go");
    expect(report).toContain("go.mod");
    expect(report).not.toContain("resource_tfe_policy_set_test.go");
    expect(report).toContain("compare/v0.82.0...v0.83.0");
    expect(report).toContain("- [ ] Read release notes and source changes");
  });

  test("does not hide truncated comparison or unknown baseline", () => {
    const report = renderReview({
      current: null,
      target: "0.83.0",
      resources: [],
      dataSources: [],
      files: [],
      truncated: true,
    });
    expect(report).toContain("No baseline version");
    expect(report).toContain("300-file limit");
  });

  test("reports null versus absent, and escaped keys unambiguously", () => {
    expect(changedSchemaPaths({}, { "a.b": null })).toEqual(['$["a.b"]']);
  });
});
