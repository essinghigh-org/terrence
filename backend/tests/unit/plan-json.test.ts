import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deletePlanJsonArtifact, planJsonDirectory, planJsonResourceCounts, writePlanJsonArtifactFromFile } from "../../src/lib/plan-json";

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
