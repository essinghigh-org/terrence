import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

import { formatDateTime } from "../src/lib/utils";
import {
  getDisplayTimeFormat,
  resolveDisplayTimeFormat,
  setDisplayTimeFormat,
} from "../src/lib/display-time-format";

const timestamp = "2026-08-07T12:00:00Z";

afterEach((): void => {
  setDisplayTimeFormat("24");
  localStorage.clear();
});

describe("display time format preference", () => {
  it("defaults to the 24-hour cycle", () => {
    expect(getDisplayTimeFormat()).toBe("24");
    expect(resolveDisplayTimeFormat()).toBe("24");
    expect(formatDateTime(timestamp)).toBe(new Date(timestamp).toLocaleString("en-US", { hour12: false }));
  });

  it("uses the 12-hour cycle with an AM/PM suffix when selected", () => {
    setDisplayTimeFormat("12");
    expect(resolveDisplayTimeFormat()).toBe("12");
    // formatDateTime renders with a fixed en-US locale, so the reference
    // must be locale-independent too when asserting the AM/PM suffix.
    expect(formatDateTime(timestamp)).toBe(new Date(timestamp).toLocaleString("en-US", { hour12: true }));
    expect(formatDateTime(timestamp)).toMatch(/AM|PM/);
  });

  it("persists the selected format for the next session", () => {
    setDisplayTimeFormat("12");
    expect(localStorage.getItem("terrence-display-time-format")).toBe("12");
    setDisplayTimeFormat("24");
    expect(localStorage.getItem("terrence-display-time-format")).toBe("24");
  });

  it("ignores unknown values", () => {
    // @ts-expect-error deliberately passing an invalid format
    setDisplayTimeFormat("7");
    expect(getDisplayTimeFormat()).toBe("24");
  });

  it("restores the stored format on a fresh module load", () => {
    // Shim storage BEFORE the dynamic import: the module reads its initial
    // value at import time (module-scope currentFormat).
    const result = spawnSync(
      "bun",
      ["-e", `
        globalThis.window = {
          localStorage: {
            getItem: (key) => (key === "terrence-display-time-format" ? "12" : null),
            setItem: () => {},
          },
        };
        const { getDisplayTimeFormat, resolveDisplayTimeFormat } = await import("./src/lib/display-time-format.ts");
        console.log(JSON.stringify({ loaded: getDisplayTimeFormat(), resolved: resolveDisplayTimeFormat() }));
      `],
      { cwd: process.cwd(), env: { ...process.env }, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(parsed.loaded).toBe("12");
    expect(parsed.resolved).toBe("12");
  });
});