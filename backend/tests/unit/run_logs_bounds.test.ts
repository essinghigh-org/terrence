import { describe, test, expect } from "bun:test";

describe("run log bounds #343", (): void => {
  test("run-logs module enforces MAX_RUN_LOGS_PER_RUN", async (): Promise<void> => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(import.meta.dir, "../../src/lib/run-logs.ts"), "utf8");
    expect(source).toContain("MAX_RUN_LOGS_PER_RUN");
    expect(source).toContain("limit: MAX_RUN_LOGS_PER_RUN");
    // archive path should also be bounded
    expect(source.match(/archiveRunLogs[\s\S]*?limit: MAX_RUN_LOGS_PER_RUN/)).toBeTruthy();
    expect(source.match(/readRunLogs[\s\S]*?limit: MAX_RUN_LOGS_PER_RUN/)).toBeTruthy();
  });
});
