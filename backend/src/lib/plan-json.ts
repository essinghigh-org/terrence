import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDiskFullError, markStorageDegraded } from "./storage-health";

const planJsonDirectory = resolve(
  process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"),
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
  if (!Array.isArray(planJson["resource_changes"])) return undefined;
  const counts = { additions: 0, changes: 0, destructions: 0, imports: 0 };
  for (const rawResourceChange of planJson["resource_changes"]) {
    const resourceChange = asObject(rawResourceChange);
    if (resourceChange?.["mode"] === "data") continue;
    const change = asObject(resourceChange?.["change"]);
    const actions = Array.isArray(change?.["actions"]) ? change["actions"] : [];
    if (change?.["importing"] !== undefined && change["importing"] !== null) counts.imports += 1;
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
  return mask === undefined || mask === false ? value : null;
}

/** Public plan projection version (SEC-01). Bump when the sanitized shape
 * changes; explanation cache keys derive from it so stale projections
 * cannot serve cached generations built from an older shape. */
export const PUBLIC_PLAN_VERSION = 1;

/** Public plan contract: raw variables, configuration and state are never copied. */
export function sanitizePlanJson(planJson: PlanJson): PlanJson {
  const strings = (object: PlanJson, keys: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(keys.filter((key) => typeof object[key] === "string").map((key) => [key, object[key]]));
  const sensitivity = (value: unknown): unknown => {
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(sensitivity);
    const object = asObject(value);
    return object === undefined ? true : Object.fromEntries(Object.entries(object).map(([key, mask]) => [key, sensitivity(mask)]));
  };
  const change = (raw: unknown): PlanJson => {
    const object = asObject(raw) ?? {};
    const beforeMask = sensitivity(object["before_sensitive"]);
    const afterMask = sensitivity(object["after_sensitive"]);
    return {
      actions: Array.isArray(object["actions"])
        ? object["actions"].map((action: unknown) => typeof action === "string" && ["no-op", "create", "read", "update", "delete", "forget"].includes(action) ? action : "unsupported") : ["unsupported"],
      ...(Array.isArray(object["replace_paths"]) ? { replace_paths: object["replace_paths"].filter((path: unknown) => Array.isArray(path) && path.every((part: unknown) => typeof part === "string" || (typeof part === "number" && Number.isSafeInteger(part)))) } : {}),
      ...(Object.hasOwn(object, "before") ? { before: redact(object["before"], beforeMask) } : {}),
      ...(Object.hasOwn(object, "after") ? { after: redact(object["after"], afterMask) } : {}),
      before_sensitive: beforeMask,
      after_sensitive: afterMask,
      ...(object["after_unknown"] === undefined ? {} : { after_unknown: sensitivity(object["after_unknown"]) }),
      ...(asObject(object["importing"]) === undefined ? {} : { importing: { unknown: true } }),
    };
  };
  const result: Record<string, unknown> = { public_plan_version: PUBLIC_PLAN_VERSION, ...strings(planJson, ["format_version", "terraform_version"]) };
  for (const key of ["resource_changes", "resource_drift"]) {
    const resources = planJson[key];
    if (!Array.isArray(resources)) continue;
    result[key] = resources.flatMap((raw) => {
      const resource = asObject(raw);
      if (resource === undefined) return [];
      return [{
        ...strings(resource, ["address", "previous_address", "module_address", "mode", "type", "name", "provider_name", "deposed", "action_reason"]),
        change: change(resource["change"]),
      }];
    });
  }
  if (Array.isArray(planJson["action_invocations"])) {
    result["action_invocations"] = planJson["action_invocations"].flatMap((raw) => {
      const action = asObject(raw);
      if (action === undefined) return [];
      const trigger = asObject(action["lifecycle_action_trigger"]);
      return [{
        ...strings(action, ["address", "type", "name", "provider_name"]),
        ...(trigger === undefined ? {} : { lifecycle_action_trigger: strings(trigger, ["triggering_resource_address", "action_trigger_event"]) }),
        ...(asObject(action["invoke_action_trigger"]) === undefined ? {} : { invoke_action_trigger: {} }),
      }];
    });
  }
  const outputs = asObject(planJson["output_changes"]);
  if (outputs !== undefined) result["output_changes"] = Object.fromEntries(Object.entries(outputs).map(([name, raw]) => [name, change(raw)]));
  return result;
}

async function streamFileToPrivatePath(sourcePath: string, destinationPath: string): Promise<void> {
  await writeFile(destinationPath, "", { flag: "wx", mode: 0o600 });
  const reader = Bun.file(sourcePath).stream().getReader();
  const writer = Bun.file(destinationPath).writer();
  let ended = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      await writer.write(next.value);
    }
    await writer.end();
    ended = true;
  } finally {
    reader.releaseLock();
    if (!ended) {
      try { await writer.end(); } catch { /* best-effort cleanup */ }
    }
  }
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
    if (temporary !== null) await rm(temporary, { force: true }).catch((): void => { /* best-effort cleanup */ });
    if (isDiskFullError(error)) markStorageDegraded("plan JSON artifact writes are failing (disk full)");
    throw error;
  }
}

export async function writePlanJsonArtifactFromFile(runId: string, sourcePath: string): Promise<void> {
  let temporary: string | null = null;
  try {
    await mkdir(planJsonDirectory, { recursive: true, mode: 0o700 });
    const target = artifactPath(runId);
    temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await streamFileToPrivatePath(sourcePath, temporary);
    await rename(temporary, target);
    temporary = null;
  } catch (error: unknown) {
    if (temporary !== null) await rm(temporary, { force: true }).catch((): void => { /* best-effort cleanup */ });
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
  const paths = [artifactPath(runId), ...["redacted.json", "sanitized.json", "provider-schemas.json", "description.txt"].map((suffix) => join(planJsonDirectory, `${runId}.${suffix}`))];
  const deleted = await Promise.all(paths.map(async (path): Promise<boolean> => {
    try {
      await rm(path);
      return true;
    } catch (error: unknown) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }));
  return deleted.some(Boolean);
}
