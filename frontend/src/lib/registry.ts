import { isRecord, isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";
export type RegistryModuleVersion = Readonly<{
  id: string;
  version: string;
  status: string;
  deprecated: boolean;
  revoked: boolean;
  metadata?: RegistryModuleMetadata | null;
  commitSha?: string | null;
  tag?: string | null;
  branch?: string | null;
  sourceDirectory?: string | null;
  publishedAt?: string | null;
  ingestError?: string | null;
}>;

export type RegistryModuleSection = Readonly<{
  path: string;
  readme: string;
  description: string | null;
  inputs: readonly Readonly<{
    name: string;
    type: string;
    description: string | null;
    defaultValue?: unknown;
    required: boolean;
    sensitive: boolean;
    nullable: boolean;
  }>[];
  outputs: readonly Readonly<{ name: string; description: string | null; sensitive: boolean }>[];
  providers: readonly Readonly<{ name: string; source: string | null; versionConstraint: string | null }>[];
  modules: readonly Readonly<{ name: string; source: string | null; versionConstraint: string | null }>[];
  resources: readonly Readonly<{ name: string; type: string; mode: "managed" | "data" }>[];
}>;

export type RegistryModuleMetadata = RegistryModuleSection & Readonly<{
  submodules: readonly RegistryModuleSection[];
  examples: readonly RegistryModuleSection[];
  diagnostics: readonly string[];
}>;

export type RegistryModule = Readonly<{
  id: string;
  name: string;
  namespace: string;
  provider: string;
  providerSource: string | null;
  description: string | null;
  status: string;
  publishingMechanism: "manual" | "vcs";
  publishingWorkflow: "tag" | "branch" | null;
  versions: readonly Readonly<{ version: string; status: string; deprecated: boolean; revoked: boolean }>[];
  vcsRepo: Readonly<{
    identifier?: string | null;
    displayIdentifier?: string | null;
    repositoryUrl?: string | null;
    branch?: string | null;
    sourceDirectory?: string | null;
    tagPrefix?: string | null;
  }> | null;
  lastSuccessfulSyncAt: string | null;
  lastSyncAttemptAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: Readonly<{ canDelete: boolean; canResync: boolean; canRetry: boolean }>;
}>;

const REGISTRY_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

type ParsedRegistryVersion = Readonly<{
  major: string;
  minor: string;
  patch: string;
  prerelease: readonly string[];
}>;

function parsedRegistryVersion(value: string): ParsedRegistryVersion | null {
  const match = REGISTRY_SEMVER_PATTERN.exec(value);
  if (match === null) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  if (prerelease.some((identifier): boolean =>
    /^\d+$/u.test(identifier) && identifier !== "0" && identifier.startsWith("0"))) return null;
  return {
    major: match[1] ?? "0",
    minor: match[2] ?? "0",
    patch: match[3] ?? "0",
    prerelease,
  };
}

function isNumericIdentifier(value: string): boolean {
  return /^0$|^[1-9]\d*$/u.test(value);
}

function compareNumericIdentifiers(left: string, right: string): number {
  const length = left.length - right.length;
  if (length !== 0) return length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = isNumericIdentifier(leftPart);
    const rightNumeric = isNumericIdentifier(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

/** Compare in ascending semantic-version precedence for browser-side sorting. */
export function compareRegistryVersions(left: string, right: string): number {
  const leftParsed = parsedRegistryVersion(left);
  const rightParsed = parsedRegistryVersion(right);
  if (leftParsed === null || rightParsed === null) {
    if (leftParsed !== null) return 1;
    if (rightParsed !== null) return -1;
    return left.localeCompare(right);
  }
  const major = compareNumericIdentifiers(leftParsed.major, rightParsed.major);
  if (major !== 0) return major;
  const minor = compareNumericIdentifiers(leftParsed.minor, rightParsed.minor);
  if (minor !== 0) return minor;
  const patch = compareNumericIdentifiers(leftParsed.patch, rightParsed.patch);
  if (patch !== 0) return patch;
  const prerelease = comparePrerelease(leftParsed.prerelease, rightParsed.prerelease);
  if (prerelease !== 0) return prerelease;
  return left.localeCompare(right);
}

export function highestUsableRegistryVersion<T extends Readonly<{ version: string; status: string; revoked: boolean }>>(
  versions: readonly T[],
): T | undefined {
  return [...versions]
    .filter((version): boolean => version.status === "ok" && !version.revoked)
    .sort((left, right): number => compareRegistryVersions(right.version, left.version))[0];
}

/** View an unknown value as a record, or {} when it is not an object. */
function asRecord(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  // SAFETY: the typeof-object guard is the boundary check; callers only read
  // string-typed fields and validate each with typeof afterwards.
  return value;
}

function attributes(resource: unknown): JsonObject {
  return asRecord(asRecord(resource)["attributes"]);
}

export function registryModuleFromResource(resource: unknown): RegistryModule {
  const raw = asRecord(resource);
  const value = attributes(resource);
  const rawVersions = Array.isArray(value["version-statuses"]) ? value["version-statuses"] : [];
  const rawVcsRepo = value["vcs-repo"];
  const vcsRepo = isRecord(rawVcsRepo) ? asRecord(rawVcsRepo) : null;
  const rawPermissions = isRecord(value["permissions"]) ? asRecord(value["permissions"]) : {};
  return {
    id: isString(raw["id"]) ? raw["id"] : "",
    name: isString(value["name"]) ? value["name"] : "",
    namespace: isString(value["namespace"]) ? value["namespace"] : "",
    provider: isString(value["provider"]) ? value["provider"] : "",
    providerSource: isString(value["provider-source"]) ? value["provider-source"] : null,
    description: isString(value["description"]) ? value["description"] : null,
    status: isString(value["status"]) ? value["status"] : "pending",
    publishingMechanism: value["publishing-mechanism"] === "vcs" ? "vcs" : "manual",
    publishingWorkflow: value["publishing-workflow"] === "tag" || value["publishing-workflow"] === "branch"
      ? value["publishing-workflow"]
      : null,
    versions: rawVersions.flatMap((entry): RegistryModule["versions"][number][] => {
      if (!isRecord(entry)) return [];
      const version = asRecord(entry);
      return isString(version["version"]) ? [{
        version: version["version"],
        status: isString(version["status"]) ? version["status"] : "pending",
        deprecated: version["deprecated"] === true,
        revoked: version["revoked"] === true,
      }] : [];
    }).sort((left, right): number => compareRegistryVersions(right.version, left.version)),
    vcsRepo: vcsRepo === null ? null : {
      identifier: isString(vcsRepo["identifier"]) ? vcsRepo["identifier"] : null,
      displayIdentifier: isString(vcsRepo["display-identifier"]) ? vcsRepo["display-identifier"] : null,
      repositoryUrl: isString(vcsRepo["repository-url"]) ? vcsRepo["repository-url"] : null,
      branch: isString(vcsRepo["branch"]) && vcsRepo["branch"] !== "" ? vcsRepo["branch"] : null,
      sourceDirectory: isString(vcsRepo["source-directory"]) ? vcsRepo["source-directory"] : null,
      tagPrefix: isString(vcsRepo["tag-prefix"]) ? vcsRepo["tag-prefix"] : null,
    },
    lastSuccessfulSyncAt: isString(value["last-successful-sync-at"]) ? value["last-successful-sync-at"] : null,
    lastSyncAttemptAt: isString(value["last-sync-attempt-at"]) ? value["last-sync-attempt-at"] : null,
    lastSyncError: isString(value["last-sync-error"]) ? value["last-sync-error"] : null,
    createdAt: isString(value["created-at"]) ? value["created-at"] : "",
    updatedAt: isString(value["updated-at"]) ? value["updated-at"] : "",
    permissions: {
      canDelete: rawPermissions["can-delete"] === true,
      canResync: rawPermissions["can-resync"] === true,
      canRetry: rawPermissions["can-retry"] === true,
    },
  };
}

/** Decode a registry metadata section from the JSON:API metadata payload. */
function sectionFrom(value: unknown): RegistryModuleSection | null {
  if (!isRecord(value)) return null;
  const stringField = (key: string): string | null => (isString(value[key]) ? value[key] : null);
  const inputFrom = (entry: unknown): RegistryModuleSection["inputs"][number][] => {
    if (!isRecord(entry)) return [];
    const name = isString(entry["name"]) ? entry["name"] : "";
    const type = isString(entry["type"]) ? entry["type"] : "";
    const description = isString(entry["description"]) ? entry["description"] : null;
    if (name === "" || type === "") return [];
    return [{
      name,
      type,
      description,
      defaultValue: entry["default-value"],
      required: entry["required"] === true,
      sensitive: entry["sensitive"] === true,
      nullable: entry["nullable"] === true,
    }];
  };
  const outputFrom = (entry: unknown): RegistryModuleSection["outputs"][number][] => {
    if (!isRecord(entry)) return [];
    const name = isString(entry["name"]) ? entry["name"] : "";
    if (name === "") return [];
    return [{
      name,
      description: isString(entry["description"]) ? entry["description"] : null,
      sensitive: entry["sensitive"] === true,
    }];
  };
  const referenceFrom = (entry: unknown): RegistryModuleSection["providers"][number][] => {
    if (!isRecord(entry)) return [];
    const name = isString(entry["name"]) ? entry["name"] : "";
    if (name === "") return [];
    return [{
      name,
      source: isString(entry["source"]) ? entry["source"] : null,
      versionConstraint: isString(entry["version-constraint"]) ? entry["version-constraint"] : null,
    }];
  };
  const resourceFrom = (entry: unknown): RegistryModuleSection["resources"][number][] => {
    if (!isRecord(entry)) return [];
    const name = isString(entry["name"]) ? entry["name"] : "";
    const type = isString(entry["type"]) ? entry["type"] : "";
    if (name === "" || type === "") return [];
    return [{
      name,
      type,
      mode: entry["mode"] === "data" ? "data" : "managed",
    }];
  };
  return {
    path: stringField("path") ?? "",
    readme: stringField("readme") ?? "",
    description: stringField("description"),
    inputs: Array.isArray(value["inputs"]) ? value["inputs"].flatMap(inputFrom) : [],
    outputs: Array.isArray(value["outputs"]) ? value["outputs"].flatMap(outputFrom) : [],
    providers: Array.isArray(value["providers"]) ? value["providers"].flatMap(referenceFrom) : [],
    modules: Array.isArray(value["modules"]) ? value["modules"].flatMap(referenceFrom) : [],
    resources: Array.isArray(value["resources"]) ? value["resources"].flatMap(resourceFrom) : [],
  };
}

/** Decode the full registry module metadata payload (section + submodules). */
function metadataFrom(value: unknown): RegistryModuleMetadata | null {
  if (!isRecord(value)) return null;
  const section = sectionFrom(value);
  if (section === null) return null;
  const diagnostics = Array.isArray(value["diagnostics"])
    ? value["diagnostics"].flatMap((entry): string[] => (isString(entry) ? [entry] : []))
    : [];
  return {
    ...section,
    submodules: Array.isArray(value["submodules"]) ? value["submodules"].flatMap((entry): RegistryModuleSection[] => {
      const parsed = sectionFrom(entry);
      return parsed === null ? [] : [parsed];
    }) : [],
    examples: Array.isArray(value["examples"]) ? value["examples"].flatMap((entry): RegistryModuleSection[] => {
      const parsed = sectionFrom(entry);
      return parsed === null ? [] : [parsed];
    }) : [],
    diagnostics,
  };
}

export function registryModuleVersionFromResource(resource: unknown): RegistryModuleVersion {
  const raw = asRecord(resource);
  const value = attributes(resource);
  return {
    id: isString(raw["id"]) ? raw["id"] : "",
    version: isString(value["version"]) ? value["version"] : "",
    status: isString(value["status"]) ? value["status"] : "pending",
    deprecated: value["deprecated"] === true,
    revoked: value["revoked"] === true,
    // SAFETY: the metadata payload is decoded field-by-field by metadataFrom;
    // unparsable values degrade to null.
    metadata: metadataFrom(value["metadata"]),
    commitSha: isString(value["commit-sha"]) ? value["commit-sha"] : null,
    tag: isString(value["tag"]) ? value["tag"] : null,
    branch: isString(value["branch"]) ? value["branch"] : null,
    sourceDirectory: isString(value["source-directory"]) ? value["source-directory"] : null,
    publishedAt: isString(value["published-at"]) ? value["published-at"] : null,
    ingestError: isString(value["ingest-error"]) ? value["ingest-error"] : null,
  };
}

export function registryModulePath(orgName: string, module: Pick<RegistryModule, "namespace" | "name" | "provider">): string {
  return `/app/${encodeURIComponent(orgName)}/registry/modules/${encodeURIComponent(module.namespace)}/${encodeURIComponent(module.name)}/${encodeURIComponent(module.provider)}`;
}