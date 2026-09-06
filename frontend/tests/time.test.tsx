import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { RelativeTime } from "../src/components/ui/time";

afterEach((): void => {
  cleanup();
});

test("relative time keeps an exact accessible instant alongside the compact label", () => {
  const view = render(<RelativeTime value="2026-09-06T12:00:00.000Z" updateIntervalMs={0} />);
  const time = view.container.querySelector("time");
  expect(time).not.toBeNull();
  expect(time?.getAttribute("dateTime")).toBe("2026-09-06T12:00:00.000Z");
  expect(time?.getAttribute("title")).toContain("2026-09-06T12:00:00.000Z");
  expect(time?.getAttribute("aria-label")).toContain("exact time 2026-09-06T12:00:00.000Z");
});

test("invalid timestamps use the caller's fallback without exposing Invalid Date", () => {
  const view = render(<RelativeTime value="not-a-date" fallback="Unknown" updateIntervalMs={0} />);
  const time = view.container.querySelector("time");
  expect(time?.textContent).toBe("Unknown");
  expect(time?.getAttribute("title")).toBe("Unknown");
  expect(time?.getAttribute("dateTime")).toBeNull();
});
