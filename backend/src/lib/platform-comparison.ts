import { createHash } from "node:crypto";
import { isClientEncryptedState, parseTerraformStatePayload } from "./validation";
import { sanitizePlanJson, type PlanJson } from "./plan-json";
import { canonicalJson, sha256Hex } from "./run-provenance";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function pathString(parts: readonly (string | number)[]): string {
  return parts.reduce<string>((path, part): string => typeof part === "number" ? `${path}[${part}]` : path === "" ? part : `${path}.${part}`, "");
}

const SENSITIVE_KEY = /(secret|password|token|credential|private[_-]?key|access[_-]?key|client[_-]?secret|api[_-]?key)/i;
const UNKNOWN_VALUE = { unknown: true } as const;
const SENSITIVE_VALUE = { sensitive: true } as const;

function sensitivePathSet(value: unknown): ReadonlySet<string> {
  if (value === undefined || value === null) return new Set();
  // Unknown metadata must not silently turn a sensitive attribute public.
  if (!Array.isArray(value)) return new Set([""]);
  const paths: string[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry)) return new Set([""]);
    const parts: (string | number)[] = [];
    for (const part of entry) {
      if (typeof part === "string" || typeof part === "number") parts.push(part);
      else if (record(part) && (part["type"] === "get_attr" || part["type"] === "index")
        && (typeof part["value"] === "string" || typeof part["value"] === "number")) parts.push(part["value"]);
      else if (record(part) && part["type"] === "index" && record(part["value"])
        && (typeof part["value"]["value"] === "string" || typeof part["value"]["value"] === "number")) parts.push(part["value"]["value"]);
      else return new Set([""]);
    }
    paths.push(pathString(parts));
  }
  return new Set(paths);
}

function isSensitivePath(path: string, paths: ReadonlySet<string>): boolean {
  if (paths.has("") || paths.has(path)) return true;
  for (const prefix of paths) {
    if (path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)) return true;
  }
  return false;
}

function safeValue(value: unknown, path: string, sensitive: ReadonlySet<string>, depth: number): unknown {
  if (isSensitivePath(path, sensitive)) return SENSITIVE_VALUE;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 256 ? UNKNOWN_VALUE : value;
  if (depth > 4) return UNKNOWN_VALUE;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry, index): unknown => safeValue(entry, `${path}[${index}]`, sensitive, depth + 1));
  if (!record(value)) return UNKNOWN_VALUE;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]): [string, unknown] => [
    key,
    SENSITIVE_KEY.test(key)
      ? SENSITIVE_VALUE
      : safeValue(entry, path === "" ? key : `${path}.${key}`, sensitive, depth + 1),
  ]));
}

function isSensitiveMarker(value: unknown): boolean {
  return record(value) && value["sensitive"] === true && Object.keys(value).length === 1;
}

function equalSafe(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

type AttributeChange = Readonly<{
  path: string;
  before: unknown;
  after: unknown;
  changed: boolean | null;
}>;

function attributeChanges(before: unknown, after: unknown, path = ""): AttributeChange[] {
  const beforeSensitive = isSensitiveMarker(before);
  const afterSensitive = isSensitiveMarker(after);
  if (beforeSensitive || afterSensitive) {
    return equalSafe(before, after)
      ? []
      : [{ path: path || "<root>", before: SENSITIVE_VALUE, after: SENSITIVE_VALUE, changed: null }];
  }
  if (equalSafe(before, after)) return [];
  if (record(before) || record(after)) {
    const left = record(before) ? before : {};
    const right = record(after) ? after : {};
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key): AttributeChange[] => attributeChanges(left[key], right[key], path === "" ? key : `${path}.${key}`));
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    const left = Array.isArray(before) ? before : [];
    const right = Array.isArray(after) ? after : [];
    const count = Math.max(left.length, right.length);
    return Array.from({ length: count }, (_, index): AttributeChange[] => attributeChanges(left[index], right[index], `${path}[${index}]`)).flat();
  }
  return [{ path: path || "<root>", before: before ?? null, after: after ?? null, changed: true }];
}

