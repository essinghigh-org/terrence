import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlanJsonForTests } from "../../src/worker";

let directory = "";
let previousHa: string | undefined;

beforeEach(async (): Promise<void> => {
  previousHa = process.env["TERRENCE_HA_ENABLED"];
  process.env["TERRENCE_HA_ENABLED"] = "true";
  directory = await mkdtemp(join(tmpdir(), "terrence-assessment-ha-"));
});

afterEach(async (): Promise<void> => {
  if (previousHa === undefined) delete process.env["TERRENCE_HA_ENABLED"];
  else process.env["TERRENCE_HA_ENABLED"] = previousHa;
  await rm(directory, { recursive: true, force: true });
});

test("assessment plan JSON capture can explicitly bypass run leases in HA mode", async () => {
  const binary = join(directory, "fake-terraform");
  const plan = join(directory, "tfplan");
  const outputDirectory = join(directory, "output");
  await writeFile(plan, "fake-plan");
  await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"format_version":"1.2","resource_changes":[]}\'\n', {
    mode: 0o755,
  });
  await chmod(binary, 0o755);

  const fencedCapture = await readPlanJsonForTests("assessment-result", directory, binary, 5_000, outputDirectory);
  expect(fencedCapture).toBeUndefined();

  const captured = await readPlanJsonForTests("assessment-result", directory, binary, 5_000, outputDirectory, false);
  expect(captured?.planJson).toEqual({ format_version: "1.2", resource_changes: [] });
});
