import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { formatDate, formatDateTime, formatDateTimeExact } from "../src/lib/utils";
import type { JsonObject } from "../src/lib/json";

const savedTZ = process.env.TZ;
const UTILS_PATH = new URL("../src/lib/utils.ts", import.meta.url).pathname;

afterEach(() => {
  if (savedTZ === undefined) delete process.env.TZ;
  else process.env.TZ = savedTZ;
});

/** Run a snippet in a child process with a specific TZ (Bun test workers
 * ignore process.env.TZ mutations). Returns the parsed JSON the snippet
 * prints as its final line. */
function runWithTZ(tz: string, script: string): JsonObject {
  const r = spawnSync("bun", ["-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}");
}

describe("formatDate", () => {
  it("matches the locale's own date rendering", () => {
    const d = new Date(2026, 7, 7, 12, 0, 0);
    expect(formatDate(d)).toBe(d.toLocaleDateString());
  });

  it("renders the fallback for invalid input", () => {
    expect(formatDate(new Date(NaN))).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("renders ISO timestamps and numbers exactly like new Date would", () => {
    const iso = "2026-08-07T12:00:00Z";
    expect(formatDate(iso)).toBe(new Date(iso).toLocaleDateString());
    const ts = 1760000000000;
    expect(formatDate(ts)).toBe(new Date(ts).toLocaleDateString());
  });

  it("renders a bare YYYY-MM-DD calendar string on the same day in a negative-offset zone", () => {
    const script = `
      const { formatDate } = await import(${JSON.stringify(UTILS_PATH)});
      const out = formatDate("2026-08-07");
      const local = new Date(2026, 7, 7).toLocaleDateString();
      const naive = new Date("2026-08-07").toLocaleDateString();
      console.log(JSON.stringify({ sameDay: out === local, drifted: naive === local, out, naive }));
    `;
    // Bare calendar date must keep its calendar day in LA (naive new Date()
    // drift would render 2026-08-06; fixed helper renders 2026-08-07):
    const parsed = runWithTZ("America/Los_Angeles", script);
    expect(parsed.sameDay).toBe(true);
    expect(parsed.drifted).toBe(false);
  });

  it("handles years 00-99 as literal years (no 1900s normalization)", () => {
    const script = `
      const { formatDate } = await import(${JSON.stringify(UTILS_PATH)});
      const out = formatDate("0026-08-07");
      const d = new Date(0);
      d.setFullYear(26, 7, 7);
      console.log(JSON.stringify({ matches: out === d.toLocaleDateString(), out }));
    `;
    expect(runWithTZ("UTC", script).matches).toBe(true);
  });
});

describe("formatDateTime", () => {
  it("renders time plus date like the locale's own string in the default 24h cycle", () => {
    const d = new Date(2026, 7, 7, 22, 14, 3);
    expect(formatDateTime(d)).toBe(d.toLocaleString(undefined, { hour12: false }));
  });

  it("falls back for invalid input", () => {
    expect(formatDateTime(null, "unknown")).toBe("unknown");
    expect(formatDateTime("garbage", "unknown")).toBe("unknown");
  });

  it("treats a bare calendar date as local midnight, not UTC-midnight drift", () => {
      const script = `
        const { formatDateTime } = await import(${JSON.stringify(UTILS_PATH)});
        const out = formatDateTime("2026-08-07");
        const local = new Date(2026, 7, 7, 0, 0, 0).toLocaleString(undefined, { hour12: false });
        const naive = new Date("2026-08-07").toLocaleString();
        console.log(JSON.stringify({ sameLocal: out === local, drifted: naive === local }));
      `;
      const parsed = runWithTZ("America/Los_Angeles", script);
      expect(parsed.sameLocal).toBe(true);
      expect(parsed.drifted).toBe(false);
    });
});

describe("formatDateTimeExact", () => {
  it("renders canonical locale-independent ISO-8601 UTC", () => {
    expect(formatDateTimeExact(new Date("2026-08-07T22:14:03.000Z"))).toBe("2026-08-07T22:14:03.000Z");
  });

  it("is stable across time zones", () => {
    const script = `
      const { formatDateTimeExact } = await import(${JSON.stringify(UTILS_PATH)});
      console.log(JSON.stringify({ out: formatDateTimeExact("2026-08-07T22:14:03.000Z") }));
    `;
    expect(runWithTZ("America/Los_Angeles", script).out).toBe("2026-08-07T22:14:03.000Z");
    expect(runWithTZ("Asia/Tokyo", script).out).toBe("2026-08-07T22:14:03.000Z");
  });

  it("never throws on bad input and returns Unknown", () => {
    expect(formatDateTimeExact(new Date(NaN))).toBe("Unknown");
    expect(formatDateTimeExact("bogus")).toBe("Unknown");
  });
});