type ParsedStateResource = Readonly<{
  address: string;
  mode: string;
  type: string;
  provider: string;
  identity: string;
  attributes: unknown;
  sensitivePaths: ReadonlySet<string>;
  identitySource: "provider-id" | "address";
}>;

function resourceAddress(resource: JsonRecord, instance: JsonRecord, index: number): string {
  const module = stringValue(resource["module"]);
  const base = `${resource["type"]}.${resource["name"]}`;
  const indexed = instance["index_key"] === undefined
    ? (Array.isArray(resource["instances"]) && resource["instances"].length > 1 ? `[${index}]` : "")
    : typeof instance["index_key"] === "number" ? `[${instance["index_key"]}]` : `[${JSON.stringify(instance["index_key"])}]`;
  return `${module === null ? "" : `${module}.`}${base}${indexed}`;
}

function parsedStateResources(state: JsonRecord): ParsedStateResource[] {
  if (!Array.isArray(state["resources"])) return [];
  return state["resources"].flatMap((raw): ParsedStateResource[] => {
    if (!record(raw) || !Array.isArray(raw["instances"])) return [];
    const type = stringValue(raw["type"]);
    const provider = stringValue(raw["provider"]);
    const mode = stringValue(raw["mode"]);
    if (type === null || provider === null || mode === null) return [];
    return raw["instances"].flatMap((rawInstance, index): ParsedStateResource[] => {
      if (!record(rawInstance)) return [];
      const attributes = record(rawInstance["attributes"]) ? rawInstance["attributes"] : {};
      const sensitivePaths = sensitivePathSet(rawInstance["sensitive_attributes"]);
      const id = isSensitivePath("id", sensitivePaths) ? null : stringValue(attributes["id"]);
      return [{
        address: resourceAddress(raw, rawInstance, index),
        mode,
        type,
        provider,
        identity: id === null ? `${provider}|${type}|${resourceAddress(raw, rawInstance, index)}` : `${provider}|${type}|${id}`,
        attributes,
        sensitivePaths,
        identitySource: id === null ? "address" : "provider-id",
      }];
    });
  });
}

export type StateVersionComparisonInput = Readonly<{
  id: string;
  workspaceId: string;
  serial: number;
  statePayload: string | null;
  stateSummary: string | null;
  uploadSha256: string | null;
  runId: string | null;
  createdAt: number;
}>;

function summaryDigest(version: StateVersionComparisonInput): string | null {
  if (version.uploadSha256 !== null && /^[a-f0-9]{64}$/.test(version.uploadSha256)) return version.uploadSha256;
  if (version.stateSummary === null) return null;
  try {
    const parsed = JSON.parse(version.stateSummary) as unknown;
    return record(parsed) && typeof parsed["digest"] === "string" ? parsed["digest"] : null;
  } catch {
    return null;
  }
}

function stateVersionMetadata(version: StateVersionComparisonInput, state: JsonRecord | null): Record<string, unknown> {
  const summary = version.stateSummary === null ? null : (() => {
    try { return JSON.parse(version.stateSummary) as unknown; } catch { return null; }
  })();
  return {
    id: version.id,
    serial: version.serial,
    digest: summaryDigest(version),
    runId: version.runId,
    createdAt: new Date(version.createdAt).toISOString(),
    representation: isClientEncryptedState(version.statePayload) ? "opaque" : state === null ? "unavailable" : "terraform-v4",
    summary: record(summary) ? {
      resourceCount: summary["resourceCount"] ?? null,
      outputCount: summary["outputCount"] ?? null,
      moduleCount: summary["moduleCount"] ?? null,
      providerCount: summary["providerCount"] ?? null,
    } : null,
  };
}

