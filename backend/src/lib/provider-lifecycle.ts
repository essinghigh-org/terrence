import { createHash } from "node:crypto";

export type LifecycleContract = Readonly<{
  version: number;
  name: string;
  behaviors: readonly string[];
  fixtures: readonly LifecycleFixture[];
}>;

export type LifecycleFixture = Readonly<{
  id: string;
  label: string;
  priority?: boolean;
  resources: readonly string[];
  required_behaviors: readonly string[];
}>;

export type LifecycleFixtureEvidence = Readonly<{
  id: string;
  status: "passed" | "failed" | "not-run";
  resources: readonly string[];
  behaviors: readonly string[];
  normalized_state?: Readonly<{
    baseline_sha256?: string;
    converged_sha256?: string;
    restored_sha256?: string;
    equivalent?: boolean;
  }>;
  failure?: string;
}>;

export type LifecycleEvidence = Readonly<{
  contract_version: number;
  fixtures: readonly LifecycleFixtureEvidence[];
}>;

const VOLATILE_KEY = /^(?:id|lineage|serial|created(?:[-_]at|At)?|updated(?:[-_]at|At)?|(?:created|updated)[-_]?timestamp|timestamp)$/i;
const ID_KEY = /(?:^|[-_])id$/i;
const SECRET_KEY = /(?:token|secret|password|private[-_]?key|oauth[-_]?token|api[-_]?key)/i;

/**
 * Normalize Terraform/OpenTofu JSON state before comparing lifecycle steps.
 *
 * Provider IDs, state serials and server timestamps are intentionally omitted.
 * Object keys are sorted recursively and sensitive-looking values are replaced
 * so evidence can be hashed without persisting credentials or generated IDs.
 */
export function normalizeProviderState(value: unknown, key?: string): unknown {
  if (key !== undefined && (VOLATILE_KEY.test(key) || ID_KEY.test(key))) return undefined;
  if (key !== undefined && SECRET_KEY.test(key)) return "[redacted]";
  if (Array.isArray(value)) {
    return value
      .map((entry): unknown => normalizeProviderState(entry))
      .filter((entry): boolean => entry !== undefined);
  }
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const child = normalizeProviderState(childValue, childKey);
      if (child !== undefined) normalized[childKey] = child;
    }
    return Object.fromEntries(Object.entries(normalized).sort(([a], [b]): number => a < b ? -1 : a > b ? 1 : 0));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

export function normalizedStateDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(normalizeProviderState(value))).digest("hex");
}

export function normalizedStatesEqual(left: unknown, right: unknown): boolean {
  return stableJson(normalizeProviderState(left)) === stableJson(normalizeProviderState(right));
}

/** Return deterministic, human-readable gaps in a lifecycle evidence report. */
export function lifecycleEvidenceGaps(contract: LifecycleContract, evidence: LifecycleEvidence): string[] {
  const byId = new Map(evidence.fixtures.map((fixture): [string, LifecycleFixtureEvidence] => [fixture.id, fixture]));
  const gaps: string[] = [];
  for (const fixture of contract.fixtures) {
    const actual = byId.get(fixture.id);
    if (actual === undefined) {
      gaps.push(`${fixture.id}: missing fixture evidence`);
      continue;
    }
    if (actual.status !== "passed") {
      gaps.push(`${fixture.id}: status=${actual.status}${actual.failure === undefined ? "" : ` (${actual.failure})`}`);
    }
    const resources = new Set(actual.resources);
    for (const resource of fixture.resources) {
      if (![...resources].some((candidate): boolean => candidate === resource || candidate.startsWith(`${resource}.`))) {
        gaps.push(`${fixture.id}: missing resource ${resource}`);
      }
    }
    const behaviors = new Set(actual.behaviors);
    for (const behavior of fixture.required_behaviors) {
      if (!behaviors.has(behavior)) gaps.push(`${fixture.id}: missing behavior ${behavior}`);
    }
    if (fixture.required_behaviors.includes("normalized-state-convergence")
      && (actual.normalized_state?.equivalent !== true
        || actual.normalized_state.baseline_sha256 === undefined
        || actual.normalized_state.restored_sha256 === undefined
        || actual.normalized_state.baseline_sha256 !== actual.normalized_state.restored_sha256)) {
      gaps.push(`${fixture.id}: normalized state did not converge`);
    }
  }
  return gaps.sort();
}

export function assertLifecycleEvidence(contract: LifecycleContract, evidence: LifecycleEvidence): void {
  if (evidence.contract_version !== contract.version) {
    throw new Error(`Lifecycle evidence contract version ${evidence.contract_version} does not match ${contract.version}`);
  }
  const gaps = lifecycleEvidenceGaps(contract, evidence);
  if (gaps.length > 0) throw new Error(`Incomplete provider lifecycle evidence:\n${gaps.map((gap): string => `- ${gap}`).join("\n")}`);
}
