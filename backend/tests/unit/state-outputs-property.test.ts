/**
 * state-outputs-property.test.ts — pins the state-version-output resource
 * derivation in src/lib/response.ts (kanban STATE-001/002).
 *
 * the reference format go-tfe resolves outputs via opaque resource IDs and a self link of the
 * form /api/v2/state-version-outputs/:id. Terrence derives those IDs
 * deterministically (never random) so a provider refresh of the same state
 * version always computes the identical resource IDs — this is what stops
 * perpetual ForceNew diffs on `terraform apply` after a read.
 *
 * These tests assert the exact derivation the code performs:
 *   id = `wsout-${sha256(state.id + NUL + outputName).hex().slice(0,16)}`
 * plus structural fields (type, links.self, attributes shape) that go-tfe
 * depends on. Deterministic here is a correctness property, not an
 * implementation detail: a future edit that randomizes these IDs would
 * silently break idempotency for every consumer.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { stateOutputResources, type StateParam } from "../../src/lib/response";

/** Minimal state-version row carrying only what stateOutputResources reads. */
function stateRow(id: string, payload: string | null): StateParam {
  return { id, statePayload: payload } as unknown as StateParam;
}

function expectedId(stateId: string, name: string): string {
  return `wsout-${createHash("sha256").update(`${stateId}\0${name}`).digest("hex").slice(0, 16)}`;
}

function parsePayload(outputs: Record<string, unknown>): string {
  return JSON.stringify({ outputs });
}

describe("stateOutputResources (STATE-001/002)", () => {
  test("output IDs are deterministic: same state+name -> identical id", () => {
    const payload = parsePayload({ my_output: { value: "hello" } });
    const a = stateOutputResources(stateRow("sv-abc123", payload));
    const b = stateOutputResources(stateRow("sv-abc123", payload));
    expect(a).toEqual(b);
    expect(a[0].id).toBe(expectedId("sv-abc123", "my_output"));
  });

  test("IDs are unique per output name within a state version", () => {
    const payload = parsePayload({
      a: { value: 1 },
      b: { value: 2 },
      c: { value: 3 },
    });
    const resources = stateOutputResources(stateRow("sv-1", payload));
    const ids = resources.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(expectedId("sv-1", "a"));
    expect(ids).toContain(expectedId("sv-1", "b"));
    expect(ids).toContain(expectedId("sv-1", "c"));
  });

  test("IDs are scoped to the state version: same name, different state -> different id", () => {
    const payload = parsePayload({ shared: { value: "x" } });
    const one = stateOutputResources(stateRow("sv-one", payload));
    const two = stateOutputResources(stateRow("sv-two", payload));
    expect(one[0].id).not.toBe(two[0].id);
    expect(one[0].id).toBe(expectedId("sv-one", "shared"));
    expect(two[0].id).toBe(expectedId("sv-two", "shared"));
  });

  test("each resource carries type, self link, and attributes shape go-tfe expects", () => {
    const payload = parsePayload({
      plain: { value: "v" },
      flagged: { value: "s", sensitive: true },
    });
    const resources = stateOutputResources(stateRow("sv-x", payload));
    const byName: Record<string, Record<string, unknown>> = Object.fromEntries(
      resources.map((r) => [(r.attributes as { name: string }).name, r as Record<string, unknown>]),
    );

    for (const [name, r] of Object.entries(byName)) {
      expect(r.id).toBe(expectedId("sv-x", name));
      expect(r.type).toBe("state-version-outputs");
      const links = (r.links ?? {}) as Record<string, unknown>;
      expect(links.self).toBe(`/api/v2/state-version-outputs/${r.id}`);
      const attr = (r.attributes ?? {}) as Record<string, unknown>;
      expect(Object.keys(attr).sort()).toEqual(
        ["detailed-type", "name", "sensitive", "type", "value"].sort(),
      );
    }
    expect(byName.plain.attributes.sensitive).toBe(false);
    expect(byName.flagged.attributes.sensitive).toBe(true);
    expect(byName.flagged.attributes.type).toBe("string");
    expect(byName.flagged.attributes["detailed-type"]).toBe("string");
  });

  test("empty / malformed state payloads yield no output resources", () => {
    expect(stateOutputResources(stateRow("sv-e", JSON.stringify({})))).toHaveLength(0);
    expect(stateOutputResources(stateRow("sv-nil", null))).toHaveLength(0);
    expect(stateOutputResources(stateRow("sv-array", JSON.stringify({ outputs: [1, 2] })))).toHaveLength(0);
  });
});