export type StateComparison = Readonly<{
  mode: "detailed" | "limited";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  resources: Readonly<{ added: readonly Record<string, unknown>[]; removed: readonly Record<string, unknown>[]; changed: readonly Record<string, unknown>[]; moved: readonly Record<string, unknown>[] }>;
  outputs: Readonly<{ added: readonly Record<string, unknown>[]; removed: readonly Record<string, unknown>[]; changed: readonly Record<string, unknown>[] }>;
  provenance: Readonly<{ beforeDigest: string | null; afterDigest: string | null; liveCloudChangeProven: false }>;
}>;

export function compareStateVersions(before: StateVersionComparisonInput, after: StateVersionComparisonInput): StateComparison {
  const beforeState = parseTerraformStatePayload(before.statePayload);
  const afterState = parseTerraformStatePayload(after.statePayload);
  if (beforeState === null || afterState === null) {
    return {
      mode: "limited",
      before: stateVersionMetadata(before, beforeState),
      after: stateVersionMetadata(after, afterState),
      resources: { added: [], removed: [], changed: [], moved: [] },
      outputs: { added: [], removed: [], changed: [] },
      provenance: { beforeDigest: summaryDigest(before), afterDigest: summaryDigest(after), liveCloudChangeProven: false },
    };
  }
  const beforeResources = parsedStateResources(beforeState);
  const afterResources = parsedStateResources(afterState);
  const beforeByAddress = new Map(beforeResources.map((resource): [string, ParsedStateResource] => [resource.address, resource]));
  const beforeByIdentity = new Map(beforeResources.map((resource): [string, ParsedStateResource] => [resource.identity, resource]));
  const afterAddresses = new Set(afterResources.map((resource): string => resource.address));
  const matchedBefore = new Set<string>();
  const added: Record<string, unknown>[] = [];
  const changed: Record<string, unknown>[] = [];
  const moved: Record<string, unknown>[] = [];
  for (const resource of afterResources) {
    const previous = beforeByAddress.get(resource.address) ?? beforeByIdentity.get(resource.identity);
    if (previous === undefined) {
      added.push({ address: resource.address, mode: resource.mode, type: resource.type, provider: resource.provider });
      continue;
    }
    matchedBefore.add(previous.address);
    const sensitivePaths = new Set([...previous.sensitivePaths, ...resource.sensitivePaths]);
    const differences = attributeChanges(
      safeValue(previous.attributes, "", sensitivePaths, 0),
      safeValue(resource.attributes, "", sensitivePaths, 0),
    );
    if (previous.address !== resource.address) {
      moved.push({ from: previous.address, to: resource.address, identity: resource.identity, identitySource: resource.identitySource });
    }
    if (differences.length > 0) {
      changed.push({ address: resource.address, actions: ["update"], "changed-attributes": differences });
    }
  }
  const removed = beforeResources
    .filter((resource): boolean => !matchedBefore.has(resource.address) && !afterAddresses.has(resource.address))
    .map((resource): Record<string, unknown> => ({ address: resource.address, mode: resource.mode, type: resource.type, provider: resource.provider }));
  const outputComparison = compareStateOutputs(beforeState["outputs"], afterState["outputs"]);
  return {
    mode: "detailed",
    before: stateVersionMetadata(before, beforeState),
    after: stateVersionMetadata(after, afterState),
    resources: { added, removed, changed, moved },
    outputs: outputComparison,
    provenance: { beforeDigest: summaryDigest(before), afterDigest: summaryDigest(after), liveCloudChangeProven: false },
  };
}

