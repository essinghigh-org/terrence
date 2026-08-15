import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDiskFullError, markStorageDegraded } from "./storage-health";

const planJsonDirectory = resolve(
  process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"),
  "plan-json",
);

/** Canonical directory holding per-run plan JSON artifacts (id.json). */
export { planJsonDirectory };

export type PlanJson = Readonly<Record<string, unknown>>;
export type PlanResourceCounts = Readonly<{
  additions: number;
  changes: number;
  destructions: number;
  imports: number;
}>;

function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

export function planJsonResourceCounts(planJson: PlanJson): PlanResourceCounts | undefined {
  if (!Array.isArray(planJson.resource_changes)) return undefined;
  const counts = { additions: 0, changes: 0, destructions: 0, imports: 0 };
  for (const rawResourceChange of planJson.resource_changes) {
    const resourceChange = asObject(rawResourceChange);
    if (resourceChange?.mode === "data") continue;
    const change = asObject(resourceChange?.change);
    const actions = Array.isArray(change?.actions) ? change.actions : [];
    if (change?.importing !== undefined && change.importing !== null) counts.imports += 1;
    if (actions.includes("create")) counts.additions += 1;
    if (actions.includes("update")) counts.changes += 1;
    if (actions.includes("delete")) counts.destructions += 1;
  }
  return counts;
}

function artifactPath(runId: string): string {
  return join(planJsonDirectory, `${runId}.json`);
}

export async function writePlanJsonArtifact(runId: string, planJson: PlanJson): Promise<void> {
  try {
    await mkdir(planJsonDirectory, { recursive: true, mode: 0o700 });
    const target = artifactPath(runId);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(planJson), { mode: 0o600 });
    await rename(temporary, target);
  } catch (error: unknown) {
    if (isDiskFullError(error)) markStorageDegraded("plan JSON artifact writes are failing (disk full)");
    throw error;
  }
}

export async function readPlanJsonArtifact(runId: string): Promise<PlanJson | undefined> {
  try {
    const parsed = JSON.parse(await readFile(artifactPath(runId), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Stored plan JSON must be an object.");
    }
    return parsed as PlanJson;
  } catch (error: unknown) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) return undefined;
    throw error;
  }
}

export async function deletePlanJsonArtifact(runId: string): Promise<boolean> {
  try {
    await rm(artifactPath(runId));
    return true;
  } catch (error: unknown) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) return false;
    throw error;
  }
}
