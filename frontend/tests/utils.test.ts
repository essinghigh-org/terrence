import { afterEach, expect, mock, test } from "bun:test";
import { cn, copyTextToClipboard } from "../src/lib/utils";

const originalClipboard = navigator.clipboard;

afterEach((): void => {
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
});

test("cn returns a merged className string", () => {
  expect(cn("text-sm", "font-bold")).toBe("text-sm font-bold");
});

test("cn handles conditional classes with clsx", () => {
  const result = cn("base", { hidden: false }, undefined, null, "extra");
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

test("copyTextToClipboard reports successful writes", async () => {
  const writeText = mock(async (text: string): Promise<void> => {
    expect(text).toBe("workspace-123");
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  expect(await copyTextToClipboard("workspace-123")).toBe(true);
  expect(writeText).toHaveBeenCalledTimes(1);
});

test("copyTextToClipboard fails closed when clipboard is unavailable", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

  expect(await copyTextToClipboard("workspace-123")).toBe(false);
});

test("copyTextToClipboard reports rejected writes as failures", async () => {
  const writeText = mock(async (): Promise<void> => {
    throw new Error("Clipboard blocked");
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  expect(await copyTextToClipboard("workspace-123")).toBe(false);
  expect(writeText).toHaveBeenCalledTimes(1);
});