function compareStateOutputs(beforeRaw: unknown, afterRaw: unknown): StateComparison["outputs"] {
  const before = record(beforeRaw) ? beforeRaw : {};
  const after = record(afterRaw) ? afterRaw : {};
  const added: Record<string, unknown>[] = [];
  const removed: Record<string, unknown>[] = [];
  const changed: Record<string, unknown>[] = [];
  for (const name of Object.keys(after).sort()) {
    const output = record(after[name]) ? after[name] : {};
    if (!(name in before)) {
      added.push({ name, sensitive: output["sensitive"] === true, type: output["type"] ?? null });
      continue;
    }
    const previous = record(before[name]) ? before[name] : {};
    const sensitive = previous["sensitive"] === true || output["sensitive"] === true;
    const beforeValue = sensitive ? SENSITIVE_VALUE : safeValue(previous["value"], "", new Set(), 0);
    const afterValue = sensitive ? SENSITIVE_VALUE : safeValue(output["value"], "", new Set(), 0);
    const difference = sensitive ? null : !equalSafe(beforeValue, afterValue);
    if (difference !== false || previous["type"] !== output["type"] || previous["sensitive"] !== output["sensitive"]) {
      changed.push({ name, sensitive, type: output["type"] ?? previous["type"] ?? null, before: beforeValue, after: afterValue, changed: difference });
    }
  }
  for (const name of Object.keys(before).sort()) {
    if (name in after) continue;
    const output = record(before[name]) ? before[name] : {};
    removed.push({ name, sensitive: output["sensitive"] === true, type: output["type"] ?? null });
  }
  return { added, removed, changed };
}

function planResourceMap(plan: PlanJson): Map<string, JsonRecord> {
  const values = Array.isArray(plan["resource_changes"]) ? plan["resource_changes"] : [];
  return new Map(values.flatMap((raw): [string, JsonRecord][] => {
    if (!record(raw) || typeof raw["address"] !== "string") return [];
    return [[raw["address"], raw]];
  }));
}

function planActions(raw: JsonRecord): readonly string[] {
  const change = record(raw["change"]) ? raw["change"] : {};
  return Array.isArray(change["actions"]) ? change["actions"].filter((action): action is string => typeof action === "string") : [];
}

export function comparePlanJson(beforeRaw: PlanJson, afterRaw: PlanJson): Record<string, unknown> {
  const before = sanitizePlanJson(beforeRaw);
  const after = sanitizePlanJson(afterRaw);
  const beforeMap = planResourceMap(before);
  const afterMap = planResourceMap(after);
  const added: Record<string, unknown>[] = [];
  const removed: Record<string, unknown>[] = [];
  const changed: Record<string, unknown>[] = [];
  const moved: Record<string, unknown>[] = [];
  for (const [address, current] of afterMap) {
    const previous = beforeMap.get(address);
    if (previous === undefined) {
      const previousAddress = typeof current["previous_address"] === "string" ? current["previous_address"] : null;
      if (previousAddress !== null && beforeMap.has(previousAddress)) moved.push({ from: previousAddress, to: address, actions: planActions(current) });
      else added.push({ address, actions: planActions(current), destructive: planActions(current).includes("delete") });
      continue;
    }
    const beforeActions = planActions(previous);
    const afterActions = planActions(current);
    const beforeChange = record(previous["change"]) ? previous["change"] : {};
    const afterChange = record(current["change"]) ? current["change"] : {};
    const paths = Array.isArray(afterChange["replace_paths"])
      ? afterChange["replace_paths"].flatMap((path): string[] => Array.isArray(path) ? [path.map((part): string => String(part)).join(".")] : [])
      : [];
    const differences = attributeChanges(beforeChange["after"], afterChange["after"]);
    if (!equalSafe(beforeActions, afterActions) || differences.length > 0 || paths.length > 0 || before["action_reason"] !== after["action_reason"]) {
      changed.push({
        address,
        beforeActions,
        afterActions,
        "changed-attribute-paths": [...new Set([...paths, ...differences.map((difference): string => difference.path)])],
        "newly-destructive": !beforeActions.includes("delete") && afterActions.includes("delete"),
        "replacement-reason": after["action_reason"] ?? null,
      });
    }
  }
  for (const [address, previous] of beforeMap) {
    if (afterMap.has(address) || moved.some((entry): boolean => entry["from"] === address)) continue;
    removed.push({ address, actions: planActions(previous), destructive: planActions(previous).includes("delete") });
  }
  const outputChanges = comparePlanOutputs(before["output_changes"], after["output_changes"]);
  return {
    version: 1,
    before: { formatVersion: before["format_version"] ?? null, terraformVersion: before["terraform_version"] ?? null },
    after: { formatVersion: after["format_version"] ?? null, terraformVersion: after["terraform_version"] ?? null },
    resources: { added, removed, changed, moved },
    outputs: outputChanges,
    provenance: { comparison: "public-plan-projection", sensitiveValuesCompared: false },
  };
}

