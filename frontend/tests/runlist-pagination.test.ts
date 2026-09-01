import { describe, test, expect } from "bun:test";

describe("RunList pagination #363", (): void => {
  test("RunList caps pagination", async (): Promise<void> => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(import.meta.dir, "../src/views/RunList.tsx"), "utf8");
    expect(source).toContain("MAX_RUN_LIST_PAGES");
    expect(source).toContain("fetchedPages < MAX_RUN_LIST_PAGES");
  });
});
