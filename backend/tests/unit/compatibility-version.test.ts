import { describe, expect, it } from "bun:test";
import { COMPATIBILITY_VERSION, TFP_API_VERSION } from "../../src/lib/constants";

describe("compatibility version headers (audit finding 13)", () => {
  it("TFP-API-Version stays dotted numeric at or above 2.6 for import negotiation", () => {
    const parts = TFP_API_VERSION.split(".");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) {
      expect(Number.isInteger(Number(part))).toBe(true);
    }
    const [major = Number.NaN, minor = Number.NaN] = parts.map(Number);
    expect(major > 2 || (major === 2 && minor >= 6)).toBe(true);
  });

  it("X-TFE-Version defaults to release style the CLI SRO gate can parse", () => {
    expect(COMPATIBILITY_VERSION.startsWith("v")).toBe(true);
    const stamp = COMPATIBILITY_VERSION.slice(1).split("-")[0] as string;
    expect(/^\d{6}$/.test(stamp)).toBe(true);
  });
});
