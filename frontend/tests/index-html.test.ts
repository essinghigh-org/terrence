import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../src/lib/json";

const indexHtml = readFileSync(join(import.meta.dir, "../index.html"), "utf8");
const manifest = readFileSync(join(import.meta.dir, "../public/manifest.webmanifest"), "utf8");

describe("index.html document metadata", (): void => {
  it("uses a modern interactive viewport without edge-to-edge cover (no safe-area handling)", (): void => {
    expect(indexHtml).toContain('name="viewport"');
    expect(indexHtml).toContain("interactive-widget=resizes-content");
    // viewport-fit=cover requires explicit env(safe-area-inset-*) padding in
    // the app chrome, which Terrence doesn't implement — so it must be absent
    // to avoid content sitting under notches/rounded display corners.
    expect(indexHtml).not.toContain("viewport-fit=cover");
  });

  it("defaults static theme-colour to the original-light background", (): void => {
    expect(indexHtml).toContain('media="(prefers-color-scheme: light)"');
    expect(indexHtml).toContain('content="hsl(0 0% 100%)"');
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
// SAFETY: the fixture object is read as a record; each field is typed below.
    const parsed = JSON.parse(manifest) as JsonObject;
    expect(parsed["display"]).toBe("standalone");
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
    const icons = parsed["icons"] as { sizes?: string; purpose?: string }[];
    expect(icons.some((icon): boolean => icon.sizes === "192x192")).toBeTrue();
    expect(icons.some((icon): boolean => icon.sizes === "512x512" && icon.purpose === "any")).toBeTrue();
    expect(icons.some((icon): boolean => icon.purpose === "maskable")).toBeTrue();
  });
});