function comparePlanOutputs(beforeRaw: unknown, afterRaw: unknown): Record<string, unknown> {
  const before = record(beforeRaw) ? beforeRaw : {};
  const after = record(afterRaw) ? afterRaw : {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const name of Object.keys(after).sort()) {
    if (!(name in before)) added.push(name);
    else if (!equalSafe(before[name], after[name])) changed.push(name);
  }
  for (const name of Object.keys(before).sort()) if (!(name in after)) removed.push(name);
  return { added, removed, changed };
}

export type InventoryObservation = Readonly<{
  identity: string;
  identitySource: "provider-id" | "address";
  address: string;
  mode: string;
  type: string;
  provider: string;
  stateVersionId: string;
  serial: number;
  runId: string | null;
  observedAt: string;
}>;

export function stateInventoryObservations(version: StateVersionComparisonInput): readonly InventoryObservation[] {
  const state = parseTerraformStatePayload(version.statePayload);
  if (state === null) return [];
  return parsedStateResources(state).map((resource): InventoryObservation => ({
    identity: resource.identity,
    identitySource: resource.identitySource,
    address: resource.address,
    mode: resource.mode,
    type: resource.type,
    provider: resource.provider,
    stateVersionId: version.id,
    serial: version.serial,
    runId: version.runId,
    observedAt: new Date(version.createdAt).toISOString(),
  }));
}

export function driftFingerprint(input: Readonly<{ workspaceId: string; assessmentId?: string; drifted: boolean | null; checks: readonly Record<string, unknown>[]; }>): string {
  const checks = input.checks.map((check): Record<string, unknown> => ({
    address: check["address"] ?? null,
    status: check["status"] ?? null,
    kind: check["kind"] ?? null,
  })).sort((left, right): number => canonicalJson(left).localeCompare(canonicalJson(right)));
  // The assessment ID identifies one observation. It is deliberately omitted
  // so equivalent observations coalesce into one incident across runs.
  return sha256Hex(canonicalJson({ workspaceId: input.workspaceId, drifted: input.drifted, checks }));
}

