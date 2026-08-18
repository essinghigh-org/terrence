import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// costEstimateDirectory is resolved lazily from STORAGE_DIR, so we can point
// it at a throwaway temp dir for the duration of this suite.
const previousStorageDir = process.env.STORAGE_DIR;
const storage = mkdtempSync(join(tmpdir(), "cost-artifact-"));

let cost: typeof import("../../src/lib/cost-estimate");
let costDir: string;

beforeAll(async (): Promise<void> => {
  process.env.STORAGE_DIR = storage;
  cost = await import("../../src/lib/cost-estimate");
  costDir = join(storage, "cost-estimates");
});

afterAll((): void => {
  rmSync(storage, { recursive: true, force: true });
  if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorageDir;
});

const estimateFixture = {
  status: "finished",
  "status-timestamps": {
    "queued-at": "2026-01-01T00:00:00Z",
    "pending-at": "2026-01-01T00:01:00Z",
    "finished-at": "2026-01-01T00:02:00Z",
  },
  resources: {},
  "delta-monthly-cost": "0.0",
  "prior-monthly-cost": "0.0",
  "proposed-monthly-cost": "0.0",
  "resources-count": 0,
  "matched-resources-count": 0,
  "unmatched-resources-count": 0,
  "error-message": null,
} as const;

describe("readCostEstimateArtifact", (): void => {
  it("parses a stored artifact back to the estimate", async (): Promise<void> => {
    await cost.writeCostEstimateArtifact("run-r1", estimateFixture);
    const parsed = await cost.readCostEstimateArtifact("run-r1");
    expect(parsed).toEqual(estimateFixture);
  });

  it("returns undefined when the artifact does not exist (ENOENT)", async (): Promise<void> => {
    expect(await cost.readCostEstimateArtifact("run-absent")).toBeUndefined();
  });

  it("throws when the artifact contains malformed JSON", async (): Promise<void> => {
    if (costDir === undefined) throw new Error("setup failed");
    writeFileSync(join(costDir, "run-bad.json"), "{ not valid json");
    await expect(cost.readCostEstimateArtifact("run-bad")).rejects.toThrow();
  });

  it("throws when the artifact contains a non-object value", async (): Promise<void> => {
    if (costDir === undefined) throw new Error("setup failed");
    writeFileSync(join(costDir, "run-arr.json"), JSON.stringify([1, 2]));
    await expect(cost.readCostEstimateArtifact("run-arr")).rejects.toThrow(
      "Stored cost estimate must be an object.",
    );
  });
});

describe("deleteCostEstimateArtifact", (): void => {
  it("deletes an existing artifact and reports success", async (): Promise<void> => {
    await cost.writeCostEstimateArtifact("run-del", estimateFixture);
    expect(await cost.deleteCostEstimateArtifact("run-del")).toBe(true);
    // File is really gone.
    if (costDir === undefined) throw new Error("setup failed");
    expect(readdirSync(costDir).filter((name): boolean => name.startsWith("run-del"))).toEqual([]);
  });

  it("reports false when the artifact does not exist (ENOENT)", async (): Promise<void> => {
    expect(await cost.deleteCostEstimateArtifact("run-del-absent")).toBe(false);
  });
});