import { isRecord, isString } from "../lib/type-guards";
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

/** View an unknown value as a record, or {} when it is not an object. */
function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  // SAFETY: the typeof-object guard is the boundary check; callers only read
  // string-typed fields and validate each with typeof afterwards.
  return value as Record<string, unknown>;
}

function attributes(resource: unknown): Record<string, unknown> {
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
    }),
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

export function registryModuleVersionFromResource(resource: unknown): RegistryModuleVersion {
  const raw = asRecord(resource);
  const value = attributes(resource);
  return {
    id: isString(raw["id"]) ? raw["id"] : "",
    version: isString(value["version"]) ? value["version"] : "",
    status: isString(value["status"]) ? value["status"] : "pending",
    deprecated: value["deprecated"] === true,
    revoked: value["revoked"] === true,
    // SAFETY: the typeof-object guard above is the boundary check; metadata is
    // treated as opaque (the backend echoes it back on re-publish).
    metadata: isRecord(value["metadata"]) ? value["metadata"] as RegistryModuleMetadata : null,
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