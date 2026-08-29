import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import ownership from "../../src/data/compatibility_ownership.json" with { type: "json" };

type OwnershipManifest = Readonly<{
  version: number;
  classes: readonly string[];
  route_ownership: Readonly<Record<string, readonly string[]>>;
}>;

const manifest = ownership as OwnershipManifest;

describe("compatibility ownership manifest", () => {
  test("defines only intentional ownership classes", () => {
    expect(manifest.version).toBe(2);
    expect([...manifest.classes].sort()).toEqual(["cli", "core", "internal", "provider"]);
    expect(manifest.classes).not.toContain("tfe_api");
  });

  test("classifies every route module registered by app.ts", () => {
    const appSource = readFileSync(new URL("../../src/app.ts", import.meta.url), "utf8");
    const registered = new Set<string>();
    const marker = ' from "./routes/';
    for (const line of appSource.split("\n")) {
      const markerStart = line.indexOf(marker);
      if (markerStart < 0) continue;
      const nameStart = markerStart + marker.length;
      const nameEnd = line.indexOf('"', nameStart);
      if (nameEnd > nameStart) registered.add(line.slice(nameStart, nameEnd));
    }
    const owned = new Set(Object.keys(manifest.route_ownership));
    expect([...owned].sort()).toEqual([...registered].sort());
    const classes = new Set(manifest.classes);
    for (const owners of Object.values(manifest.route_ownership)) {
      expect(owners.length).toBeGreaterThan(0);
      for (const owner of owners) expect(classes.has(owner)).toBe(true);
    }
    expect(manifest.route_ownership["provider-sets"]).toEqual(["provider"]);
    expect(manifest.route_ownership["hyok"]).toEqual(["provider"]);
  });
});
