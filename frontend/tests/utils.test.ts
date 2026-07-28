import { expect, test } from "bun:test";
import { cn } from "../src/lib/utils";

test("cn returns a merged className string", () => {
  expect(cn("text-sm", "font-bold")).toBe("text-sm font-bold");
});

test("cn handles conditional classes with clsx", () => {
  const result = cn("base", false && "hidden", undefined, null, "extra");
  expect(result).toBe("base extra");
});

test("cn handles empty input", () => {
  expect(cn()).toBe("");
});

test("cn merges tailwind utility conflicts via twMerge", () => {
  // px-4 and px-2 conflict; twMerge keeps the last one (px-2)
  const result = cn("px-4", "px-2");
  expect(result).toBe("px-2");
});

test("cn handles objects and arrays from clsx", () => {
  const result = cn(["flex", "gap-2"], { "bg-red-500": true, "bg-blue-500": false });
  expect(result).toContain("flex");
  expect(result).toContain("gap-2");
  expect(result).toContain("bg-red-500");
  expect(result).not.toContain("bg-blue-500");
});
