import { describe, test, expect } from "bun:test";

describe("log truncation #367", (): void => {
  test("RunDetail truncates large logs", async (): Promise<void> => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(import.meta.dir, "../src/views/RunDetail.tsx"), "utf8");
    expect(source).toContain("MAX_LOG_DISPLAY_CHARS");
    expect(source).toContain("truncated, download full log");
    // Should have 4 truncated spots (2 plan, 2 apply)
    const count = (source.match(/MAX_LOG_DISPLAY_CHARS/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });
});
