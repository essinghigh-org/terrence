import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type JsonObject = Readonly<Record<string, unknown>>;

export type CostEstimateStatus = "queued" | "pending" | "finished" | "errored" | "canceled" | "skipped_due_to_targeting" | "unavailable";

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
  /** Estimator identity and pricing assumptions retained with the run. */
  provenance?: CostEstimateProvenance;
  /** Explicit baseline comparability, warnings, and resource-level deltas. */
  comparison?: CostEstimateComparison;
}>;

export type CostEstimateProvenance = Readonly<{
  tool: "infracost";
  version: string | null;
  "pricing-date": string | null;
  currency: string | null;
  "time-basis": string | null;
  "supported-resources": number;
  assumptions: readonly string[];
}>;

export type CostEstimateResourceChange = Readonly<{
  address: string;
  module: string | null;
  action: "added" | "removed" | "changed" | "unsupported" | "unchanged";
  "prior-monthly-cost": string | null;
  "proposed-monthly-cost": string | null;
  "delta-monthly-cost": string | null;
}>;

export type CostEstimateComparison = Readonly<{
  baseline: Readonly<{
    source: "infracost-past-breakdown" | "none";
    "monthly-cost": string | null;
    currency: string | null;
    comparable: boolean;
    reason: string | null;
  }>;
  warnings: readonly string[];
  "resource-changes": readonly CostEstimateResourceChange[];
}>;

// Resolved lazily (not at module load) so tests can point STORAGE_DIR at a
// throwaway dir regardless of import order/caching.
function costEstimateDirectory(): string {
  return resolve(
    process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"),
    "cost-estimates",
  );
}

function artifactPath(runId: string): string {
  return join(costEstimateDirectory(), `${runId}.json`);
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

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, maxLength)
    : null;
}

function optionalCost(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return value.trim();
  return null;
}

type ResourceCost = Readonly<{
  address: string;
  module: string | null;
  monthlyCost: string | null;
  action: string | null;
}>;

function resourceAddress(resource: JsonObject): string | null {
  return boundedString(resource["name"] ?? resource["address"] ?? resource["resourceName"], 512);
}

function resourceCosts(projects: readonly unknown[], section: string): Map<string, ResourceCost> {
  const result = new Map<string, ResourceCost>();
  for (const project of projects) {
    const projectObject = asObject(project);
    const projectName = boundedString(projectObject?.["name"], 256);
    const resources = asObject(projectObject?.[section])?.["resources"];
    if (!Array.isArray(resources)) continue;
    for (const rawResource of resources) {
      const resource = asObject(rawResource);
      if (resource === undefined) continue;
      const address = resourceAddress(resource);
      if (address === null) continue;
      const key = `${projectName ?? "default"}:${address}`;
      result.set(key, {
        address,
        module: projectName,
        monthlyCost: optionalCost(resource["monthlyCost"]),
        action: boundedString(resource["action"], 64),
      });
    }
  }
  return result;
}

function resourceDelta(current: string | null, previous: string | null): string | null {
  if (current === null || previous === null) return null;
  const value = Number(current) - Number(previous);
  return Number.isFinite(value) ? String(value) : null;
}

