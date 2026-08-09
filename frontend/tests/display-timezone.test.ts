import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

import { formatDateTime } from "../src/lib/utils";
import {
  getDisplayTimezone,
  resolveDisplayTimeZone,
  setDisplayTimezone,
} from "../src/lib/display-timezone";

const timestamp = "2026-08-07T12:00:00Z";

function runWithTimezone(tz: string): Record<string, string> {
  const script = `
    const { formatDateTime } = await import("./src/lib/utils.ts");
    const { setDisplayTimezone } = await import("./src/lib/display-timezone.ts");
    setDisplayTimezone("utc");
    const date = new Date(${JSON.stringify(timestamp)});
    console.log(JSON.stringify({
      actual: formatDateTime(${JSON.stringify(timestamp)}),
      expected: date.toLocaleString(undefined, { timeZone: "UTC" }),
    }));
  `;
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
  it("defaults to the browser-local timezone", () => {
    expect(getDisplayTimezone()).toBe("local");
    expect(resolveDisplayTimeZone()).toBeUndefined();
    expect(formatDateTime(timestamp)).toBe(new Date(timestamp).toLocaleString());
  });

  it("uses UTC for shared date formatting when selected", () => {
    const result = runWithTimezone("America/Los_Angeles");
    expect(result.actual).toBe(result.expected);
  });

  it("persists the selected timezone for the next session", () => {
    setDisplayTimezone("utc");
    expect(localStorage.getItem("terrence-display-timezone")).toBe("utc");
  });
});
