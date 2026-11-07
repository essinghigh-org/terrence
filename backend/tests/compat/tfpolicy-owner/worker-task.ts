// Dedicated process so acceptance can kill a worker without killing its API.
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
const runId = process.argv[2] ?? "",
  root = resolve(process.argv[3] ?? "");
if (
  !/^run-[a-f0-9-]+$/.test(runId) ||
  (await stat(root)).mode % 0o1000 !== 0o700 ||
  process.env["DATABASE_URL"] !== `file:${join(root, "test.db")}` ||
  process.env["STORAGE_DIR"] !== join(root, "storage")
)
  throw new Error("An isolated local run is required");
const { executeApply } = await import("../../../src/worker");
await executeApply(runId);
process.exit(0);
