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

function sideArtifactPath(runId: string, kind: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(kind)) throw new Error("Unsupported plan JSON artifact kind.");
  return join(planJsonDirectory, `${runId}.${kind}.json`);
}

function redact(value: unknown, mask: unknown): unknown {
  if (mask === true) return null;
  if (Array.isArray(value) && Array.isArray(mask)) return value.map((item, index) => redact(item, mask[index]));
  if (value !== null && typeof value === "object" && !Array.isArray(value) && mask !== null && typeof mask === "object" && !Array.isArray(mask)) {
    const object = value as Record<string, unknown>;
    const maskObject = mask as Record<string, unknown>;
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, redact(item, maskObject[key])]));
  }
  return value;
}

/** Apply Terraform's *_sensitive shape when an agent did not upload a side artifact. */
export function sanitizePlanJson(planJson: PlanJson): PlanJson {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const object = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, visit(item)]));
    for (const [key, mask] of Object.entries(object)) {
      if (!key.endsWith("_sensitive")) continue;
      const base = key.slice(0, -"_sensitive".length);
      if (base in object) object[base] = redact(object[base], mask);
    }
    if ("sensitive_values" in object && "values" in object) object.values = redact(object.values, object.sensitive_values);
    if (object.sensitive === true && "value" in object) object.value = null;
    return object;
  };
  return visit(planJson) as PlanJson;
}

export async function writePlanJsonArtifact(runId: string, planJson: PlanJson): Promise<void> {
  let temporary: string | null = null;
  try {
    await mkdir(planJsonDirectory, { recursive: true, mode: 0o700 });
    const target = artifactPath(runId);
    temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(planJson), { mode: 0o600 });
    await rename(temporary, target);
    temporary = null;
  } catch (error: unknown) {
    if (temporary !== null) await rm(temporary, { force: true }).catch((): void => {});
    if (isDiskFullError(error)) markStorageDegraded("plan JSON artifact writes are failing (disk full)");
    throw error;
  }
}

export async function readPlanJsonArtifact(runId: string): Promise<PlanJson | undefined> {
  return readPlanJsonFile(artifactPath(runId));
}

async function readPlanJsonFile(path: string): Promise<PlanJson | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
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

export async function readPlanJsonSideArtifact(runId: string, kind: string): Promise<PlanJson | undefined> {
  return readPlanJsonFile(sideArtifactPath(runId, kind));
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
