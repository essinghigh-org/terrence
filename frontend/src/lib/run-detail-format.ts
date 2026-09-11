import { formatDateTime, type DeepReadonly } from "@/lib/utils";
import type { JsonObject } from "@/lib/json";
import { isBigInt, isBoolean, isNumber, isObjectLike, isString } from "./type-guards";
import type { PolicyCheck } from "./run-view-state";

export const RUN_EVENT_LABELS = {
  apply: "Run confirmed",
  cancel: "Run canceled",
  create: "Run created",
  discard: "Run discarded",
  "force-cancel": "Run force canceled",
  "override-policy": "Policy check overridden",
} as const;

export function formatDate(value: string | undefined): string {
  if (value === undefined || value === "") return "—";
  const date = new Date(value);
  return formatDateTime(date);
}

export function timestampMilliseconds(key: string, value: string | undefined): number | undefined {
  // status-timestamps also carries plan metadata (for example
  // input-state-serial and saved-plan-sha256).  Numeric metadata is accepted
  // by Date.parse and can otherwise turn a 9-minute run into millennia.
  if (!key.endsWith("-at") || value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

export function formatDurationMilliseconds(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "Unavailable";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "Less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainder === 0 ? "" : ` ${remainder} min`}`;
}

export function formatDuration(start: string | undefined, end: string | undefined): string {
  if (start === undefined || end === undefined) return "Unavailable";
  return formatDurationMilliseconds(Date.parse(end) - Date.parse(start));
}

export const PLAN_DURATION_END_KEYS = [
  "planned-at",
  "planned-and-finished-at",
  "planned-and-saved-at",
  "errored-at",
  "unreachable-at",
  "canceled-at",
  "force-canceled-at",
] as const;
export const APPLY_DURATION_END_KEYS = [
  "applied-at",
  "errored-at",
  "unreachable-at",
  "canceled-at",
  "force-canceled-at",
] as const;

export type RunProvenanceManifest = Readonly<{
  schemaVersion: number;
  runId: string;
  configuration: Readonly<{ versionId: string | null; digest: string; source: string | null; commitSha: string | null; branch: string | null }>;
  engine: Readonly<{ binary: string; version: string | null; digest: string | null }>;
  workspace: Readonly<{ workingDirectory: string | null; executionMode: string }>;
  inputState: Readonly<{ id: string | null; digest: string | null }>;
  variables: readonly Readonly<{ key: string; category: string; source: string; sensitive: boolean }>[];
  sandbox: Readonly<{ required: boolean; networkPolicy: string; executor: string }>;
  rerun?: Readonly<{ mode: "original" | "current"; sourceRunId: string; changedSinceSource: readonly string[] }>;
}>;

type RunTaskStage = Readonly<{
  attributes?: Readonly<{ status?: unknown }>;
}>;

export function taskOutcomeLabel(value: unknown): string {
  if (!Array.isArray(value)) return "Unavailable";
  if (value.length === 0) return "No task stages";
  const statuses = value.map((item: unknown): string => {
    const status = (item as RunTaskStage | null)?.attributes?.status;
    return isString(status) ? status : "unknown";
  });
  if (statuses.some((status: string): boolean => ["failed", "errored", "unreachable"].includes(status))) return "Failed";
  if (statuses.some((status: string): boolean => ["running"].includes(status))) return "Running";
  if (statuses.some((status: string): boolean => ["pending", "queued"].includes(status))) return "Queued";
  if (statuses.every((status: string): boolean => ["passed", "overridden"].includes(status))) return "Passed";
  return "Reported";
}

export function firstTimestampMilliseconds(
  timestamps: Readonly<Record<string, string>>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = timestampMilliseconds(key, timestamps[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function runExecutionDurationMilliseconds(
  timestamps: Readonly<Record<string, string>>,
  planOnly: boolean,
  now = Date.now(),
): number | undefined {
  const planStart = timestampMilliseconds("planning-at", timestamps["planning-at"])
    ?? timestampMilliseconds("pending-at", timestamps["pending-at"])
    ?? timestampMilliseconds("planned-at", timestamps["planned-at"]);
  const planEnd = firstTimestampMilliseconds(timestamps, PLAN_DURATION_END_KEYS);
  if (planStart === undefined) return undefined;
  const planDuration = planEnd === undefined
    ? Math.max(0, now - planStart)
    : Math.max(0, planEnd - planStart);
  if (planOnly) return planDuration;

  const applyStart = timestampMilliseconds("applying-at", timestamps["applying-at"]);
  if (applyStart === undefined) {
    const legacyEnd = timestampMilliseconds("applied-at", timestamps["applied-at"]);
    if (legacyEnd !== undefined) {
      return Math.max(0, legacyEnd - planStart);
    }
    return planDuration;
  }
  const applyEnd = firstTimestampMilliseconds(timestamps, APPLY_DURATION_END_KEYS);
  return planDuration + (applyEnd === undefined
    ? Math.max(0, now - applyStart)
    : Math.max(0, applyEnd - applyStart));
}

/** Format a duration stored as seconds (e.g. "300" -> "5 minutes"). */
export function formatDurationSeconds(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return "Unavailable";
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 1) return "Less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainder === 0 ? "" : ` ${remainder} min`}`;
}

export function formatExplainElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function formatMonthlyCost(value: string | undefined, currency = "USD", timeBasis = "monthly"): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const normalizedCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  const normalizedBasis = /^[A-Za-z0-9 _-]{1,32}$/.test(timeBasis) ? timeBasis : "period";
  return `${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: normalizedCurrency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)} / ${normalizedBasis === "monthly" ? "month" : normalizedBasis}`;
}

function formatViolationSummary(violations: readonly unknown[]): string {
  return `${violations.length} violation${violations.length === 1 ? "" : "s"}${
    violations.length > 0 ? `: ${violations.map(String).join(", ")}` : ""
  }`;
}

function formatFailureCounts(details: DeepReadonly<JsonObject>): string {
  const parts: string[] = [];
  for (const [key, label] of [
    ["hard-failed", "hard failure"],
    ["soft-failed", "soft failure"],
    ["advisory-failed", "advisory failure"],
  ] as const) {
    const count = details[key];
    if (isNumber(count) && count > 0) {
      parts.push(`${count} ${label}${count === 1 ? "" : "s"}`);
    }
  }
  return parts.join(" — ");
}

function describePolicyResultObject(result: unknown, details: DeepReadonly<JsonObject>): string {
  const summary: string[] = [];
  if (isString(details["policy"])) summary.push(details["policy"]);
  if (isString(details["error"])) summary.push(details["error"]);
  const violations = details["violations"];
  if (Array.isArray(violations)) {
    summary.push(formatViolationSummary(violations));
  }
  const failureText = formatFailureCounts(details);
  if (failureText !== "") summary.push(failureText);
  return summary.length > 0 ? summary.join(" — ") : JSON.stringify(result);
}

export function policyResultText(result: unknown): string {
  if (result === null || result === undefined) return "No detailed result";
  if (isString(result)) return result;
  if (isNumber(result) || isBoolean(result) || isBigInt(result)) return `${result}`;
  if (!isObjectLike(result)) return "No detailed result";
// SAFETY: the fixture object is read as a record; each field is typed below.
  const details = result as JsonObject;
  return describePolicyResultObject(result, details);
}

export function isAdvisoryPolicyIssue(check: PolicyCheck): boolean {
  const failureLike = ["failed", "errored", "unreachable"].includes(check.attributes.status);
  if (!failureLike) return false;
  if (check.attributes["enforcement-level"] === "advisory") return true;
  if (check.attributes.status !== "failed") return false;
  const result = check.attributes.result;
  // SAFETY: the run result payload is read as a record; the advisory-failed
  // field is typeof-validated before the comparison.
  return result !== null
    && isObjectLike(result)
    && !Array.isArray(result)
    && isNumber((result as JsonObject)["advisory-failed"])
    && ((result as JsonObject)["advisory-failed"] as number) > 0;
}

export async function waitForAbortableDelay(signal: Readonly<AbortSignal>, delayMs: number): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve): void => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => { finish(false); };
    const timer = window.setTimeout((): void => { finish(true); }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish(false);
  });
}
