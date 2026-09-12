import { createHash } from "node:crypto";
import { decodeStatePayload } from "./validation";

/** Metadata only: never persist resource attributes, addresses or output values here. */
export type StateSummary = {
  version: 1;
  digest: string;
  generation: string;
  status: "ready" | "opaque" | "invalid";
  md5: string;
  size: number;
  lineage: string | null;
  terraformVersion: string | null;
  stateVersion: number | null;
  resourceCount: number;
  managedCount: number;
  dataCount: number;
  moduleCount: number;
  providerCount: number;
  outputCount: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedIdentityString(value: unknown): string | null {
  // Identity strings are bounded without truncating them into different identities.
  return typeof value === "string" && value.length <= 256 ? value : null;
}

function countStateResources(state: Record<string, unknown>, summary: StateSummary): void {
  const modules = new Set<string>();
  const providers = new Set<string>();
  for (const resource of Array.isArray(state["resources"]) ? state["resources"] : []) {
    if (!record(resource)) continue;
    const count = Array.isArray(resource["instances"]) ? resource["instances"].length : 0;
    summary.resourceCount += count;
    if (resource["mode"] === "data") summary.dataCount += count;
    else summary.managedCount += count;
    modules.add(typeof resource["module"] === "string" ? resource["module"] : "root");
    if (typeof resource["provider"] === "string") providers.add(resource["provider"]);
  }
  summary.moduleCount = modules.size;
  summary.providerCount = providers.size;
  summary.outputCount = record(state["outputs"]) ? Object.keys(state["outputs"]).length : 0;
}

function validSummaryCounts(value: Record<string, unknown>): boolean {
  for (const key of ["size", "resourceCount", "managedCount", "dataCount", "moduleCount", "providerCount", "outputCount"]) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return false;
  }
  return true;
}

function validSummaryIdentity(value: Record<string, unknown>): boolean {
  if (typeof value["md5"] !== "string" || !/^[a-f0-9]{32}$/.test(value["md5"])) return false;
  for (const key of ["lineage", "terraformVersion"]) {
    if (value[key] !== null && (typeof value[key] !== "string" || (value[key]).length > 256)) return false;
  }
  return value["stateVersion"] === null || value["stateVersion"] === 4;
}

export function buildStateSummary(payload: string): StateSummary {
  const canonical = decodeStatePayload(payload);
  const digest = createHash("sha256").update(canonical).digest("hex");
  let parsed: unknown;
  try { parsed = JSON.parse(canonical); } catch { parsed = null; }
  const state = record(parsed) ? parsed : null;
  const opaque = state !== null && ("encryption_version" in state || "encrypted_data" in state);
  const ready = state !== null && state["version"] === 4 && !opaque;
  const summary: StateSummary = {
    version: 1, digest, generation: `1:${digest}`, status: opaque ? "opaque" : ready ? "ready" : "invalid",
    md5: createHash("md5").update(canonical).digest("hex"), size: Buffer.byteLength(canonical),
    lineage: null, terraformVersion: null, stateVersion: null,
    resourceCount: 0, managedCount: 0, dataCount: 0, moduleCount: 0, providerCount: 0, outputCount: 0,
  };
  if (!ready || state === null) return summary;
  summary.lineage = boundedIdentityString(state["lineage"]);
  summary.terraformVersion = boundedIdentityString(state["terraform_version"]);
  summary.stateVersion = 4;
  countStateResources(state, summary);
  return summary;
}

export function readStateSummary(raw: string | null, digest: string | null): StateSummary | null {
  if (raw === null || raw.length > 4096 || digest === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value["version"] !== 1 || value["digest"] !== digest || value["generation"] !== `1:${digest}`) return null;
    if (!["ready", "opaque", "invalid"].includes(String(value["status"]))) return null;
    if (!validSummaryCounts(value) || !validSummaryIdentity(value)) return null;
    return value as StateSummary;
  } catch { return null; }
}
