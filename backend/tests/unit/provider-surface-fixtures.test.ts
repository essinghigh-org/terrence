import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import sourceSurface from "../../src/data/provider_surface.json";
import fixtureSurface from "../e2e/provider_surface.json";

// This is an inventory check, not execution evidence. The separate lifecycle
// contract and CI journeys establish behavior; a declaration proves neither
// complete API semantics nor UI or policy-engine runtime support.
const fixtureSources = ["provider_e2e.test.ts", "provider-stack-policy-fixture.ts"].map((name) =>
  readFileSync(new URL(`../e2e/${name}`, import.meta.url), "utf8"),
);

function declaredTypes(block: "resource" | "data"): string[] {
  // Fixtures use literal HCL block headers inside template strings. Match only
  // those declarations, not incidental references to a provider type in prose.
  const pattern = new RegExp("(?:^|\\n|`)\\s*" + block + ' "(tfe_[a-z0-9_]+)" "[a-z0-9_]+" \\{', "g");
  return [
    ...new Set(fixtureSources.flatMap((source) => [...source.matchAll(pattern)].flatMap((match) => match[1] ?? []))),
  ].sort();
}

test("provider surface copies and inventory counts stay synchronized", () => {
  expect(fixtureSurface).toEqual(sourceSurface);
  for (const [entries, total, covered] of [
    [sourceSurface.resources, sourceSurface.resource_count, sourceSurface.resources_covered],
    [sourceSurface.data_sources, sourceSurface.data_source_count, sourceSurface.data_sources_covered],
  ] as const) {
    expect(entries).toHaveLength(total);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(total);
    expect(entries.filter((entry) => entry.status === "covered")).toHaveLength(covered);
  }
});

test("covered means literal inclusion in the provider fixtures, in both directions", () => {
  for (const [block, entries] of [
    ["resource", sourceSurface.resources],
    ["data", sourceSurface.data_sources],
  ] as const) {
    const covered = entries
      .filter((entry) => entry.status === "covered")
      .map((entry) => entry.name)
      .sort();
    // Adding a fixture must update a stale gap status; removing a fixture must
    // remove its covered claim. New upstream gaps without a fixture remain gaps.
    expect(covered).toEqual(declaredTypes(block));
  }
});
