import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

import { formatDate, formatDateTime } from "../src/lib/utils";
import {
  getDisplayTimezone,
  resolveDisplayTimeZone,
  setDisplayTimezone,
} from "../src/lib/display-timezone";

const timestamp = "2026-08-07T12:00:00Z";

function runWithTimezone(tz: string, script: string): Record<string, string> {
  const result = spawnSync("bun", ["-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
}

afterEach((): void => {
  setDisplayTimezone("local");
  localStorage.clear();
});

describe("display timezone preference", () => {
  it("defaults to the browser-local timezone and 24h hour cycle", () => {
    expect(getDisplayTimezone()).toBe("local");
    expect(resolveDisplayTimeZone()).toBeUndefined();
    expect(formatDateTime(timestamp)).toBe(new Date(timestamp).toLocaleString(undefined, { hour12: false }));
  });

  it("uses UTC for shared date formatting when selected", () => {
    const result = runWithTimezone("America/Los_Angeles", `
      const { formatDateTime } = await import("./src/lib/utils.ts");
      const { setDisplayTimezone } = await import("./src/lib/display-timezone.ts");
      setDisplayTimezone("utc");
      const date = new Date(${JSON.stringify(timestamp)});
      console.log(JSON.stringify({
        actual: formatDateTime(${JSON.stringify(timestamp)}),
        expected: date.toLocaleString(undefined, { timeZone: "UTC", hour12: false }),
      }));
    `);
    expect(result.actual).toBe(result.expected);
  });

  it("keeps bare calendar dates on the same day when pinned to UTC in a zone ahead of UTC", () => {
    // Tokyo is +9h: local midnight of 2026-08-07 is 2026-08-06T15:00Z, which
    // would render the previous day in UTC. A bare date has no instant, so it
    // must stay a calendar date in the pinned zone.
    const result = runWithTimezone("Asia/Tokyo", `
      const { formatDate } = await import("./src/lib/utils.ts");
      const { setDisplayTimezone } = await import("./src/lib/display-timezone.ts");
      setDisplayTimezone("utc");
      console.log(JSON.stringify({ actual: formatDate("2026-08-07") }));
    `);
    expect(result.actual).toBe(new Date("2026-08-07T00:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC" }));
  });

  it("persists the selected timezone for the next session", () => {
    setDisplayTimezone("utc");
    expect(localStorage.getItem("terrence-display-timezone")).toBe("utc");
  });

  it("restores the stored timezone on a fresh module load", () => {
    // Shim storage BEFORE the dynamic import: the module reads its initial
    // value at import time (module-scope currentTimezone).
    const result = runWithTimezone("UTC", `
      globalThis.window = {
        localStorage: {
          getItem: (key) => (key === "terrence-display-timezone" ? "utc" : null),
          setItem: () => {},
        },
      };
      const { getDisplayTimezone, resolveDisplayTimeZone } = await import("./src/lib/display-timezone.ts");
      console.log(JSON.stringify({
        loaded: getDisplayTimezone(),
        resolved: resolveDisplayTimeZone(),
      }));
    `);
    expect(result.loaded).toBe("utc");
    expect(result.resolved).toBe("UTC");
  });
});