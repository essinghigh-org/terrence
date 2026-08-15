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
  if (value === null || typeof value !== "object") return {};
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
  const vcsRepo = rawVcsRepo !== null && typeof rawVcsRepo === "object" ? asRecord(rawVcsRepo) : null;
  const rawPermissions = value["permissions"] !== null && typeof value["permissions"] === "object" ? asRecord(value["permissions"]) : {};
  return {
    id: typeof raw["id"] === "string" ? raw["id"] : "",
    name: typeof value["name"] === "string" ? value["name"] : "",
    namespace: typeof value["namespace"] === "string" ? value["namespace"] : "",
    provider: typeof value["provider"] === "string" ? value["provider"] : "",
    description: typeof value["description"] === "string" ? value["description"] : null,
    status: typeof value["status"] === "string" ? value["status"] : "pending",
    publishingMechanism: value["publishing-mechanism"] === "vcs" ? "vcs" : "manual",
    publishingWorkflow: value["publishing-workflow"] === "tag" || value["publishing-workflow"] === "branch"
      ? value["publishing-workflow"]
      : null,
    versions: rawVersions.flatMap((entry): RegistryModule["versions"][number][] => {
      if (entry === null || typeof entry !== "object") return [];
      const version = asRecord(entry);
      return typeof version["version"] === "string" ? [{
        version: version["version"],
        status: typeof version["status"] === "string" ? version["status"] : "pending",
        deprecated: version["deprecated"] === true,
        revoked: version["revoked"] === true,
      }] : [];
    }),
    vcsRepo: vcsRepo === null ? null : {
      identifier: typeof vcsRepo["identifier"] === "string" ? vcsRepo["identifier"] : null,
      displayIdentifier: typeof vcsRepo["display-identifier"] === "string" ? vcsRepo["display-identifier"] : null,
      repositoryUrl: typeof vcsRepo["repository-url"] === "string" ? vcsRepo["repository-url"] : null,
      branch: typeof vcsRepo["branch"] === "string" && vcsRepo["branch"] !== "" ? vcsRepo["branch"] : null,
      sourceDirectory: typeof vcsRepo["source-directory"] === "string" ? vcsRepo["source-directory"] : null,
      tagPrefix: typeof vcsRepo["tag-prefix"] === "string" ? vcsRepo["tag-prefix"] : null,
    },
    lastSuccessfulSyncAt: typeof value["last-successful-sync-at"] === "string" ? value["last-successful-sync-at"] : null,
    lastSyncAttemptAt: typeof value["last-sync-attempt-at"] === "string" ? value["last-sync-attempt-at"] : null,
    lastSyncError: typeof value["last-sync-error"] === "string" ? value["last-sync-error"] : null,
    createdAt: typeof value["created-at"] === "string" ? value["created-at"] : "",
    updatedAt: typeof value["updated-at"] === "string" ? value["updated-at"] : "",
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
    id: typeof raw["id"] === "string" ? raw["id"] : "",
    version: typeof value["version"] === "string" ? value["version"] : "",
    status: typeof value["status"] === "string" ? value["status"] : "pending",
    deprecated: value["deprecated"] === true,
    revoked: value["revoked"] === true,
    // SAFETY: the typeof-object guard above is the boundary check; metadata is
    // treated as opaque (the backend echoes it back on re-publish).
    metadata: value["metadata"] !== null && typeof value["metadata"] === "object" ? value["metadata"] as RegistryModuleMetadata : null,
    commitSha: typeof value["commit-sha"] === "string" ? value["commit-sha"] : null,
    tag: typeof value["tag"] === "string" ? value["tag"] : null,
    branch: typeof value["branch"] === "string" ? value["branch"] : null,
    sourceDirectory: typeof value["source-directory"] === "string" ? value["source-directory"] : null,
    publishedAt: typeof value["published-at"] === "string" ? value["published-at"] : null,
    ingestError: typeof value["ingest-error"] === "string" ? value["ingest-error"] : null,
  };
}

export function registryModulePath(orgName: string, module: Pick<RegistryModule, "namespace" | "name" | "provider">): string {
  return `/app/${encodeURIComponent(orgName)}/registry/modules/${encodeURIComponent(module.namespace)}/${encodeURIComponent(module.name)}/${encodeURIComponent(module.provider)}`;
}
