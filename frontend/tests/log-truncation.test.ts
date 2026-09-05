import { describe, test, expect } from "bun:test";
import { MAX_LOG_DISPLAY_CHARS, truncateLogForDisplay } from "../src/lib/log-display";

describe("log truncation #367, #590", (): void => {
  test("short logs pass through untouched", (): void => {
    expect(truncateLogForDisplay("hello")).toBe("hello");
    expect(truncateLogForDisplay("x".repeat(MAX_LOG_DISPLAY_CHARS))).toBe("x".repeat(MAX_LOG_DISPLAY_CHARS));
  });

  test("long logs keep the tail with a leading elision marker", (): void => {
    const head = "H".repeat(1000);
    const tail = "Error: something failed at the end";
    const log = `${head}${"m".repeat(MAX_LOG_DISPLAY_CHARS)}${tail}`;
    const shown = truncateLogForDisplay(log);
    expect(shown).toContain(tail);
    expect(shown).not.toContain(head);
    expect(shown.startsWith("… (truncated,")).toBe(true);
    expect(shown).toContain("download full log");
  });

  test("RunDetail routes all four log views through the tail-keeping helper", async (): Promise<void> => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(import.meta.dir, "../src/views/RunDetail.tsx"), "utf8");
    const uses = (source.match(/truncateLogForDisplay\(/g) || []).length;
    expect(uses).toBeGreaterThanOrEqual(4);
    expect(source).not.toContain("slice(0, MAX_LOG_DISPLAY_CHARS)");
  });
});
