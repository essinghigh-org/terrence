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

  it("serializes Error metadata without dropping diagnostic fields", async () => {
    const mod = await import("../../src/lib/log");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = new Error("boom") as Error & {
        cause?: unknown;
        code?: string;
        headers?: unknown;
        path?: string;
        query?: unknown;
        oversized?: string;
      };
      error.code = "E_TEST";
      error.cause = new Error("root cause");
      error.headers = { authorization: "Bearer secret-token" };
      error.path = "p".repeat(2_000);
      error.query = "secret query";
      error.oversized = "x".repeat(2_000);
      mod.log.error("failed", { error });
      const line = errorSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.meta.error).toMatchObject({
        name: "Error",
        message: "boom",
        details: { code: "E_TEST" },
      });
      expect(parsed.meta.error.details).toMatchObject({ code: "E_TEST" });
      expect(parsed.meta.error.details.path).toHaveLength(1_024);
      expect(JSON.stringify(parsed.meta.error)).not.toContain("secret-token");
      expect(JSON.stringify(parsed.meta.error)).not.toContain("secret query");
      expect(JSON.stringify(parsed.meta.error)).not.toContain("oversized");
      expect(parsed.meta.error.stack).toContain("Error: boom");
      expect(parsed.meta.error.cause).toMatchObject({ name: "Error", message: "root cause" });
    } finally {
      errorSpy.mockRestore();
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
