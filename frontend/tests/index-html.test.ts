import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexHtml = readFileSync(join(import.meta.dir, "../index.html"), "utf8");
const manifest = readFileSync(join(import.meta.dir, "../public/manifest.webmanifest"), "utf8");

describe("index.html document metadata", (): void => {
  it("uses a modern interactive viewport", (): void => {
    expect(indexHtml).toContain('name="viewport"');
    expect(indexHtml).toContain("viewport-fit=cover");
    expect(indexHtml).toContain("interactive-widget=resizes-content");
  });

  it("declares application metadata (name, color-scheme, theme-color)", (): void => {
    expect(indexHtml).toContain('name="application-name"');
    expect(indexHtml).toContain('content="Terrence"');
    expect(indexHtml).toContain('name="color-scheme"');
    expect(indexHtml).toContain('name="theme-color"');
    expect(indexHtml).toContain('name="robots"');
  });

  it("links the web app manifest and install icons", (): void => {
    expect(indexHtml).toContain('rel="manifest"');
    expect(indexHtml).toContain('/manifest.webmanifest');
    expect(indexHtml).toContain('sizes="192x192"');
    expect(indexHtml).toContain('sizes="512x512"');
    expect(indexHtml).toContain('rel="apple-touch-icon"');
  });

  it("retains the SVG favicon", (): void => {
    expect(indexHtml).toContain('rel="icon"');
    expect(indexHtml).toContain("/favicon.svg");
  });

  it("does not add SEO / OpenGraph / Twitter boilerplate (authenticated app)", (): void => {
    expect(indexHtml).not.toMatch(/og:/i);
    expect(indexHtml).not.toMatch(/twitter:/i);
    expect(indexHtml).not.toMatch(/application\/ld\+json/i);
  });
});

describe("Web App Manifest", (): void => {
  it("is valid JSON with stand-alone display and the required icons", (): void => {
    const parsed = JSON.parse(manifest) as Record<string, unknown>;
    expect(parsed.display).toBe("standalone");
    const icons = parsed.icons as { sizes?: string; purpose?: string }[];
    expect(icons.some((icon): boolean => icon.sizes === "192x192")).toBeTrue();
    expect(icons.some((icon): boolean => icon.sizes === "512x512" && icon.purpose === "any")).toBeTrue();
    expect(icons.some((icon): boolean => icon.purpose === "maskable")).toBeTrue();
  });
});