export function dependencyImpact(input: Readonly<{
  rootWorkspaceId: string;
  edges: readonly Readonly<{ from: string; to: string; source: "explicit" | "observed-output" | "inferred"; sourceRunId?: string | null }>[];
  maxFanout?: number;
}>): Readonly<{ edges: readonly Record<string, unknown>[]; cycles: readonly string[][]; truncated: boolean }> {
  const maxFanout = Math.min(Math.max(input.maxFanout ?? 100, 1), 100);
  const accepted = input.edges.filter((edge): boolean => edge.from !== edge.to && edge.from !== "" && edge.to !== "");
  const counts = new Map<string, number>();
  const kept = accepted.filter((edge): boolean => {
    const count = counts.get(edge.from) ?? 0;
    if (count >= maxFanout) return false;
    counts.set(edge.from, count + 1);
    return true;
  });
  const adjacency = new Map<string, string[]>();
  for (const edge of kept) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const cycles: string[][] = [];
  const active = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (node: string): void => {
    if (active.has(node)) {
      const start = path.indexOf(node);
      cycles.push(start < 0 ? [node] : [...path.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    active.add(node);
    path.push(node);
    for (const child of adjacency.get(node) ?? []) visit(child);
    path.pop();
    active.delete(node);
  };
  visit(input.rootWorkspaceId);
  return {
    edges: kept.map((edge): Record<string, unknown> => ({ from: edge.from, to: edge.to, source: edge.source, "source-run-id": edge.sourceRunId ?? null })),
    cycles,
    truncated: kept.length < accepted.length,
  };
}

export type ImportMapping = Readonly<{ address: string; providerId: string; provider?: string; mode?: string }>;

export function validateImportMappings(raw: unknown): Readonly<{ mappings: readonly ImportMapping[]; errors: readonly string[] }> {
  if (!Array.isArray(raw)) return { mappings: [], errors: ["mappings must be an array"] };
  const mappings: ImportMapping[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const [index, value] of raw.entries()) {
    if (!record(value)) { errors.push(`mappings[${index}] must be an object`); continue; }
    const address = stringValue(value["address"]);
    const providerId = stringValue(value["provider-id"] ?? value["providerId"] ?? value["id"]);
    if (address === null || !/^(?:module\.[A-Za-z0-9_\-.]+\.)?[A-Za-z0-9_]+\.[A-Za-z0-9_]+(?:\[[^\]]+\])?$/.test(address)) errors.push(`mappings[${index}].address is invalid`);
    if (providerId === null || providerId.length > 512) errors.push(`mappings[${index}].provider-id is required and bounded`);
    if (providerId !== null && ids.has(providerId)) errors.push(`mappings[${index}].provider-id duplicates another mapping`);
    if (providerId !== null) ids.add(providerId);
    if (address !== null && providerId !== null) mappings.push({
      address,
      providerId,
      ...(typeof value["provider"] === "string" ? { provider: value["provider"] } : {}),
      ...(typeof value["mode"] === "string" ? { mode: value["mode"] } : {}),
    });
  }
  return { mappings, errors };
}

export function importConfiguration(mapping: ImportMapping): string {
  return `import {\n  to = ${mapping.address}\n  id = ${JSON.stringify(mapping.providerId)}\n}`;
}

export function inputDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function upgradeRehearsalResult(input: Readonly<{ engine: string; version: string; baselineFresh: boolean; candidateLockDigest: string | null }>): Record<string, unknown> {
  const engine = input.engine === "terraform" || input.engine === "tofu" ? input.engine : null;
  const version = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.test(input.version) ? input.version : null;
  const failures = [
    ...(engine === null ? ["engine must be terraform or tofu"] : []),
    ...(version === null ? ["candidate engine version must use a bounded semantic version"] : []),
    ...(input.candidateLockDigest !== null && !/^[a-f0-9]{64}$/.test(input.candidateLockDigest) ? ["candidate lock digest must be sha256"] : []),
  ];
  return {
    status: failures.length === 0 ? "ready-for-speculative-plan" : "invalid",
    engine,
    version,
    "baseline-fresh": input.baselineFresh,
    "candidate-lock-digest": input.candidateLockDigest,
    diagnostics: failures,
    "apply-authority": false,
  };
}

export function policyPlaygroundResult(input: Readonly<{ kind: "opa" | "sentinel"; source: string; plan: unknown }>): Record<string, unknown> {
  const source = input.source.trim();
  const planDigest = inputDigest(input.plan);
  const diagnostics: string[] = [];
  if (source === "") diagnostics.push("policy source is required");
  if (source.length > 256 * 1024) diagnostics.push("policy source exceeds the 256 KiB limit");
  if (input.kind === "opa" && !/package\s+[A-Za-z0-9_.-]+/.test(source)) diagnostics.push("OPA source must declare a package");
  if (input.kind === "sentinel" && !/\bmain\s*=/.test(source)) diagnostics.push("Sentinel source must declare main");
  return {
    status: diagnostics.length === 0 ? "review-only" : "invalid",
    kind: input.kind,
    "policy-digest": inputDigest(source),
    "plan-digest": planDigest,
    diagnostics,
    "apply-authority": false,
  };
}
