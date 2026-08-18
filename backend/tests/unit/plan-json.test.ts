import { expect, test } from "bun:test";

import { planJsonResourceCounts } from "../../src/lib/plan-json";

test("counts plan JSON imports orthogonally and replacements as add plus destroy", () => {
  expect(planJsonResourceCounts({
    resource_changes: [{
      mode: "managed",
      change: { actions: ["no-op"], importing: { id: "existing" } },
    }, {
      mode: "managed",
      change: { actions: ["update"], importing: { id: "existing-updated" } },
    }, {
      mode: "managed",
      change: { actions: ["delete", "create"] },
    }, {
      mode: "data",
      change: { actions: ["read"] },
    }],
  })).toEqual({
    additions: 1,
    changes: 1,
    destructions: 1,
    imports: 2,
  });
  expect(planJsonResourceCounts({ format_version: "1.2" })).toBeUndefined();
});
