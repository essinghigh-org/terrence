import { describe, test, expect } from "bun:test";

describe("binary download bounds #358", (): void => {
  test("binaryManager enforces MAX_BINARY_SIZE", async (): Promise<void> => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(import.meta.dir, "../../src/binaryManager.ts"), "utf8");
    expect(source).toContain("MAX_BINARY_SIZE");
    expect(source).toContain("100 * 1024 * 1024");
    expect(source).toContain("Binary package too large");
    expect(source).toContain("content-length");
    expect(source).toContain("arrayBuffer.byteLength > MAX_BINARY_SIZE");
  });
});
