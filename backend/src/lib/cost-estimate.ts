import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const costEstimateDirectory = resolve(
  process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"),
  "cost-estimates",
);

type JsonObject = Readonly<Record<string, unknown>>;

export type CostEstimateStatus = "queued" | "pending" | "finished" | "errored" | "canceled" | "skipped";

export type CostEstimateTimestamps = Readonly<{
  "queued-at": string | null;
  "pending-at": string | null;
  "finished-at": string | null;
}>;

export type CostEstimateAttributes = Readonly<{
  status: CostEstimateStatus;
  "status-timestamps": CostEstimateTimestamps;
  resources: JsonObject;
  "delta-monthly-cost": string;
  "prior-monthly-cost": string;
  "proposed-monthly-cost": string;
  "resources-count": number;
  "matched-resources-count": number;
  "unmatched-resources-count": number;
  "error-message": string | null;
}>;

function artifactPath(runId: string): string {
  return join(costEstimateDirectory, `${runId}.json`);
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function decimal(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return value;
  throw new Error(`Infracost output is missing a valid ${field}.`);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function projectResources(projects: readonly unknown[], section: string): JsonObject[] {
  return projects.flatMap((project: unknown): JsonObject[] => {
    const resources = asObject(asObject(project)?.[section])?.["resources"];
    return Array.isArray(resources)
      ? resources.map(asObject).filter((resource: JsonObject | undefined): resource is JsonObject => resource !== undefined)
      : [];
  });
}

export function emptyCostEstimate(
  status: CostEstimateStatus,
  timestamps: CostEstimateTimestamps,
  errorMessage: string | null = null,
): CostEstimateAttributes {
  return {
    status,
    "status-timestamps": timestamps,
    resources: {},
    "delta-monthly-cost": "0.0",
    "prior-monthly-cost": "0.0",
    "proposed-monthly-cost": "0.0",
    "resources-count": 0,
    "matched-resources-count": 0,
    "unmatched-resources-count": 0,
    "error-message": errorMessage,
  };
}

export function parseInfracostOutput(
  output: unknown,
  timestamps: CostEstimateTimestamps,
): CostEstimateAttributes {
  const root = asObject(output);
  if (root === undefined) throw new Error("Infracost returned invalid JSON output.");

  const proposed = decimal(root["totalMonthlyCost"], "totalMonthlyCost");
  const prior = root["pastTotalMonthlyCost"] === undefined
    ? "0.0"
    : decimal(root["pastTotalMonthlyCost"], "pastTotalMonthlyCost");
  const delta = root["diffTotalMonthlyCost"] === undefined
    ? String(Number(proposed) - Number(prior))
    : decimal(root["diffTotalMonthlyCost"], "diffTotalMonthlyCost");
  const projects = Array.isArray(root["projects"]) ? root["projects"] : [];
  const summary = asObject(root["summary"]);
  const currentResources = projectResources(projects, "breakdown");
  const pastResources = projectResources(projects, "pastBreakdown");
  const diffResources = projectResources(projects, "diff");
  const detected = count(summary?.["totalDetectedResources"])
    ?? Math.max(currentResources.length, pastResources.length, diffResources.length);
  const matched = count(summary?.["totalSupportedResources"])
    ?? currentResources.filter((resource: JsonObject): boolean =>
      resource["monthlyCost"] !== null && resource["monthlyCost"] !== undefined).length;
  const unmatched = count(summary?.["totalUnsupportedResources"]) ?? Math.max(detected - matched, 0);

  return {
    status: "finished",
    "status-timestamps": timestamps,
    resources: {
      currency: typeof root["currency"] === "string" ? root["currency"] : null,
      projects,
      summary: summary ?? {},
    },
    "delta-monthly-cost": delta,
    "prior-monthly-cost": prior,
    "proposed-monthly-cost": proposed,
    "resources-count": detected,
    "matched-resources-count": matched,
    "unmatched-resources-count": unmatched,
    "error-message": null,
  };
}

export async function writeCostEstimateArtifact(
  runId: string,
  estimate: CostEstimateAttributes,
): Promise<void> {
  await mkdir(costEstimateDirectory, { recursive: true, mode: 0o700 });
  const target = artifactPath(runId);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(estimate), { mode: 0o600 });
  await rename(temporary, target);
}

export async function readCostEstimateArtifact(runId: string): Promise<CostEstimateAttributes | undefined> {
  try {
    const parsed = JSON.parse(await readFile(artifactPath(runId), "utf8")) as unknown;
    const estimate = asObject(parsed);
    if (estimate === undefined) throw new Error("Stored cost estimate must be an object.");
    return estimate as CostEstimateAttributes;
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

export async function deleteCostEstimateArtifact(runId: string): Promise<boolean> {
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
