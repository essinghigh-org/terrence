import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deletePlanJsonArtifact, planJsonDirectory, planJsonResourceCounts, sanitizePlanJson, writePlanJsonArtifactFromFile } from "../../src/lib/plan-json";

for (const engine of ["terraform", "tofu"]) {
  test(`${engine} serialized engine plan redacts sensitive outputs and retains public output values`, async () => {
    const raw = JSON.parse(await readFile(join(import.meta.dir, "../fixtures/engine-plan", `${engine}.json`), "utf8"));
    const projected = sanitizePlanJson(raw);
    expect(projected["output_changes"]).toMatchObject({
      credential: { actions: ["create"], after: null, after_sensitive: true },
      public_label: { actions: ["create"], after: "visible-fixture-value", after_sensitive: false },
    });
    expect(JSON.stringify(projected)).not.toContain("engine-fixture-secret");
    for (const rawOnly of ["variables", "configuration", "prior_state", "planned_values"]) expect(projected).not.toHaveProperty(rawOnly);
  });
}

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

test("keeps file-backed plan artifacts private while copying", async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "terrence-plan-json-test-"));
  const runId = `plan-json-permissions-${crypto.randomUUID()}`;
  const sourcePath = join(sourceDirectory, "source.json");
  const targetPath = join(planJsonDirectory, `${runId}.json`);
  try {
    await writeFile(sourcePath, '{"secret":true}', { mode: 0o600 });
    await chmod(sourcePath, 0o644);
    await writePlanJsonArtifactFromFile(runId, sourcePath);
    expect(await readFile(targetPath, "utf8")).toBe('{"secret":true}');
    expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
  } finally {
    await deletePlanJsonArtifact(runId);
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});


test("public projection excludes secrets in every raw representation and fails closed without masks", () => {
  const secret = "REVIEW_SYNTHETIC_SECRET";
  const raw = {
    format_version: "1.2",
    variables: { password: { value: secret } },
    configuration: { root_module: { variables: { password: { sensitive: true, default: secret } } } },
    prior_state: { values: { root_module: { resources: [{ values: { password: secret } }] } } },
    planned_values: { outputs: { password: { value: secret } } },
    future_representation: secret,
    resource_changes: [{ address: "module.child.test.example", change: {
      actions: ["update"], before: { password: secret, visible: "old" }, after: { password: secret, visible: "new", nested: [secret, "public"] },
      before_sensitive: { password: true }, after_sensitive: { password: true, nested: [true, false] }, after_unknown: { pending: true },
      future_field: secret,
    } }, { address: "test.missing_mask", change: { actions: ["create"], after: { value: secret } } }],
    output_changes: { password: { actions: ["update"], before: secret, after: secret, before_sensitive: true, after_sensitive: true } },
  };
  const publicPlan = sanitizePlanJson(raw);
  expect(JSON.stringify(publicPlan)).not.toContain(secret);
  expect(JSON.stringify(raw)).toContain(secret);
  expect(publicPlan["resource_changes"]).toMatchObject([{ change: { after: { password: null, visible: "new", nested: [null, "public"] }, after_unknown: { pending: true } } }, { change: { after: null } }]);
  expect(sanitizePlanJson(publicPlan)).toEqual(publicPlan);
});


test("run artifact cleanup removes agent side artifacts even without a raw plan", async () => {
  const { mkdir } = await import("node:fs/promises");
  const runId = `side-cleanup-${crypto.randomUUID()}`;
  await mkdir(planJsonDirectory, { recursive: true });
  const paths = ["sanitized.json", "redacted.json", "provider-schemas.json", "description.txt"].map((suffix) => join(planJsonDirectory, `${runId}.${suffix}`));
  for (const path of paths) await writeFile(path, "{}");
  expect(await deletePlanJsonArtifact(runId)).toBe(true);
  for (const path of paths) expect(await Bun.file(path).exists()).toBe(false);
  expect(await deletePlanJsonArtifact(runId)).toBe(false);
});


test("public plan preserves move, replacement and action summaries without action secrets", () => {
  const projected = sanitizePlanJson({
    resource_changes: [{ address: "test.new", previous_address: "test.old", change: {
      actions: ["delete", "create"], replace_paths: [["tags", "Name"], ["items", 0]],
      before_sensitive: false, after_sensitive: false,
    } }],
    action_invocations: [{ address: "action.test.restart", config: { password: "hidden-canary" },
      lifecycle_action_trigger: { triggering_resource_address: "test.new", action_trigger_event: "after_create", extra: "hidden-canary" },
      invoke_action_trigger: { extra: "hidden-canary" },
    }],
  });
  expect(projected["resource_changes"]).toMatchObject([{ previous_address: "test.old", change: { replace_paths: [["tags", "Name"], ["items", 0]] } }]);
  expect(projected["action_invocations"]).toEqual([{ address: "action.test.restart", lifecycle_action_trigger: { triggering_resource_address: "test.new", action_trigger_event: "after_create" }, invoke_action_trigger: {} }]);
  expect(JSON.stringify(projected)).not.toContain("hidden-canary");
  expect(sanitizePlanJson(projected)).toEqual(projected);
});


test("public plan version preserves absent/null values and marks unsupported actions without copying extensions", () => {
  const projected = sanitizePlanJson({ resource_changes: [{ address: 'test.item["a.b"]', change: {
    actions: ["create", "secret-extension"], after: null, before_sensitive: false, after_sensitive: false,
  } }] });
  expect(projected["public_plan_version"]).toBe(1);
  expect(projected["resource_changes"]).toEqual([{ address: 'test.item["a.b"]', change: {
    actions: ["create", "unsupported"], after: null, before_sensitive: false, after_sensitive: false,
  } }]);
  expect(JSON.stringify(projected)).not.toContain("secret-extension");
  expect(sanitizePlanJson(projected)).toEqual(projected);
});