function resourceChanges(
  current: Readonly<ReadonlyMap<string, ResourceCost>>,
  previous: Readonly<ReadonlyMap<string, ResourceCost>>,
  diff: Readonly<ReadonlyMap<string, ResourceCost>>,
): readonly CostEstimateResourceChange[] {
  const keys = new Set([...current.keys(), ...previous.keys(), ...diff.keys()]);
  return [...keys]
    .map((key): CostEstimateResourceChange | null => {
      const now = current.get(key);
      const before = previous.get(key);
      const change = diff.get(key);
      const proposed = now?.monthlyCost ?? null;
      const prior = before?.monthlyCost ?? null;
      const delta = resourceDelta(proposed, prior);
      const action: CostEstimateResourceChange["action"] = proposed === null && now !== undefined
        ? "unsupported"
        : now === undefined && before !== undefined
          ? "removed"
          : before === undefined && now !== undefined
            ? "added"
            : delta !== null && Number(delta) !== 0
              ? "changed"
              : change?.action === "modify" ? "changed" : "unchanged";
      const resource = now ?? before ?? change;
      if (resource === undefined) return null;
      return {
        address: resource.address,
        module: resource.module,
        action,
        "prior-monthly-cost": prior,
        "proposed-monthly-cost": proposed,
        "delta-monthly-cost": delta,
      };
    })
    .filter((value): value is CostEstimateResourceChange => value !== null)
    .sort((left, right): number => Math.abs(Number(right["delta-monthly-cost"] ?? 0)) - Math.abs(Number(left["delta-monthly-cost"] ?? 0)))
    .slice(0, 2_000);
}

function assumptions(root: JsonObject): readonly string[] {
  const values = root["assumptions"];
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value): string => value.trim().slice(0, 256))
    .slice(0, 64);
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
    provenance: {
      tool: "infracost",
      version: null,
      "pricing-date": null,
      currency: null,
      "time-basis": "monthly",
      "supported-resources": 0,
      assumptions: [],
    },
    comparison: {
      baseline: {
        source: "none",
        "monthly-cost": null,
        currency: null,
        comparable: false,
        reason: "No comparable baseline was provided.",
      },
      warnings: [],
      "resource-changes": [],
    },
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
  const currency = boundedString(root["currency"], 16);
  const pastCurrency = boundedString(root["pastCurrency"] ?? root["currency"], 16);
  const timeBasis = boundedString(root["timeBasis"] ?? "monthly", 64) ?? "monthly";
  const hasBaseline = root["pastTotalMonthlyCost"] !== undefined || pastResources.length > 0;
  const baselineReason = !hasBaseline
    ? "No comparable baseline was provided."
    : currency === null
      ? "The estimator did not report a currency."
      : pastCurrency !== currency
        ? "Currency differs between the estimate and its baseline."
        : timeBasis !== "monthly"
          ? "The estimate and baseline do not use the monthly time basis."
          : null;
  const warnings = [
    unmatched > 0 ? `${unmatched} resource${unmatched === 1 ? " has" : "s have"} no supported price; totals exclude those resources.` : null,
    currency === null ? "The estimator did not report a currency; compare totals only after confirming the pricing context." : null,
    pastCurrency !== null && currency !== null && pastCurrency !== currency ? "The estimate and baseline use different currencies." : null,
    timeBasis !== "monthly" ? `The estimator reported a ${timeBasis} time basis; monthly comparisons are disabled.` : null,
    !hasBaseline ? "No baseline estimate was supplied; the prior value is shown as zero for compatibility only." : null,
  ].filter((value): value is string => value !== null);
  const provenance: CostEstimateProvenance = {
    tool: "infracost",
    version: boundedString(root["version"], 128),
    "pricing-date": boundedString(root["pricingDate"] ?? root["pricing-date"], 64),
    currency,
    "time-basis": timeBasis,
    "supported-resources": matched,
    assumptions: assumptions(root),
  };
  const comparison: CostEstimateComparison = {
    baseline: {
      source: hasBaseline ? "infracost-past-breakdown" : "none",
      "monthly-cost": hasBaseline ? prior : null,
      currency: pastCurrency,
      comparable: baselineReason === null,
      reason: baselineReason,
    },
    warnings,
    "resource-changes": resourceChanges(
      resourceCosts(projects, "breakdown"),
      resourceCosts(projects, "pastBreakdown"),
      resourceCosts(projects, "diff"),
    ),
  };

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
    provenance,
    comparison,
  };
}

export async function writeCostEstimateArtifact(
  runId: string,
  estimate: CostEstimateAttributes,
): Promise<void> {
  await mkdir(costEstimateDirectory(), { recursive: true, mode: 0o700 });
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
