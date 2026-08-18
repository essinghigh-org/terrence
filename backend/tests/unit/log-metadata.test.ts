import { describe, expect, it, spyOn } from "bun:test";

// 12.5 — log metadata must be nested under `meta` so it can never collide
// with the reserved structured fields (timestamp/level/message).
describe("structured logger metadata nesting (12.5)", () => {
  it("nests caller metadata under a reserved `meta` key", async () => {
    const mod = await import("../../src/lib/log");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      mod.log.info("hello", { timestamp: "attacker", level: "debug", message: "boom" });
      const line = logSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(line);
      // Caller-supplied keys must not clobber the structured fields.
      expect(parsed.timestamp).not.toBe("attacker");
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("hello");
      // They surface instead under meta.
      expect(parsed.meta).toEqual({ timestamp: "attacker", level: "debug", message: "boom" });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("omits meta when not provided", async () => {
    const mod = await import("../../src/lib/log");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      mod.log.info("solo");
      const line = logSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.meta).toBeUndefined();
      expect(parsed.level).toBe("info");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("omits meta when it is an empty object", async () => {
    const mod = await import("../../src/lib/log");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      mod.log.info("no-op", {});
      const line = logSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.meta).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });
});