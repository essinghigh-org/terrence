import { describe, expect, it, beforeEach } from "bun:test";
import { applyTheme } from "../src/lib/theme";

beforeEach((): void => {
  document.head.innerHTML = "";
  window.localStorage.clear();
});

describe("theme-color meta synchronisation", (): void => {
  it("updates the meta theme-color to the applied theme's background", (): void => {
    document.head.innerHTML = '<meta name="theme-color" content="hsl(220 23% 95%)" />';
    applyTheme("original-dark");
    const meta = document.querySelector('meta[name="theme-color"]');
    expect(meta?.getAttribute("content")).toBe("hsl(222 15% 11%)");
  });

  it("reflects an original-light theme background", (): void => {
    document.head.innerHTML = '<meta name="theme-color" />';
    applyTheme("original-light");
    const meta = document.querySelector('meta[name="theme-color"]');
    expect(meta?.getAttribute("content")).toBe("hsl(0 0% 100%)");
  });

  it("sets the document color-scheme to the theme mode", (): void => {
    applyTheme("original-dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("is a no-op when the theme-color meta is absent", (): void => {
    // Should not throw.
    expect(() => applyTheme("original-light")).not.toThrow();
  });

  it("updates every theme-color meta (not just the first)", (): void => {
    document.head.innerHTML = [
      '<meta name="theme-color" media="(prefers-color-scheme: light)" content="hsl(0 0% 100%)" />',
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="hsl(222 15% 11%)" />',
      '<meta name="theme-color" content="hsl(0 0% 100%)" />',
    ].join("");
    applyTheme("original-dark");
    const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
    expect(metas).toHaveLength(3);
    for (const meta of metas) expect(meta.getAttribute("content")).toBe("hsl(222 15% 11%)");
  });
});