import { describe, test, expect } from "bun:test";

describe("diagnostics memoize #366", (): void => {
  test("RunDetail extracts diagnostics once per log type", async (): Promise<void> => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(import.meta.dir, "../src/views/RunDetail.tsx"), "utf8");
    // Should have 2 extractDiagnostics calls (one per log type), not 4
    const matches = source.match(/extractDiagnostics\(/g) || [];
    expect(matches.length).toBe(2);
    expect(source).toContain("planDiagnostics");
    expect(source).toContain("applyDiagnostics");
  });
});
