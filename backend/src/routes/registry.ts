import { Elysia } from "elysia";
import { db } from "../db";
import {
  configurationVersions,
  noCodeModules,
  noCodeVariableOptions,
  organizations,
  githubAppInstallations,
  oauthClients,
  oauthTokens,
  registryGpgKeys,
  registryModules,
  registryModuleVersions,
  moduleTestConfigurations,
  moduleTestConfigurationVersions,
  moduleTestResults,
  moduleTestRuns,
  testVariables,
  registryProviders,
  registryProviderPlatforms,
  registryProviderVersions,
  workspaces,
  type users,
} from "../db/schema";
import type { SQL } from "drizzle-orm";
import { eq, and, asc, count, desc, inArray, isNull, like, or, ne, sql } from "drizzle-orm";
import {
  checkOrganizationPermission,
  checkOrgPermission,
  checkRegistryReadPermission,
  checkRunRegistryRead,
  pageRequest,
  pagination,
  type DeepReadonly,
} from "../lib/utils";
import { join } from "path";
import { mkdir, rm, writeFile } from "fs/promises";
import { authPlugin } from "../auth";
import { signedApiURL, validSignedApiURL } from "../lib/utils";
import {
  ingestModuleArchive,
  MAX_MODULE_ARCHIVE_BYTES,
} from "../lib/registry-module-archive";
import { inspectRegistryModule } from "../lib/registry-module-metadata";
import { synchronizeRegistryModule } from "../lib/registry-module-sync";
import {
  moduleTestConfiguration,
  moduleTestResource,
  readModuleTestResult,
  runModuleTest,
  type ModuleTestEnvironmentFactory,
} from "../lib/module-tests";
import { cachedOrgByName } from "../lib/cached-lookups";
import { isUniqueConstraintError } from "../lib/validation";
import { cancelDurableJobs, enqueueDurableJob } from "../lib/durable-jobs";
import { moduleTestIdentityEnvironment, revokeWorkloadIdentityTokens, type CredentialProvider } from "../lib/workload-identity";

const CV_STORAGE_DIR = join(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "cv");
const REGISTRY_MODULE_STORAGE_DIR = join(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "modules");
type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

async function moduleTestEnvironmentFactory(moduleId: string, moduleName: string, orgId: string, runId: string): Promise<ModuleTestEnvironmentFactory> {
  const [configuration, organization] = await Promise.all([
    db.query.moduleTestConfigurations.findFirst({ where: eq(moduleTestConfigurations.moduleId, moduleId) }),
    db.query.organizations.findFirst({ where: eq(organizations.id, orgId) }),
  ]);
  return async (stagingDirectory: string): Promise<Readonly<Record<string, string>>> => {
    if (configuration?.oidcEnabled !== true || configuration.oidcProvider === null || organization === undefined || !["aws", "gcp", "azure", "vault"].includes(configuration.oidcProvider)) return {};
    const values = configuration.oidcConfiguration !== null && typeof configuration.oidcConfiguration === "object" ? configuration.oidcConfiguration : {};
    const identity = await moduleTestIdentityEnvironment({
      organizationId: organization.id,
      organizationName: organization.name,
      moduleName,
      runId,
      ttlSeconds: organization.moduleTestTokenTtl,
    }, { provider: configuration.oidcProvider as CredentialProvider, values }, stagingDirectory);
    return identity.environment;
  };
}

function registryNotFound(set: SetObj): { errors: { status: string; title: string }[] } {
  (set as { status: number }).status = 404;
  return { errors: [{ status: "404", title: "Not Found" }] };
}

/** Resolve a registry module by its namespace/name/provider triple and verify
 * the caller may read it, so protocol endpoints share one lookup+guard path. */
async function findRegistryModule(
  namespace: string,
  name: string,
  provider: string,
  userId: string | undefined,
  tokenOrgId: string | null | undefined,
  run: { runId: string; workspaceId: string; organizationId: string } | null | undefined,
): Promise<ModItem | undefined> {
  const mod = await db.query.registryModules.findFirst({
    where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)),
  });
  if (mod === undefined) return undefined;
  if (!checkRunRegistryRead(run, mod.orgId) && !(await checkRegistryReadPermission(userId, mod.orgId, "modules", tokenOrgId))) return undefined;
  return mod;
}

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: DeepReadonly<typeof users.$inferSelect> | null;
  readonly orgId?: string | null;
  readonly teamId?: string | null;
  readonly run?: { runId: string; workspaceId: string; organizationId: string } | null;
  readonly request: Readonly<{
    readonly url: string;
    readonly headers: Readonly<{ get: (name: string) => string | null }>;
    readonly arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
  readonly set: SetObj;
}>;

type ModItem = DeepReadonly<typeof registryModules.$inferSelect>;
type ModVerItem = DeepReadonly<typeof registryModuleVersions.$inferSelect>;
type NoCodeItem = DeepReadonly<typeof noCodeModules.$inferSelect>;
type NoCodeVariableOptionItem = DeepReadonly<typeof noCodeVariableOptions.$inferSelect>;
type OrgItem = DeepReadonly<typeof organizations.$inferSelect>;
type ProvItem = DeepReadonly<typeof registryProviders.$inferSelect>;

// go-tfe RegistryProvider carries a pointer `organization` relationship;
// omitting it makes the provider nil-deref v.Organization.Name.
function registryProviderResource(value: ProvItem, orgName: string): Record<string, unknown> {
  return {
    id: value.id,
    type: "registry-providers",
    attributes: {
      namespace: value.namespace,
      name: value.type,
      "registry-name": value.registryName,
      "created-at": new Date(value.createdAt).toISOString(),
    },
    relationships: { organization: { data: { id: orgName, type: "organizations" } } },
  };
}
type ProvVerItem = DeepReadonly<typeof registryProviderVersions.$inferSelect>;
type PlatItem = DeepReadonly<typeof registryProviderPlatforms.$inferSelect>;

function registryProviderVersionResource(version: ProvVerItem): Record<string, unknown> {
  return { id: version.id, type: "registry-provider-versions", attributes: { version: version.version, "key-id": version.keyId, protocols: version.protocols, "shasums-url": version.shasumsUrl, "shasums-signature-url": version.shasumsSignatureUrl, "created-at": new Date(version.createdAt).toISOString() } };
}

function registryProviderPlatformResource(platform: PlatItem): Record<string, unknown> {
  return { id: platform.id, type: "registry-provider-platforms", attributes: { os: platform.os, arch: platform.arch, filename: platform.filename, "download-url": platform.downloadUrl, shasum: platform.shasum } };
}

function validModuleVersion(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function registryModuleVersionResource(version: ModVerItem): Record<string, unknown> {
  return {
    id: version.id,
    type: "registry-module-versions",
    attributes: {
      version: version.version,
      status: version.status,
      source: version.source,
      deprecated: version.isDeprecated === true,
      revoked: version.isRevoked === true,
      "key-id": version.keyId,
      "commit-sha": version.commitSha,
      tag: version.vcsTag,
      branch: version.vcsBranch,
      "source-directory": version.sourceDirectory,
      metadata: version.metadata,
      "ingest-error": version.ingestError,
      "published-at": version.publishedAt === null ? null : new Date(version.publishedAt).toISOString(),
      "created-at": new Date(version.createdAt).toISOString(),
      "updated-at": new Date(version.updatedAt ?? version.createdAt).toISOString(),
    },
    relationships: {
      "registry-module": { data: { id: version.moduleId, type: "registry-modules" } },
    },
    links: version.status === "pending" ? { upload: `/api/v2/registry-module-versions/${version.id}/upload` } : {},
  };
}

// RegistryModule carry a pointer `organization` relationship plus attributes
// the provider's model dereferences (status, publishing-mechanism, no-code);
// omitting any makes the provider nil-deref or return inconsistently.
async function registryModuleResource(
  m: ModItem,
  orgName: string,
  canManage: boolean,
  suppliedVersions?: readonly ModVerItem[],
): Promise<Record<string, unknown>> {
  const versions = suppliedVersions ?? await db.query.registryModuleVersions.findMany({
    where: eq(registryModuleVersions.moduleId, m.id),
    orderBy: [desc(registryModuleVersions.createdAt)],
  });
  return {
    id: m.id,
    type: "registry-modules",
    attributes: {
      name: m.name,
      provider: m.provider,
      namespace: m.namespace,
      "registry-name": "private",
      "no-code": false,
      description: m.description,
      "publishing-mechanism": m.publishingMechanism,
      "publishing-workflow": m.publishingWorkflow,
      status: m.status,
      "version-statuses": versions.map((version) => ({
        version: version.version,
        status: version.status,
        deprecated: version.isDeprecated === true,
        revoked: version.isRevoked === true,
      })),
      "vcs-repo": m.publishingMechanism === "vcs" ? {
        identifier: m.repositoryIdentifier,
        "display-identifier": m.repositoryDisplayIdentifier,
        "repository-url": m.repositoryUrl,
        branch: m.branch ?? "",
        "source-directory": m.sourceDirectory,
        "tag-prefix": m.tagPrefix,
        ...(m.vcsConnectionType === "github-app" ? { "github-app-installation-id": m.vcsConnectionId } : {}),
        ...(m.vcsConnectionType === "oauth-token" ? { "oauth-token-id": m.vcsConnectionId } : {}),
      } : null,
      "last-successful-sync-at": m.lastSuccessfulSyncAt === null ? null : new Date(m.lastSuccessfulSyncAt).toISOString(),
      "last-sync-attempt-at": m.lastSyncAttemptAt === null ? null : new Date(m.lastSyncAttemptAt).toISOString(),
      "last-sync-error": m.lastSyncError,
      "created-at": new Date(m.createdAt).toISOString(),
      "updated-at": new Date(m.updatedAt ?? m.createdAt).toISOString(),
      permissions: {
        "can-delete": canManage,
        "can-resync": canManage && m.publishingMechanism === "vcs",
        "can-retry": canManage,
      },
    },
    relationships: {
      organization: { data: { id: orgName, type: "organizations" } },
      versions: { data: [] },
      tags: { data: [] },
    },
    links: {
      self: `/api/v2/organizations/${encodeURIComponent(orgName)}/registry-modules/private/${encodeURIComponent(m.namespace)}/${encodeURIComponent(m.name)}/${encodeURIComponent(m.provider)}`,
    },
  };
}

async function moduleTestTarget(
  moduleId: string,
  versionReference: string,
): Promise<Readonly<{ mod: ModItem; version: ModVerItem }> | undefined> {
  const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
  if (mod === undefined) return undefined;
  const version = await db.query.registryModuleVersions.findFirst({
    where: and(
      eq(registryModuleVersions.moduleId, moduleId),
      or(
        eq(registryModuleVersions.version, versionReference),
        eq(registryModuleVersions.id, versionReference),
      ),
    ),
  });
  return version === undefined ? undefined : { mod, version };
}

async function availableModuleVersions(moduleId: string): Promise<ModVerItem[]> {
  const versions = await db.query.registryModuleVersions.findMany({
    where: eq(registryModuleVersions.moduleId, moduleId),
    orderBy: [desc(registryModuleVersions.createdAt)],
  });
  const available = await Promise.all(versions.map(async (version): Promise<boolean> =>
    version.status === "ok"
    && version.isRevoked !== true
    && version.archivePath !== null
    && await Bun.file(version.archivePath).exists()));
  return versions
    .filter((_, index): boolean => available[index] === true)
    .sort((left, right): number => Bun.semver.order(right.version, left.version) || right.version.localeCompare(left.version));
}

async function deleteRegistryModuleAndArchives(moduleId: string): Promise<void> {
  const versions = await db.query.registryModuleVersions.findMany({
    where: eq(registryModuleVersions.moduleId, moduleId),
  });
  await db.delete(registryModules).where(eq(registryModules.id, moduleId));
  await Promise.allSettled(versions.flatMap((version): Promise<void>[] =>
    version.archivePath === null ? [] : [rm(version.archivePath, { force: true })]));
}

async function checkRegistryManagementRead(
  userId: string | undefined,
  orgId: string,
  kind: "modules" | "providers",
  tokenOrgId: string | null | undefined,
  teamId: string | null | undefined,
): Promise<boolean> {
  return await checkRegistryReadPermission(userId, orgId, kind, tokenOrgId)
    || await checkOrganizationPermission(
      orgId,
      userId,
      tokenOrgId,
      teamId,
      kind === "modules" ? "manage-modules" : "manage-providers",
    );
}

async function uploadedBytes(body: unknown, request: ParamCtx["request"]): Promise<Uint8Array> {
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body !== undefined) return new TextEncoder().encode(JSON.stringify(body));
  return new Uint8Array(await request.arrayBuffer());
}

async function createRegistryModuleVersion(
  mod: ModItem,
  attributes: Readonly<Record<string, unknown>>,
  set: SetObj,
): Promise<unknown> {
  const version = typeof attributes.version === "string" ? attributes.version.replace(/^v/, "") : "";
  if (!validModuleVersion(version)) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version must be a semantic module version" }] };
  }
  const duplicate = await db.query.registryModuleVersions.findFirst({
    where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)),
  });
  if (duplicate !== undefined) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Version ${version} already exists` }] };
  }
  if (mod.publishingMechanism === "vcs") {
    if (mod.publishingWorkflow !== "branch") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Tag-based module versions are created by matching VCS tags" }] };
    }
    try {
      await synchronizeRegistryModule(mod, version);
      const created = await db.query.registryModuleVersions.findFirst({
        where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)),
      });
      if (created === undefined) throw new Error("The branch revision did not produce a module version");
      (set as { status: number }).status = 201;
      return { data: registryModuleVersionResource(created) };
    } catch (error: unknown) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error instanceof Error ? error.message : "Branch publication failed" }] };
    }
  }

  const rawKeyId = attributes["key-id"];
  if (rawKeyId !== undefined && (typeof rawKeyId !== "string" || rawKeyId === "")) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "key-id must identify a GPG key" }] };
  }
  const keyId = typeof rawKeyId === "string" ? rawKeyId.toUpperCase() : null;
  if (keyId !== null && await registrySigningKey(mod.orgId, mod.namespace, keyId) === undefined) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "key-id must identify a GPG key in the module namespace" }] };
  }
  const commitSha = typeof attributes["commit-sha"] === "string" && attributes["commit-sha"] !== ""
    ? attributes["commit-sha"]
    : null;
  const now = Date.now();
  const id = `modver-${crypto.randomUUID()}`;
  const created: typeof registryModuleVersions.$inferInsert = {
    id,
    moduleId: mod.id,
    version,
    status: "pending",
    source: "tfe-api",
    keyId,
    commitSha,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(registryModuleVersions).values(created);
  } catch (error: unknown) {
    if (!isUniqueConstraintError(error)) throw error;
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Version ${version} already exists` }] };
  }
  (set as { status: number }).status = 201;
  const row = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, id) });
  if (row === undefined) throw new Error("Created registry module version could not be loaded");
  return { data: registryModuleVersionResource(row) };
}

async function registrySigningKey(
  orgId: string,
  namespace: string,
  keyId: string | null,
): Promise<DeepReadonly<typeof registryGpgKeys.$inferSelect> | undefined> {
  if (keyId === null) return undefined;
  return db.query.registryGpgKeys.findFirst({
    where: and(
      eq(registryGpgKeys.orgId, orgId),
      eq(registryGpgKeys.namespace, namespace),
      eq(registryGpgKeys.keyId, keyId),
    ),
  });
}

function matchesMirrorHostname(provider: ProvItem, hostname: string, requestUrl: string): boolean {
  const origin = provider.registryName === "public"
    ? "registry.terraform.io"
    : new URL(process.env.PUBLIC_URL ?? requestUrl).host;
  return hostname === origin;
}

type NoCodeInput = Readonly<{
  moduleId: string | undefined;
  versionPin: string | undefined;
  enabled: boolean | undefined;
  variableOptions: readonly VariableOptionInput[] | undefined;
}>;

type VariableOptionInput = Readonly<{
  id: string | undefined;
  variableName: string;
  variableType: string;
  options: readonly unknown[];
}>;

type TerraformType =
  | Readonly<{ kind: "any" | "string" | "number" | "bool"; constraint: string }>
  | Readonly<{ kind: "list" | "set" | "map" | "optional"; constraint: string; item: TerraformType }>
  | Readonly<{ kind: "tuple"; constraint: string; items: readonly TerraformType[] }>
  | Readonly<{ kind: "object"; constraint: string; fields: Readonly<Record<string, TerraformType>> }>;

function parseTerraformType(source: string): TerraformType | undefined {
  let position = 0;
  const skipSpace = (): void => {
    while (/\s/.test(source[position] ?? "")) position += 1;
  };
  const take = (value: string): boolean => {
    skipSpace();
    if (!source.startsWith(value, position)) return false;
    position += value.length;
    return true;
  };
  const identifier = (): string | undefined => {
    skipSpace();
    const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(position));
    if (match === null) return undefined;
    position += match[0].length;
    return match[0];
  };
  const parse = (): TerraformType | undefined => {
    const rawName = identifier();
    if (rawName === undefined) return undefined;
    const name = rawName.toLowerCase();
    if (name === "any" || name === "dynamic") return { kind: "any", constraint: "any" };
    if (name === "string") return { kind: "string", constraint: "string" };
    if (name === "number" || name === "integer" || name === "float") return { kind: "number", constraint: "number" };
    if (name === "bool" || name === "boolean") return { kind: "bool", constraint: "bool" };
    if (name === "array") return { kind: "list", constraint: "list(any)", item: { kind: "any", constraint: "any" } };

    if (!take("(")) {
      if (name === "list" || name === "set" || name === "map") {
        return { kind: name, constraint: `${name}(any)`, item: { kind: "any", constraint: "any" } };
      }
      return undefined;
    }
    if (name === "list" || name === "set" || name === "map" || name === "optional") {
      const item = parse();
      if (item === undefined || !take(")")) return undefined;
      return { kind: name, constraint: `${name}(${item.constraint})`, item };
    }
    if (name === "tuple") {
      if (!take("[")) return undefined;
      const items: TerraformType[] = [];
      skipSpace();
      while ((source[position] ?? "") !== "]") {
        const item = parse();
        if (item === undefined) return undefined;
        items.push(item);
        skipSpace();
        if ((source[position] ?? "") === "]") break;
        if (!take(",")) return undefined;
      }
      if (!take("]") || !take(")")) return undefined;
      return { kind: "tuple", constraint: `tuple([${items.map((item): string => item.constraint).join(", ")}])`, items };
    }
    if (name === "object") {
      if (!take("{")) return undefined;
      const fields: Record<string, TerraformType> = {};
      skipSpace();
      while ((source[position] ?? "") !== "}") {
        const fieldName = identifier();
        if (fieldName === undefined || fields[fieldName] !== undefined || (!take("=") && !take(":"))) return undefined;
        const fieldType = parse();
        if (fieldType === undefined) return undefined;
        fields[fieldName] = fieldType;
        skipSpace();
        if ((source[position] ?? "") === "}") break;
        if (!take(",")) return undefined;
      }
      if (!take("}") || !take(")")) return undefined;
      const entries = Object.entries(fields).map(([key, value]): string => `${key} = ${value.constraint}`);
      return { kind: "object", constraint: `object({ ${entries.join(", ")} })`, fields };
    }
    return undefined;
  };
  const parsed = parse();
  skipSpace();
  return parsed !== undefined && position === source.length ? parsed : undefined;
}

function matchesTerraformType(value: unknown, type: TerraformType): boolean {
  if (type.kind === "any") return true;
  if (type.kind === "string") return typeof value === "string";
  if (type.kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (type.kind === "bool") return typeof value === "boolean";
  if (type.kind === "list" || type.kind === "set") {
    return Array.isArray(value) && value.every((entry: unknown): boolean => matchesTerraformType(entry, type.item));
  }
  if (type.kind === "map") {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.values(value).every((entry: unknown): boolean => matchesTerraformType(entry, type.item));
  }
  if (type.kind === "optional") return value === null || matchesTerraformType(value, type.item);
  if (type.kind === "tuple") {
    return Array.isArray(value)
      && value.length === type.items.length
      && value.every((entry: unknown, index: number): boolean => {
        const item = type.items[index];
        return item !== undefined && matchesTerraformType(entry, item);
      });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const objectType = type as Extract<TerraformType, Readonly<{ kind: "object" }>>;
  const record = value as Record<string, unknown>;
  return Object.entries(objectType.fields).every(([key, fieldType]): boolean => {
    const optional = fieldType.kind === "optional";
    return (optional && record[key] === undefined) || matchesTerraformType(record[key], fieldType);
  });
}

function variableOptionsInput(raw: unknown): readonly VariableOptionInput[] | Readonly<{ error: string }> {
  if (!Array.isArray(raw)) return { error: "variable-options.data must be an array" };
  const parsed: VariableOptionInput[] = [];
  const names = new Set<string>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return { error: "variable-options entries must be objects" };
    const item = entry as Record<string, unknown>;
    if (item.type !== "variable-options") return { error: "variable-options type must be variable-options" };
    const id = item.id;
    if (id !== undefined && (typeof id !== "string" || id === "")) return { error: "variable-options id must be a non-empty string" };
    const attributes = item.attributes;
    if (attributes === null || typeof attributes !== "object") return { error: "variable-options attributes are required" };
    const values = attributes as Record<string, unknown>;
    const variableName = values["variable-name"];
    const variableType = values["variable-type"];
    const options = values.options;
    if (typeof variableName !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(variableName)) {
      return { error: "variable-name must be a valid Terraform variable name" };
    }
    if (names.has(variableName)) return { error: `variable-options contains duplicate variable-name ${variableName}` };
    names.add(variableName);
    if (typeof variableType !== "string") return { error: `variable-type is required for ${variableName}` };
    const terraformType = parseTerraformType(variableType.trim());
    if (terraformType === undefined) return { error: `variable-type is invalid for ${variableName}` };
    if (!Array.isArray(options)) return { error: `options must be an array for ${variableName}` };
    if (!options.every((option: unknown): boolean => matchesTerraformType(option, terraformType))) {
      return { error: `options must match variable-type for ${variableName}` };
    }
    parsed.push({
      id: typeof id === "string" ? id : undefined,
      variableName,
      variableType: variableType.trim(),
      options,
    });
  }
  return parsed;
}

function noCodeInput(body: unknown, requireModule: boolean): NoCodeInput | Readonly<{ error: string }> {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const rawData = payload.data;
  if (rawData === null || typeof rawData !== "object") return { error: "data is required" };
  const data = rawData as Record<string, unknown>;
  if (data.type !== "no-code-modules") return { error: "data.type must be no-code-modules" };

  const rawAttributes = data.attributes;
  if (rawAttributes !== undefined && (rawAttributes === null || typeof rawAttributes !== "object")) {
    return { error: "data.attributes must be an object" };
  }
  const attributes = (rawAttributes ?? {}) as Record<string, unknown>;
  const enabled = attributes.enabled;
  const versionPin = attributes["version-pin"];
  if (enabled !== undefined && typeof enabled !== "boolean") return { error: "enabled must be a boolean" };
  if (versionPin !== undefined && (typeof versionPin !== "string" || versionPin.trim() === "")) {
    return { error: "version-pin must be a non-empty string" };
  }

  const rawRelationships = data.relationships;
  if (rawRelationships !== undefined && (rawRelationships === null || typeof rawRelationships !== "object")) {
    return { error: "data.relationships must be an object" };
  }
  const relationships = typeof rawRelationships === "object"
    ? rawRelationships as Record<string, unknown>
    : {};
  const rawRegistryModule = relationships["registry-module"];
  let moduleId: string | undefined;
  if (rawRegistryModule !== undefined) {
    const registryModule = rawRegistryModule !== null && typeof rawRegistryModule === "object"
      ? rawRegistryModule as Record<string, unknown>
      : {};
    const rawRegistryData = registryModule.data;
    const registryData = rawRegistryData !== null && typeof rawRegistryData === "object"
      ? rawRegistryData as Record<string, unknown>
      : {};
    if (
      (registryData.type !== "registry-module" && registryData.type !== "registry-modules")
      || typeof registryData.id !== "string"
      || registryData.id === ""
    ) {
      return { error: "registry-module relationship is invalid" };
    }
    moduleId = registryData.id;
  }
  if (requireModule && moduleId === undefined) return { error: "registry-module relationship is required" };

  const rawVariableOptions = relationships["variable-options"];
  let variableOptions: readonly VariableOptionInput[] | undefined;
  if (rawVariableOptions !== undefined) {
    if (rawVariableOptions === null || typeof rawVariableOptions !== "object") {
      return { error: "variable-options relationship is invalid" };
    }
    const options = variableOptionsInput((rawVariableOptions as Record<string, unknown>).data);
    if ("error" in options) return options;
    variableOptions = options;
  }

  return {
    moduleId,
    versionPin: typeof versionPin === "string" ? versionPin.trim() : undefined,
    enabled: typeof enabled === "boolean" ? enabled : undefined,
    variableOptions,
  };
}

function variableOptionResource(option: NoCodeVariableOptionItem): Record<string, unknown> {
  return {
    id: option.id,
    type: "variable-options",
    attributes: {
      "variable-name": option.variableName,
      "variable-type": option.variableType,
      options: option.options,
    },
    relationships: {
      "no-code-allowed-module": {
        data: { id: option.noCodeModuleId, type: "no-code-allowed-modules" },
      },
    },
  };
}

function noCodeResource(
  noCode: NoCodeItem,
  org: OrgItem,
  mod: ModItem,
  version: ModVerItem,
  options: readonly NoCodeVariableOptionItem[],
): Record<string, unknown> {
  return {
    id: noCode.id,
    type: "no-code-modules",
    attributes: {
      enabled: noCode.enabled,
      "version-pin": version.version,
    },
    relationships: {
      organization: {
        data: { id: org.name, type: "organizations" },
        links: { related: `/api/v2/organizations/${org.name}` },
      },
      "registry-module": {
        data: { id: mod.id, type: "registry-modules" },
        links: { related: `/api/v2/registry-modules/${mod.id}` },
      },
      "variable-options": {
        data: options.map((option): Record<string, string> => ({ id: option.id, type: "variable-options" })),
      },
    },
    links: { self: `/api/v2/no-code-modules/${noCode.id}` },
  };
}

async function replaceVariableOptions(noCodeModuleId: string, options: readonly VariableOptionInput[]): Promise<void> {
  await db.delete(noCodeVariableOptions).where(eq(noCodeVariableOptions.noCodeModuleId, noCodeModuleId));
  if (options.length === 0) return;
  const now = Date.now();
  await db.insert(noCodeVariableOptions).values(options.map((option): typeof noCodeVariableOptions.$inferInsert => ({
    id: `ncvaropt-${crypto.randomUUID()}`,
    noCodeModuleId,
    variableName: option.variableName,
    variableType: option.variableType,
    options: [...option.options],
    createdAt: now,
    updatedAt: now,
  })));
}

async function validateVariableOptionPatch(
  noCodeModuleId: string,
  options: readonly VariableOptionInput[],
): Promise<Readonly<{ error: string }> | undefined> {
  const existing = await db.query.noCodeVariableOptions.findMany({
    where: eq(noCodeVariableOptions.noCodeModuleId, noCodeModuleId),
  });
  const namesById = new Map(existing.map((option): [string, string] => [option.id, option.variableName]));
  for (const option of options) {
    if (option.id !== undefined && !namesById.has(option.id)) {
      return { error: `variable-options ${option.id} does not belong to this no-code module` };
    }
    namesById.set(option.id ?? `new-${crypto.randomUUID()}`, option.variableName);
  }
  const names = [...namesById.values()];
  return new Set(names).size === names.length
    ? undefined
    : { error: "variable-options variable-name values must be unique for this no-code module" };
}

async function patchVariableOptions(noCodeModuleId: string, options: readonly VariableOptionInput[]): Promise<Readonly<{ error: string }> | undefined> {
  for (const option of options) {
    if (option.id === undefined) {
      await db.insert(noCodeVariableOptions).values({
        id: `ncvaropt-${crypto.randomUUID()}`,
        noCodeModuleId,
        variableName: option.variableName,
        variableType: option.variableType,
        options: [...option.options],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      continue;
    }
    const existing = await db.query.noCodeVariableOptions.findFirst({ where: eq(noCodeVariableOptions.id, option.id) });
    if (existing?.noCodeModuleId !== noCodeModuleId) return { error: `variable-options ${option.id} does not belong to this no-code module` };
    await db.update(noCodeVariableOptions).set({
      variableName: option.variableName,
      variableType: option.variableType,
      options: [...option.options],
      updatedAt: Date.now(),
    }).where(eq(noCodeVariableOptions.id, option.id));
  }
  return undefined;
}

function testVariableResource(variable: DeepReadonly<typeof testVariables.$inferSelect>): Record<string, unknown> {
  const raw = variable;
  return {
    id: raw.id,
    type: "vars",
    attributes: {
      key: raw.key,
      value: raw.value,
      description: raw.description ?? "",
      category: raw.category,
      hcl: raw.hcl,
      sensitive: raw.sensitive,
      "version-id": String(raw.updatedAt),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/naming-convention -- Elysia route params preserve API path names.
type TestVarsParams = { org_name?: string | undefined; registry_name?: string | undefined; namespace?: string | undefined; module_name?: string | undefined; provider?: string | undefined; variable_id?: string | undefined };

async function findTestVarsModule(params: TestVarsParams): Promise<DeepReadonly<typeof registryModules.$inferSelect> | undefined> {
  const orgName = params.org_name ?? "";
  const namespace = params.namespace ?? "";
  const moduleName = params.module_name ?? "";
  const provider = params.provider ?? "";
  if (orgName === "" || moduleName === "" || provider === "") return undefined;
  const org = await cachedOrgByName(orgName);
  if (org === undefined) return undefined;
  return db.query.registryModules.findFirst({
    where: and(
      eq(registryModules.orgId, org.id),
      eq(registryModules.namespace, namespace === "" ? orgName : namespace),
      eq(registryModules.name, moduleName),
      eq(registryModules.provider, provider),
    ),
  });
}

async function findTestVariable(params: TestVarsParams): Promise<DeepReadonly<typeof testVariables.$inferSelect> | undefined> {
  const mod = await findTestVarsModule(params);
  if (mod === undefined || params.variable_id === undefined) return undefined;
  return db.query.testVariables.findFirst({ where: and(eq(testVariables.moduleId, mod.id), eq(testVariables.id, params.variable_id)) });
}

type TestRunParams = TestVarsParams & { test_run_id?: string; configuration_version_id?: string };

function testConfigurationResource(
  configuration: DeepReadonly<typeof moduleTestConfigurations.$inferSelect>,
  moduleId: string,
  selfPath: string,
): Record<string, unknown> {
  return {
    id: configuration.id,
    type: "test-configurations",
    attributes: {
      "oidc-enabled": configuration.oidcEnabled,
      "oidc-provider": configuration.oidcProvider,
      "created-at": new Date(configuration.updatedAt).toISOString(),
      "updated-at": new Date(configuration.updatedAt).toISOString(),
    },
    relationships: {
      "registry-module": { data: { id: moduleId, type: "registry-modules" } },
    },
    links: { self: selfPath },
  };
}

function testConfigurationVersionResource(
  configuration: DeepReadonly<typeof moduleTestConfigurationVersions.$inferSelect>,
  moduleId: string,
  request: Readonly<{ url: string }>,
): Record<string, unknown> {
  const uploadPath = `/api/v2/module-test-configuration-versions/${configuration.id}/upload`;
  return {
    id: configuration.id,
    type: "configuration-versions",
    attributes: {
      status: configuration.status,
      source: "tfe-api",
      speculative: false,
      provisional: false,
      error: null,
      "error-message": null,
      "created-at": new Date(configuration.createdAt).toISOString(),
      "uploaded-at": configuration.uploadedAt === null ? null : new Date(configuration.uploadedAt).toISOString(),
      "upload-url": signedApiURL(request, uploadPath, "PUT"),
    },
    relationships: {
      "registry-module": { data: { id: moduleId, type: "registry-modules" } },
    },
    links: { self: `/api/v2/module-test-configuration-versions/${configuration.id}` },
  };
}

function testRunResource(
  run: DeepReadonly<typeof moduleTestRuns.$inferSelect>,
  moduleId: string,
  version: string,
): Record<string, unknown> {
  return {
    id: run.id,
    type: "test-runs",
    attributes: {
      status: run.status,
      "status-timestamps": {
        "created-at": new Date(run.createdAt).toISOString(),
        "updated-at": new Date(run.updatedAt).toISOString(),
      },
      "created-at": new Date(run.createdAt).toISOString(),
      "updated-at": new Date(run.updatedAt).toISOString(),
      "test-configurable-type": "RegistryModule",
      "test-configurable-id": moduleId,
      variables: run.variables,
      filters: run.filters,
      "test-directory": run.testDirectory,
      verbose: run.verbose,
      "test-status": run.testStatus,
      "tests-passed": run.testsPassed,
      "tests-failed": run.testsFailed,
      "tests-errored": run.testsErrored,
      "tests-skipped": run.testsSkipped,
      source: run.source,
      message: run.message,
      "log-read-url": null,
      "oidc-token-generated-at": run.oidcTokenGeneratedAt === null ? null : new Date(run.oidcTokenGeneratedAt).toISOString(),
      "oidc-token-expires-at": run.oidcTokenExpiresAt === null ? null : new Date(run.oidcTokenExpiresAt).toISOString(),
      "execution-stage": run.executionStage,
      "execution-started-at": run.executionStartedAt === null ? null : new Date(run.executionStartedAt).toISOString(),
      "execution-checkpointed": run.executionPid !== null && run.executionResultPath !== null,
      version,
      error: run.error,
    },
    relationships: {
      "configuration-version": {
        data: run.configurationVersionId === null
          ? null
          : { id: run.configurationVersionId, type: "configuration-versions" },
      },
      "created-by": {
        data: run.createdBy === null ? null : { id: run.createdBy, type: "users" },
      },
    },
    links: { self: `/api/v2/test-runs/${run.id}` },
  };
}

async function findTestRunModule(params: TestRunParams): Promise<DeepReadonly<typeof registryModules.$inferSelect> | undefined> {
  if (params.registry_name !== "private") return undefined;
  return findTestVarsModule(params);
}

async function testRunConfigurationArchive(
  moduleId: string,
  configurationVersionId: string | undefined,
  organizationId: string,
): Promise<Readonly<{ archivePath: string | null; moduleConfigurationVersionId: string | null }>> {
  if (configurationVersionId === undefined || configurationVersionId === "") return { archivePath: null, moduleConfigurationVersionId: null };
  const moduleConfiguration = await db.query.moduleTestConfigurationVersions.findFirst({
    where: and(eq(moduleTestConfigurationVersions.id, configurationVersionId), eq(moduleTestConfigurationVersions.moduleId, moduleId)),
  });
  if (moduleConfiguration !== undefined) {
    return {
      archivePath: moduleConfiguration.status === "uploaded" && moduleConfiguration.archivePath !== null && await Bun.file(moduleConfiguration.archivePath).exists()
        ? moduleConfiguration.archivePath
        : null,
      moduleConfigurationVersionId: moduleConfiguration.id,
    };
  }
  const workspaceConfiguration = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, configurationVersionId) });
  if (workspaceConfiguration === undefined || workspaceConfiguration.archivePath === null || !(await Bun.file(workspaceConfiguration.archivePath).exists())) {
    return { archivePath: null, moduleConfigurationVersionId: null };
  }
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceConfiguration.workspaceId) });
  return workspace?.orgId === organizationId
    ? { archivePath: workspaceConfiguration.archivePath, moduleConfigurationVersionId: null }
    : { archivePath: null, moduleConfigurationVersionId: null };
}

function testVariableInput(body: unknown, requireKey: boolean): Readonly<{ key?: string; value?: string; sensitive?: boolean; hcl?: boolean; category?: string; description?: string | null }> | Readonly<{ error: string }> {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const data = payload.data;
  if (data === null || typeof data !== "object") return { error: "data is required" };
  const attributes = (data as Record<string, unknown>).attributes;
  if (attributes === null || typeof attributes !== "object") return { error: "data.attributes is required" };
  const attrs = attributes as Record<string, unknown>;
  const key = attrs.key;
  const category = attrs.category;
  if (typeof category !== "undefined" && category !== null && typeof category !== "string") return { error: "category must be a string" };
  if (requireKey && (typeof key !== "string" || key.trim() === "")) return { error: "key is required" };
  if (typeof key !== "undefined" && key !== null && typeof key !== "string") return { error: "key must be a string" };
  const cat = typeof category === "string" ? category : "terraform";
  if (cat !== "terraform" && cat !== "env") return { error: "category must be terraform or env" };
  const result: { key?: string; value?: string; sensitive?: boolean; hcl?: boolean; category?: string; description?: string | null } = {};
  // Only set category when the caller provided it, so a PATCH that omits
  // category preserves the stored one (create defaults to "terraform").
  if (typeof category === "string") result.category = cat;
  if (typeof key === "string") result.key = key;
  if (typeof attrs.value === "string") result.value = attrs.value;
  if (typeof attrs.sensitive === "boolean") result.sensitive = attrs.sensitive;
  if (typeof attrs.hcl === "boolean") result.hcl = attrs.hcl;
  if (typeof attrs.description === "string") result.description = attrs.description;
  return result;
}

type NoCodeDetails = Readonly<{
  noCode: typeof noCodeModules.$inferSelect;
  mod: typeof registryModules.$inferSelect;
  version: typeof registryModuleVersions.$inferSelect;
  org: typeof organizations.$inferSelect;
}>;

async function noCodeDetails(id: string): Promise<NoCodeDetails | undefined> {
  const noCode = await db.query.noCodeModules.findFirst({ where: eq(noCodeModules.id, id) });
  if (noCode === undefined) return undefined;
  const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, noCode.moduleId) });
  if (mod === undefined) return undefined;
  const [version, org] = await Promise.all([
    db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, noCode.versionId) }),
    db.query.organizations.findFirst({ where: eq(organizations.id, mod.orgId) }),
  ]);
  return version === undefined || org === undefined ? undefined : { noCode, mod, version, org };
}

export const registryRoutes = new Elysia({ name: "registry" })
  .use(authPlugin)
  // --- Module Registry Protocol ---
  .get("/api/registry/v1/modules/:namespace/:name/:provider/versions", async ({ params, user, orgId: tokenOrgId, run, set }: ParamCtx): Promise<unknown> => {
    const namespace = params.namespace ?? "";
    const name = params.name ?? "";
    const provider = params.provider ?? "";
    const mod = await findRegistryModule(namespace, name, provider, user?.id, tokenOrgId, run);
    if (mod === undefined) return registryNotFound(set);
    const verList = await availableModuleVersions(mod.id);
    return { modules: [{ versions: verList.map((v: ModVerItem): Record<string, string> => ({ version: v.version })) }] };
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider/:version", async ({ params, user, orgId: tokenOrgId, run, set }: ParamCtx): Promise<unknown> => {
    const namespace = params.namespace ?? "";
    const name = params.name ?? "";
    const provider = params.provider ?? "";
    const version = params.version ?? "";
    const mod = await findRegistryModule(namespace, name, provider, user?.id, tokenOrgId, run);
    if (mod === undefined) return registryNotFound(set);
    const ver = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)) });
    if (ver === undefined || ver.status !== "ok" || ver.isRevoked === true || ver.archivePath === null || !(await Bun.file(ver.archivePath).exists())) return registryNotFound(set);
    return { id: `${namespace}/${name}/${provider}/${version}`, owner: namespace, namespace, name, provider, version: ver.version, status: ver.status, download_url: `/api/registry/v1/modules/${namespace}/${name}/${provider}/${version}/download` };
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider/:version/download", async ({ params, user, orgId: tokenOrgId, run, request, set }: ParamCtx): Promise<unknown> => {
    const namespace = params.namespace ?? "";
    const name = params.name ?? "";
    const provider = params.provider ?? "";
    const version = params.version ?? "";
    const mod = await findRegistryModule(namespace, name, provider, user?.id, tokenOrgId, run);
    if (mod === undefined) return registryNotFound(set);
    const ver = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)) });
    if (ver === undefined || ver.status !== "ok" || ver.isRevoked === true || ver.archivePath === null || !(await Bun.file(ver.archivePath).exists())) return registryNotFound(set);
    // Terraform fetches the archive WITHOUT an Authorization header, so the
    // archive URL is signed (the reference format model).
    // The URL ends in .tar.gz so go-getter detects the archive format from
    // the extension (a bare /archive path falls back to XML sniffing).
    const archivePath = `/api/registry/v1/modules/${namespace}/${name}/${provider}/${version}/archive.tar.gz`;
    (set.headers as Record<string, string | number>)["X-Terraform-Get"] = signedApiURL(request, archivePath, "GET");
    (set as { status: number }).status = 204;
    return undefined;
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider/:version/archive.tar.gz", async ({ params, user, orgId: tokenOrgId, run, request, set }: ParamCtx): Promise<unknown> => {
    const namespace = params.namespace ?? "";
    const name = params.name ?? "";
    const provider = params.provider ?? "";
    const version = params.version ?? "";
    const archivePath = `/api/registry/v1/modules/${namespace}/${name}/${provider}/${version}/archive.tar.gz`;
    // Terraform fetches the archive without an Authorization header; a valid
    // signed URL (issued by the download endpoint) authorizes the fetch.
    const signedOk = validSignedApiURL(request, archivePath, "GET");
    let mod = await findRegistryModule(namespace, name, provider, user?.id, tokenOrgId, run);
    if (mod === undefined && signedOk) {
      mod = await db.query.registryModules.findFirst({
        where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)),
      });
    }
    if (mod === undefined) return registryNotFound(set);
    const ver = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)) });
    if (ver === undefined || ver.status !== "ok" || ver.isRevoked === true || ver.archivePath === null || !(await Bun.file(ver.archivePath).exists())) return registryNotFound(set);
    (set.headers as Record<string, string | number>)["Content-Type"] = "application/x-gzip";
    return Bun.file(ver.archivePath);
  })
  .get("/api/registry/v1/modules/:namespace/:name", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const namespace = params.namespace ?? "";
    const name = params.name ?? "";
    const found = await db.query.registryModules.findMany({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name)) });
    const readable = await Promise.all(found.map(async (mod): Promise<boolean> => checkRegistryReadPermission(user?.id, mod.orgId, "modules", tokenOrgId)));
    const mods = found.filter((_, index): boolean => readable[index] === true);
    if (mods.length === 0) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { modules: mods.map((m: ModItem): Record<string, unknown> => ({ id: `${namespace}/${name}/${m.provider}`, owner: namespace, namespace, name, provider: m.provider, versions: [] })) };
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider", async ({ params, user, orgId: tokenOrgId, run, set }: ParamCtx): Promise<unknown> => {
    const namespace = params.namespace ?? "";
    const name = params.name ?? "";
    const provider = params.provider ?? "";
    const mod = await findRegistryModule(namespace, name, provider, user?.id, tokenOrgId, run);
    if (mod === undefined) return registryNotFound(set);
    const verList = await availableModuleVersions(mod.id);
    const latestVersion = verList[0]?.version ?? "0.0.0";
    const status = verList[0]?.status ?? "pending";
    return { id: `${namespace}/${name}/${provider}/${latestVersion}`, owner: namespace, namespace, name, provider, version: latestVersion, status, versions: verList.map((v: ModVerItem): Record<string, string> => ({ version: v.version })) };
  })
  .get("/api/registry/v1/modules/:namespace", async ({ params, user, orgId: tokenOrgId }: ParamCtx): Promise<unknown> => {
    const namespace = params.namespace ?? "";
    const found = await db.query.registryModules.findMany({ where: eq(registryModules.namespace, namespace) });
    const readable = await Promise.all(found.map(async (mod): Promise<boolean> => checkRegistryReadPermission(user?.id, mod.orgId, "modules", tokenOrgId)));
    const mods = found.filter((_, index): boolean => readable[index] === true);
    const modules = await Promise.all(mods.map(async (m: ModItem): Promise<Record<string, unknown>> => {
      const verList = await availableModuleVersions(m.id);
      return { id: `${m.namespace}/${m.name}/${m.provider}`, owner: m.namespace, namespace: m.namespace, name: m.name, provider: m.provider, version: verList[0]?.version ?? null, versions: verList.map((v: ModVerItem): Record<string, string> => ({ version: v.version })) };
    }));
    return { modules };
  })
  .get("/api/registry/v1/modules", async ({ query, user, orgId: tokenOrgId }: ParamCtx): Promise<unknown> => {
    const searchQuery = (query?.q ?? "").trim();
    let mods: (typeof registryModules.$inferSelect)[];
    if (searchQuery !== "") {
      mods = await db.query.registryModules.findMany({ where: or(like(registryModules.name, `%${searchQuery}%`), like(registryModules.namespace, `%${searchQuery}%`), like(registryModules.provider, `%${searchQuery}%`)), limit: 50 });
    } else {
      mods = await db.query.registryModules.findMany({ limit: 50 });
    }
    const readable = await Promise.all(mods.map(async (mod): Promise<boolean> => checkRegistryReadPermission(user?.id, mod.orgId, "modules", tokenOrgId)));
    const modules = await Promise.all(mods.filter((_, index): boolean => readable[index] === true).map(async (m: ModItem): Promise<Record<string, unknown>> => {
      const verList = await availableModuleVersions(m.id);
      return { id: `${m.namespace}/${m.name}/${m.provider}`, owner: m.namespace, namespace: m.namespace, name: m.name, provider: m.provider, version: verList[0]?.version ?? null, versions: verList.map((v: ModVerItem): Record<string, string> => ({ version: v.version })) };
    }));
    return { modules };
  })
  // --- Provider Registry Protocol ---
  .get("/api/registry/v1/providers/-/versions", async ({ query, user, orgId: tokenOrgId }: ParamCtx): Promise<unknown> => {
    const searchQuery = (query?.q ?? "").trim();
    let provs: (typeof registryProviders.$inferSelect)[];
    if (searchQuery !== "") {
      provs = await db.query.registryProviders.findMany({ where: or(like(registryProviders.namespace, `%${searchQuery}%`), like(registryProviders.type, `%${searchQuery}%`)), limit: 50 });
    } else {
      provs = await db.query.registryProviders.findMany({ limit: 50 });
    }
    const readable = await Promise.all(provs.map(async (provider): Promise<boolean> => checkRegistryReadPermission(user?.id, provider.orgId, "providers", tokenOrgId)));
    const versions = await Promise.all(provs.filter((_, index): boolean => readable[index] === true).map(async (p: ProvItem): Promise<Record<string, unknown>> => {
      const verList = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, p.id), orderBy: [desc(registryProviderVersions.createdAt)] });
      return { id: `${p.namespace}/${p.type}`, namespace: p.namespace, versions: verList.map((v: ProvVerItem): Record<string, unknown> => ({ version: v.version, protocols: v.protocols ?? ["5.0"], platforms: [] })) };
    }));
    return { versions };
  })
  .get("/api/registry/v1/providers/:namespace/:type/versions", async ({ params, user, orgId: tokenOrgId }: ParamCtx): Promise<unknown> => {
    const namespace = params.namespace ?? "";
    const type = params.type ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.namespace, namespace), eq(registryProviders.type, type)) });
    if (prov === undefined || !(await checkRegistryReadPermission(user?.id, prov.orgId, "providers", tokenOrgId))) { return { versions: [] }; }
    const verList = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, prov.id) });
    const versions = await Promise.all(verList.map(async (v: ProvVerItem): Promise<Record<string, unknown>> => {
      const platList = await db.query.registryProviderPlatforms.findMany({ where: eq(registryProviderPlatforms.versionId, v.id) });
      return { version: v.version, protocols: v.protocols ?? ["5.0"], platforms: platList.map((p: PlatItem): Record<string, string> => ({ os: p.os, arch: p.arch })) };
    }));
    return { versions };
  })
  .get("/api/registry/v1/providers/:namespace/:type/:version/download/:os/:arch", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const namespace = params.namespace ?? "";
    const type = params.type ?? "";
    const version = params.version ?? "";
    const os = params.os ?? "";
    const arch = params.arch ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.namespace, namespace), eq(registryProviders.type, type)) });
    if (prov === undefined || !(await checkRegistryReadPermission(user?.id, prov.orgId, "providers", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryProviderVersions.findFirst({ where: and(eq(registryProviderVersions.providerId, prov.id), eq(registryProviderVersions.version, version)) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const plat = await db.query.registryProviderPlatforms.findFirst({ where: and(eq(registryProviderPlatforms.versionId, ver.id), eq(registryProviderPlatforms.os, os), eq(registryProviderPlatforms.arch, arch)) });
    if (plat === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const signingKey = await registrySigningKey(prov.orgId, prov.namespace, ver.keyId);
    return {
      protocols: ver.protocols ?? ["5.0"],
      os: plat.os,
      arch: plat.arch,
      filename: plat.filename,
      download_url: plat.downloadUrl,
      shasum: plat.shasum,
      signing_keys: {
        gpg_public_keys: signingKey === undefined
          ? []
          : [{ key_id: signingKey.keyId, ascii_armor: signingKey.asciiArmor }],
      },
    };
  })
  // --- Provider Network Mirror Protocol ---
  .get("/api/registry/v1/provider-mirror/:hostname/:namespace/:type/index.json", async ({ params, request, user, orgId: tokenOrgId }: ParamCtx): Promise<Response> => {
    const prov = await db.query.registryProviders.findFirst({
      where: and(eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.type ?? "")),
    });
    if (
      prov === undefined
      || !matchesMirrorHostname(prov, params.hostname ?? "", request.url)
      || !(await checkRegistryReadPermission(user?.id, prov.orgId, "providers", tokenOrgId))
    ) {
      return new Response(null, { status: 404 });
    }
    const versions = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, prov.id) });
    return Response.json({ versions: Object.fromEntries(versions.map((version: ProvVerItem): [string, Record<string, never>] => [version.version, {}])) });
  })
  .get("/api/registry/v1/provider-mirror/:hostname/:namespace/:type/:version", async ({ params, request, user, orgId: tokenOrgId }: ParamCtx): Promise<Response> => {
    const prov = await db.query.registryProviders.findFirst({
      where: and(eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.type ?? "")),
    });
    if (
      prov === undefined
      || !matchesMirrorHostname(prov, params.hostname ?? "", request.url)
      || !(await checkRegistryReadPermission(user?.id, prov.orgId, "providers", tokenOrgId))
    ) {
      return new Response(null, { status: 404 });
    }
    const versionParam = params.version ?? "";
    if (!versionParam.endsWith(".json")) return new Response(null, { status: 404 });
    const requestedVersion = versionParam.slice(0, -".json".length);
    const ver = await db.query.registryProviderVersions.findFirst({
      where: and(eq(registryProviderVersions.providerId, prov.id), eq(registryProviderVersions.version, requestedVersion)),
    });
    if (ver === undefined) return new Response(null, { status: 404 });
    const platforms = await db.query.registryProviderPlatforms.findMany({ where: eq(registryProviderPlatforms.versionId, ver.id) });
    return Response.json({
      archives: Object.fromEntries(platforms.map((platform: PlatItem): [string, { url: string; hashes: string[] }] => [
        `${platform.os}_${platform.arch}`,
        { url: platform.downloadUrl, hashes: [`zh:${platform.shasum}`] },
      ])),
    });
  })
  // --- Module Management API (the reference format v2) ---
  .get("/api/v2/organizations/:org_name/registry-modules", async ({ params, request, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "modules", tokenOrgId, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const query = new URL(request.url).searchParams;
    const search = (query.get("q") ?? "").trim().toLocaleLowerCase();
    const provider = query.get("filter[provider]");
    const publishingMechanism = query.get("filter[publishing_mechanism]");
    const conditions: SQL[] = [eq(registryModules.orgId, org.id)];
    if (search !== "") {
      const pattern = `%${search}%`;
      const searchCondition = or(
        sql`lower(${registryModules.namespace}) like ${pattern}`,
        sql`lower(${registryModules.name}) like ${pattern}`,
        sql`lower(${registryModules.provider}) like ${pattern}`,
      );
      if (searchCondition !== undefined) conditions.push(searchCondition);
    }
    if (provider !== null && provider !== "") conditions.push(eq(registryModules.provider, provider));
    if (publishingMechanism !== null && publishingMechanism !== "") {
      conditions.push(eq(registryModules.publishingMechanism, publishingMechanism));
    }
    const where = and(...conditions);
    const page = pageRequest(request);
    const start = (page.number - 1) * page.size;
    const canManage = await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules");
    const [pageModules, countRows, providerRows] = await Promise.all([
      db.query.registryModules.findMany({
        where,
        orderBy: [desc(registryModules.updatedAt), asc(registryModules.id)],
        limit: page.size,
        offset: start,
      }),
      db.select({ total: count() }).from(registryModules).where(where),
      db.selectDistinct({ provider: registryModules.provider })
        .from(registryModules)
        .where(eq(registryModules.orgId, org.id)),
    ]);
    const pageData = pagination(request, page.number, page.size, countRows[0]?.total ?? 0);
    const pageVersions = pageModules.length === 0 ? [] : await db.query.registryModuleVersions.findMany({
      where: inArray(registryModuleVersions.moduleId, pageModules.map((mod): string => mod.id)),
      orderBy: [desc(registryModuleVersions.createdAt)],
    });
    const versionsByModule = Map.groupBy(pageVersions, (version): string => version.moduleId);
    return {
      data: await Promise.all(pageModules.map(async (mod): Promise<Record<string, unknown>> =>
        await registryModuleResource(mod, org.name, canManage, versionsByModule.get(mod.id) ?? []))),
      ...pageData,
      meta: {
        ...pageData.meta,
        providers: providerRows.map(({ provider: name }): string => name).sort(),
      },
    };
  })
  .post("/api/v2/organizations/:org_name/registry-modules", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    const provider = typeof attributes.provider === "string" ? attributes.provider.trim() : "";
    const namespace = attributes.namespace;
    const registryName = attributes["registry-name"];
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/.test(name) || !/^[a-z0-9]{1,64}$/.test(provider)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and provider must follow private module naming rules" }] };
    }
    if ((namespace !== undefined && namespace !== org.name) || (registryName !== undefined && registryName !== "private")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Private modules use the organization namespace and private registry" }] };
    }
    const id = `mod-${crypto.randomUUID()}`;
    const now = Date.now();
    const created: typeof registryModules.$inferInsert = {
      id,
      orgId: org.id,
      namespace: org.name,
      name,
      provider,
      publishingMechanism: "manual",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.insert(registryModules).values(created);
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "This private module already exists" }] };
    }
    (set as { status: number }).status = 201;
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, id) });
    if (mod === undefined) throw new Error("Created registry module could not be loaded");
    return { data: await registryModuleResource(mod, org.name, true) };
  })
  .post("/api/v2/organizations/:org_name/registry-modules/vcs", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const org = await cachedOrgByName(params.org_name ?? "");
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attributes = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const vcsRepo = attributes["vcs-repo"] !== null && typeof attributes["vcs-repo"] === "object"
      ? attributes["vcs-repo"] as Record<string, unknown>
      : {};
    const identifier = typeof vcsRepo.identifier === "string" ? vcsRepo.identifier.trim() : "";
    const repositoryName = identifier.split("/").at(-1) ?? "";
    const conventional = /^terraform-([a-z0-9]+)-([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(repositoryName);
    const rawModuleName = attributes["module-name"] ?? attributes.name;
    const rawProvider = attributes["module-provider"] ?? attributes.provider;
    const name = typeof rawModuleName === "string" ? rawModuleName.trim() : conventional?.[2] ?? "";
    const provider = typeof rawProvider === "string" ? rawProvider.trim() : conventional?.[1] ?? "";
    const githubAppInstallationId = vcsRepo["github-app-installation-id"];
    const oauthTokenId = vcsRepo["oauth-token-id"];
    const connectionCount = Number(typeof githubAppInstallationId === "string" && githubAppInstallationId !== "")
      + Number(typeof oauthTokenId === "string" && oauthTokenId !== "");
    const branch = typeof vcsRepo.branch === "string" && vcsRepo.branch.trim() !== "" ? vcsRepo.branch.trim() : null;
    const rawSourceDirectory = attributes["source-directory"] ?? vcsRepo["source-directory"];
    const rawTagPrefix = attributes["tag-prefix"] ?? vcsRepo["tag-prefix"];
    const sourceDirectory = typeof rawSourceDirectory === "string" ? rawSourceDirectory.trim() : "";
    const tagPrefix = typeof rawTagPrefix === "string" ? rawTagPrefix.trim() : "";
    const rawInitialVersion = attributes["initial-version"] ?? attributes.version;
    const initialVersion = typeof rawInitialVersion === "string" ? rawInitialVersion.replace(/^v/, "") : "0.0.0";
    const identifierParts = identifier.split("/");
    const identifierValid = identifierParts.length === 2
      && identifierParts.every((part): boolean => /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(part));
    if (data.type !== "registry-modules" || !identifierValid || connectionCount !== 1) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A repository identifier and exactly one VCS connection are required" }] };
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/.test(name) || !/^[a-z0-9]{1,64}$/.test(provider)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Repository name must follow terraform-<provider>-<module>, or module-name and provider must be supplied" }] };
    }
    if ((sourceDirectory !== "" && (sourceDirectory.startsWith("/") || sourceDirectory.includes("\\") || sourceDirectory.split("/").includes(".."))) || tagPrefix.length > 128) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Source directory or tag prefix is invalid" }] };
    }
    if (branch !== null && !validModuleVersion(initialVersion)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Branch-based publication requires a semantic initial-version" }] };
    }
    let connectionAvailable = false;
    let repositoryBaseUrl: string | null = null;
    if (typeof githubAppInstallationId === "string") {
      connectionAvailable = await db.query.githubAppInstallations.findFirst({
        where: and(eq(githubAppInstallations.id, githubAppInstallationId), eq(githubAppInstallations.orgId, org.id)),
      }) !== undefined;
      repositoryBaseUrl = process.env.GITHUB_APP_HTTP_URL ?? "https://github.com";
    } else {
      const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, oauthTokenId as string) });
      const client = token === undefined ? undefined : await db.query.oauthClients.findFirst({
        where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, org.id)),
      });
      connectionAvailable = client !== undefined && ["github", "github_enterprise"].includes(client.serviceProvider);
      repositoryBaseUrl = client?.httpUrl ?? (client?.serviceProvider === "github" ? "https://github.com" : null);
    }
    if (!connectionAvailable) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The selected VCS connection is unavailable or unsupported" }] };
    }
    const now = Date.now();
    const id = `mod-${crypto.randomUUID()}`;
    const rawRepositoryUrl = vcsRepo["repository-url"];
    let repositoryUrl: string | null = null;
    if (repositoryBaseUrl !== null) {
      try {
        const parsed = new URL(repositoryBaseUrl);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          parsed.username = "";
          parsed.password = "";
          repositoryUrl = `${parsed.toString().replace(/\/$/, "")}/${identifier}`;
        }
      } catch {
        // An invalid optional connection URL should not fabricate a github.com link.
      }
    }
    if (typeof rawRepositoryUrl === "string") {
      try {
        const parsed = new URL(rawRepositoryUrl);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
        parsed.username = "";
        parsed.password = "";
        repositoryUrl = parsed.toString();
      } catch {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "repository-url must be an HTTP or HTTPS URL" }] };
      }
    }
    try {
      await db.insert(registryModules).values({
        id,
        orgId: org.id,
        namespace: org.name,
        name,
        provider,
        publishingMechanism: "vcs",
        publishingWorkflow: branch === null ? "tag" : "branch",
        vcsConnectionType: typeof githubAppInstallationId === "string" ? "github-app" : "oauth-token",
        vcsConnectionId: typeof githubAppInstallationId === "string" ? githubAppInstallationId : oauthTokenId as string,
        repositoryIdentifier: identifier,
        repositoryDisplayIdentifier: typeof vcsRepo["display-identifier"] === "string"
          ? vcsRepo["display-identifier"]
          : typeof vcsRepo.display_identifier === "string" ? vcsRepo.display_identifier : identifier,
        repositoryUrl,
        sourceDirectory,
        tagPrefix,
        branch,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "This private module already exists" }] };
    }
    try {
      const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, id) });
      if (mod === undefined) throw new Error("Registry module could not be created");
      await synchronizeRegistryModule(mod, branch === null ? undefined : initialVersion);
      const updated = await db.query.registryModules.findFirst({ where: eq(registryModules.id, id) });
      if (updated === undefined) throw new Error("Registry module could not be created");
      (set as { status: number }).status = 201;
      return { data: await registryModuleResource(updated, org.name, true) };
    } catch (error: unknown) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error instanceof Error ? error.message : "Registry module ingestion failed" }] };
    }
  })
  .get("/api/v2/organizations/:org_name/registry-modules/:registry_name/:namespace/:module_name/:provider", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const namespace = params.namespace ?? "";
    const moduleName = params.module_name ?? "";
    const provider = params.provider ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "modules", tokenOrgId, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({
      where: and(
        eq(registryModules.orgId, org.id),
        eq(registryModules.namespace, namespace),
        eq(registryModules.name, moduleName),
        eq(registryModules.provider, provider),
      ),
    });
    if (mod === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const canManage = await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules");
    return { data: await registryModuleResource(mod, org.name, canManage) };
  })
  .get("/api/v2/organizations/:org_name/registry-modules/:registry_name/:namespace/:module_name/:provider/:version", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const mod = org === undefined ? undefined : await db.query.registryModules.findFirst({
      where: and(
        eq(registryModules.orgId, org.id),
        eq(registryModules.namespace, params.namespace ?? ""),
        eq(registryModules.name, params.module_name ?? ""),
        eq(registryModules.provider, params.provider ?? ""),
      ),
    });
    if (org === undefined || mod === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "modules", tokenOrgId, teamId ?? null))) return registryNotFound(set);
    const version = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, params.version ?? "")) });
    return version === undefined ? registryNotFound(set) : { data: registryModuleVersionResource(version) };
  })
  .patch("/api/v2/organizations/:org_name/registry-modules/:registry_name/:namespace/:module_name/:provider/:version", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const mod = org === undefined ? undefined : await db.query.registryModules.findFirst({
      where: and(
        eq(registryModules.orgId, org.id),
        eq(registryModules.namespace, params.namespace ?? ""),
        eq(registryModules.name, params.module_name ?? ""),
        eq(registryModules.provider, params.provider ?? ""),
      ),
    });
    if (org === undefined || mod === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    const version = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, params.version ?? "")) });
    if (version === undefined) return registryNotFound(set);
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attrs = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const deprecation = attrs.deprecation !== null && typeof attrs.deprecation === "object" ? attrs.deprecation as Record<string, unknown> : {};
    const status = deprecation["deprecated-status"];
    const deprecated = typeof attrs.deprecated === "boolean"
      ? attrs.deprecated
      : status === "Deprecated"
        ? true
        : status === "Undeprecated"
          ? false
          : undefined;
    if (deprecated === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "deprecation.deprecated-status must be Deprecated or Undeprecated" }] };
    }
    await db.update(registryModuleVersions).set({ isDeprecated: deprecated, updatedAt: Date.now() }).where(eq(registryModuleVersions.id, version.id));
    const updated = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, version.id) });
    return updated === undefined ? registryNotFound(set) : { data: registryModuleVersionResource(updated) };
  })
  .delete("/api/v2/organizations/:org_name/registry-modules/:registry_name/:namespace/:module_name/:provider/:version", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const mod = org === undefined ? undefined : await db.query.registryModules.findFirst({
      where: and(
        eq(registryModules.orgId, org.id),
        eq(registryModules.namespace, params.namespace ?? ""),
        eq(registryModules.name, params.module_name ?? ""),
        eq(registryModules.provider, params.provider ?? ""),
      ),
    });
    const version = mod === undefined ? undefined : await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, params.version ?? "")) });
    if (org === undefined || mod === undefined || version === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    await db.delete(registryModuleVersions).where(eq(registryModuleVersions.id, version.id));
    if (version.archivePath !== null) await rm(version.archivePath, { force: true });
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/registry-modules/:module_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const moduleId = params.module_id ?? "";
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
    if (mod === undefined || !(await checkRegistryManagementRead(user?.id, mod.orgId, "modules", tokenOrgId, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, mod.orgId) });
    const canManage = await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules");
    return { data: await registryModuleResource(mod, org?.name ?? mod.orgId, canManage) };
  })
  .post("/api/v2/registry-modules/:module_id/actions/resync", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, params.module_id ?? "") });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    if (mod.publishingMechanism !== "vcs" || mod.publishingWorkflow !== "tag") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Resync imports new versions only for tag-based VCS modules; create a version for branch-based modules" }] };
    }
    try {
      const result = await synchronizeRegistryModule(mod);
      const updated = await db.query.registryModules.findFirst({ where: eq(registryModules.id, mod.id) });
      const org = await db.query.organizations.findFirst({ where: eq(organizations.id, mod.orgId) });
      if (updated === undefined) return registryNotFound(set);
      return { data: await registryModuleResource(updated, org?.name ?? mod.orgId, true), meta: result };
    } catch (error: unknown) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error instanceof Error ? error.message : "Registry module synchronization failed" }] };
    }
  })
  .patch("/api/v2/organizations/:org_name/registry-modules/private/:namespace/:module_name/:provider", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const org = await cachedOrgByName(params.org_name ?? "");
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    const mod = await db.query.registryModules.findFirst({
      where: and(
        eq(registryModules.orgId, org.id),
        eq(registryModules.namespace, params.namespace ?? ""),
        eq(registryModules.name, params.module_name ?? ""),
        eq(registryModules.provider, params.provider ?? ""),
      ),
    });
    if (mod === undefined) return registryNotFound(set);
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attributes = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const sourceDirectory = attributes["source-directory"];
    const tagPrefix = attributes["tag-prefix"];
    const vcsRepo = attributes["vcs-repo"] !== null && typeof attributes["vcs-repo"] === "object" ? attributes["vcs-repo"] as Record<string, unknown> : {};
    const requestedBranch = vcsRepo.branch;
    if (sourceDirectory !== undefined && (typeof sourceDirectory !== "string" || sourceDirectory.startsWith("/") || sourceDirectory.includes("\\") || sourceDirectory.split("/").includes(".."))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "source-directory must be a safe relative path" }] };
    }
    if (tagPrefix !== undefined && (typeof tagPrefix !== "string" || tagPrefix.length > 128)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "tag-prefix must be at most 128 characters" }] };
    }
    if (requestedBranch !== undefined && requestedBranch !== mod.branch) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Switching publishing workflows is not supported; create a new module instead" }] };
    }
    await db.update(registryModules).set({
      ...(typeof sourceDirectory === "string" ? { sourceDirectory } : {}),
      ...(typeof tagPrefix === "string" ? { tagPrefix } : {}),
      updatedAt: Date.now(),
    }).where(eq(registryModules.id, mod.id));
    const updated = await db.query.registryModules.findFirst({ where: eq(registryModules.id, mod.id) });
    if (updated === undefined) return registryNotFound(set);
    return { data: await registryModuleResource(updated, org.name, true) };
  })
  .get("/api/v2/organizations/:org_name/registry-modules/:registry_name/:namespace/:module_name/:provider/version", async ({ params, request, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    // go-tfe RegistryModules.ReadVersion — resolves a single published module
    // version by ?module_version=. The tfe_no_code_module create polls this
    // until the pinned version is published.
    const orgName = params.org_name ?? "";
    const namespace = params.namespace ?? "";
    const moduleName = params.module_name ?? "";
    const provider = params.provider ?? "";
    const version = new URL(request.url).searchParams.get("module_version") ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "modules", tokenOrgId, teamId ?? null)) || version === "") { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({
      where: and(eq(registryModules.orgId, org.id), eq(registryModules.namespace, namespace), eq(registryModules.name, moduleName), eq(registryModules.provider, provider)),
    });
    if (mod === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ver.id, type: "registry-module-versions", attributes: { version: ver.version, status: ver.status, "created-at": new Date(ver.createdAt).toISOString() } } };
  })
  .delete("/api/v2/registry-modules/:module_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const moduleId = params.module_id ?? "";
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await deleteRegistryModuleAndArchives(moduleId);
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/organizations/:org_name/registry-modules/:registry_name/:namespace/:module_name/:provider", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params.org_name ?? "";
    const namespace = params.namespace ?? "";
    const moduleName = params.module_name ?? "";
    const provider = params.provider ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({
      where: and(
        eq(registryModules.orgId, org.id),
        eq(registryModules.namespace, namespace),
        eq(registryModules.name, moduleName),
        eq(registryModules.provider, provider),
      ),
    });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await deleteRegistryModuleAndArchives(mod.id);
    (set as { status: number }).status = 204;
    return {};
  })
  // --- No-Code Module Allowlist ---
  .post("/api/v2/organizations/:org_name/no-code-modules", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    const hasSupportedPrincipal = user !== null && user !== undefined || teamId !== null && teamId !== undefined;
    if (
      org === undefined
      || !hasSupportedPrincipal
      || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const input = noCodeInput(body, true);
    if ("error" in input) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: input.error }] };
    }
    if (input.moduleId === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "registry-module relationship is required" }] };
    }

    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, input.moduleId) });
    if (mod?.orgId !== org.id) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const version = input.versionPin === undefined
      ? await db.query.registryModuleVersions.findFirst({
          where: eq(registryModuleVersions.moduleId, mod.id),
          orderBy: [desc(registryModuleVersions.createdAt)],
        })
      : await db.query.registryModuleVersions.findFirst({
          where: and(
            eq(registryModuleVersions.moduleId, mod.id),
            eq(registryModuleVersions.version, input.versionPin),
          ),
        });
    if (version?.status !== "ok") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "version-pin must identify a published version of the registry module" }] };
    }

    const existing = await db.query.noCodeModules.findFirst({ where: eq(noCodeModules.moduleId, mod.id) });
    const now = Date.now();
    const noCode = existing === undefined
      ? { id: `nocode-${crypto.randomUUID()}`, moduleId: mod.id, versionId: version.id, enabled: input.enabled ?? false, createdAt: now, updatedAt: now }
      : { ...existing, versionId: version.id, enabled: input.enabled ?? false, updatedAt: now };
    if (existing === undefined) {
      await db.insert(noCodeModules).values(noCode);
    } else {
      await db.update(noCodeModules)
        .set({ versionId: version.id, enabled: input.enabled ?? false, updatedAt: now })
        .where(eq(noCodeModules.id, existing.id));
    }
    if (input.variableOptions !== undefined) await replaceVariableOptions(noCode.id, input.variableOptions);
    const options = await db.query.noCodeVariableOptions.findMany({
      where: eq(noCodeVariableOptions.noCodeModuleId, noCode.id),
    });
    return { data: noCodeResource(noCode, org, mod, version, options) };
  })
  .get("/api/v2/organizations/:org_name/no-code-modules", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (
      org === undefined
      || !(
        await checkOrgPermission(user?.id, org.id, "member", tokenOrgId)
        || await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules")
      )
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const rows = await db.select({
      noCode: noCodeModules,
      mod: registryModules,
      version: registryModuleVersions,
    })
      .from(noCodeModules)
      .innerJoin(registryModules, eq(noCodeModules.moduleId, registryModules.id))
      .innerJoin(registryModuleVersions, eq(noCodeModules.versionId, registryModuleVersions.id))
      .where(eq(registryModules.orgId, org.id))
      .orderBy(desc(noCodeModules.createdAt));
    const resources = await Promise.all(rows.map(async (row): Promise<Record<string, unknown>> => {
      const options = await db.query.noCodeVariableOptions.findMany({
        where: eq(noCodeVariableOptions.noCodeModuleId, row.noCode.id),
      });
      return noCodeResource(row.noCode, org, row.mod, row.version, options);
    }));
    return { data: resources };
  })
  .get("/api/v2/no-code-modules/:id", async ({ params, query, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const includeRaw = query?.include;
    const include = typeof includeRaw === "string" ? includeRaw : undefined;
    if (include !== undefined && include !== "variable_options" && include !== "variable-options") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "include must be variable_options" }] };
    }
    const details = await noCodeDetails(params.id ?? "");
    if (
      details === undefined
      || !(
        await checkOrgPermission(user?.id, details.org.id, "member", tokenOrgId)
        || await checkOrganizationPermission(details.org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules")
      )
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const options = await db.query.noCodeVariableOptions.findMany({
      where: eq(noCodeVariableOptions.noCodeModuleId, details.noCode.id),
    });
    return {
      data: noCodeResource(details.noCode, details.org, details.mod, details.version, options),
      ...(include === "variable_options" || include === "variable-options" ? { included: options.map(variableOptionResource) } : {}),
    };
  })
  .patch("/api/v2/no-code-modules/:id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await noCodeDetails(params.id ?? "");
    const hasSupportedPrincipal = user !== null && user !== undefined || teamId !== null && teamId !== undefined;
    if (
      details === undefined
      || !hasSupportedPrincipal
      || !(await checkOrganizationPermission(details.org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const input = noCodeInput(body, false);
    if ("error" in input) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: input.error }] };
    }
    const targetModule = input.moduleId === undefined
      ? details.mod
      : await db.query.registryModules.findFirst({ where: eq(registryModules.id, input.moduleId) });
    if (targetModule?.orgId !== details.org.id) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const targetVersion = input.versionPin === undefined && targetModule.id === details.mod.id
      ? details.version
      : input.versionPin === undefined
        ? await db.query.registryModuleVersions.findFirst({
            where: eq(registryModuleVersions.moduleId, targetModule.id),
            orderBy: [desc(registryModuleVersions.createdAt)],
          })
        : await db.query.registryModuleVersions.findFirst({
            where: and(
              eq(registryModuleVersions.moduleId, targetModule.id),
              eq(registryModuleVersions.version, input.versionPin),
            ),
          });
    if (targetVersion?.status !== "ok") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "version-pin must identify a published version of the registry module" }] };
    }
    const duplicate = await db.query.noCodeModules.findFirst({ where: eq(noCodeModules.moduleId, targetModule.id) });
    if (duplicate !== undefined && duplicate.id !== details.noCode.id) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The registry module is already enabled as a no-code module" }] };
    }
    if (input.variableOptions !== undefined) {
      const optionError = await validateVariableOptionPatch(details.noCode.id, input.variableOptions);
      if (optionError !== undefined) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: optionError.error }] };
      }
    }
    await db.update(noCodeModules).set({
      moduleId: targetModule.id,
      versionId: targetVersion.id,
      enabled: input.enabled ?? details.noCode.enabled,
      updatedAt: Date.now(),
    }).where(eq(noCodeModules.id, details.noCode.id));
    if (input.variableOptions !== undefined) {
      const optionError = await patchVariableOptions(details.noCode.id, input.variableOptions);
      if (optionError !== undefined) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: optionError.error }] };
      }
    }
    const [updated, options] = await Promise.all([
      db.query.noCodeModules.findFirst({ where: eq(noCodeModules.id, details.noCode.id) }),
      db.query.noCodeVariableOptions.findMany({ where: eq(noCodeVariableOptions.noCodeModuleId, details.noCode.id) }),
    ]);
    if (updated === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: noCodeResource(updated, details.org, targetModule, targetVersion, options) };
  })
  .delete("/api/v2/no-code-modules/:id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.id ?? "";
    const noCode = await db.query.noCodeModules.findFirst({ where: eq(noCodeModules.id, id) });
    const mod = noCode === undefined
      ? undefined
      : await db.query.registryModules.findFirst({ where: eq(registryModules.id, noCode.moduleId) });
    const hasSupportedPrincipal = user !== null && user !== undefined || teamId !== null && teamId !== undefined;
    if (
      noCode === undefined
      || mod === undefined
      || !hasSupportedPrincipal
      || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(noCodeModules).where(eq(noCodeModules.id, id));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Provider Management API (the reference format v2) ---
  .get("/api/v2/organizations/:org_name/registry-providers", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "providers", tokenOrgId, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const provList = await db.query.registryProviders.findMany({ where: eq(registryProviders.orgId, org.id) });
        return { data: provList.map((p: ProvItem): Record<string, unknown> => registryProviderResource(p, org.name)) };
      })
      .get("/api/v2/registry-providers/:provider_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
        const providerId = params.provider_id ?? "";
        const p = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, providerId) });
        if (p === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
        const org = await db.query.organizations.findFirst({ where: eq(organizations.id, p.orgId) });
        if (org === undefined || !(await checkRegistryManagementRead(user?.id, p.orgId, "providers", tokenOrgId, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
        }
        return { data: registryProviderResource(p, org.name) };
      })
      .get("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
        const orgName = params.org_name ?? "";
        const namespace = params.namespace ?? "";
        const name = params.name ?? "";
        const org = await cachedOrgByName(orgName);
        if (org === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "providers", tokenOrgId, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
        const p = await db.query.registryProviders.findFirst({
          where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, namespace), eq(registryProviders.type, name)),
        });
        if (p === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
        return { data: registryProviderResource(p, org.name) };
      })
      .post("/api/v2/organizations/:org_name/registry-providers", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
        const orgName = params.org_name ?? "";
        const org = await cachedOrgByName(orgName);
        if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
        const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const data = payload.data as Record<string, unknown> | undefined;
        const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
        const name = typeof attributes.name === "string" ? attributes.name : "";
        if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name (type) is required" }] }; }
        const id = `prov-${crypto.randomUUID()}`;
        const namespace = typeof attributes.namespace === "string" ? attributes.namespace : org.name;
        const registryName = typeof attributes["registry-name"] === "string" ? attributes["registry-name"] : "private";
        await db.insert(registryProviders).values({ id, orgId: org.id, namespace, type: name, registryName, createdAt: Date.now() });
        (set as { status: number }).status = 201;
        return { data: registryProviderResource({ id, orgId: org.id, namespace, type: name, registryName, createdAt: Date.now() }, org.name) };
      })
  .delete("/api/v2/registry-providers/:provider_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const providerId = params.provider_id ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, providerId) });
    if (prov === undefined || !(await checkOrganizationPermission(prov.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviders).where(eq(registryProviders.id, providerId));
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params.org_name ?? "";
    const namespace = params.namespace ?? "";
    const name = params.name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({
      where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, namespace), eq(registryProviders.type, name)),
    });
    if (prov === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviders).where(eq(registryProviders.id, prov.id));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Provider Versions ---
  .get("/api/v2/registry-providers/:provider_id/versions", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const providerId = params.provider_id ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, providerId) });
    if (prov === undefined || !(await checkRegistryManagementRead(user?.id, prov.orgId, "providers", tokenOrgId, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const versions = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, providerId), orderBy: [desc(registryProviderVersions.createdAt)] });
    return { data: versions.map((v: ProvVerItem): Record<string, unknown> => ({ id: v.id, type: "registry-provider-versions", attributes: { version: v.version, "key-id": v.keyId, protocols: v.protocols, "shasums-url": v.shasumsUrl, "shasums-signature-url": v.shasumsSignatureUrl, "created-at": new Date(v.createdAt).toISOString() } })) };
  })
  .post("/api/v2/registry-providers/:provider_id/versions", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const providerId = params.provider_id ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, providerId) });
    if (prov === undefined || !(await checkOrganizationPermission(prov.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const version = typeof attributes.version === "string" ? attributes.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version is required" }] }; }
    const rawKeyId = attributes["key-id"];
    if (rawKeyId !== undefined && (typeof rawKeyId !== "string" || rawKeyId === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "key-id must identify a GPG key" }] };
    }
    const keyId = typeof rawKeyId === "string" ? rawKeyId.toUpperCase() : null;
    if (keyId !== null && await registrySigningKey(prov.orgId, prov.namespace, keyId) === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "key-id must identify a GPG key in the provider namespace" }] };
    }
    const id = `provver-${crypto.randomUUID()}`;
    const protocols = Array.isArray(attributes.protocols) ? (attributes.protocols as string[]) : ["5.0"];
    const shasumsUrl = typeof attributes["shasums-url"] === "string" ? attributes["shasums-url"] : null;
    const shasumsSignatureUrl = typeof attributes["shasums-signature-url"] === "string" ? attributes["shasums-signature-url"] : null;
    try {
      await db.insert(registryProviderVersions).values({ id, providerId, version, keyId, protocols, shasumsUrl, shasumsSignatureUrl, createdAt: Date.now() });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Provider version already exists" }] };
    }
    (set as { status: number }).status = 201;
    return { data: { id, type: "registry-provider-versions", attributes: { version, "key-id": keyId, protocols, "shasums-url": shasumsUrl, "shasums-signature-url": shasumsSignatureUrl, "created-at": new Date().toISOString() } } };
  })
  .delete("/api/v2/registry-provider-versions/:version_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params.version_id ?? "";
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (prov === undefined || !(await checkOrganizationPermission(prov.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviderVersions).where(eq(registryProviderVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Provider Version Platforms ---
  .get("/api/v2/registry-provider-versions/:version_id/platforms", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (prov === undefined || !(await checkRegistryManagementRead(user?.id, prov.orgId, "providers", tokenOrgId, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const platforms = await db.query.registryProviderPlatforms.findMany({ where: eq(registryProviderPlatforms.versionId, versionId) });
    return { data: platforms.map((p: PlatItem): Record<string, unknown> => ({ id: p.id, type: "registry-provider-platforms", attributes: { os: p.os, arch: p.arch, filename: p.filename, "download-url": p.downloadUrl, shasum: p.shasum } })) };
  })
  .post("/api/v2/registry-provider-versions/:version_id/platforms", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (prov === undefined || !(await checkOrganizationPermission(prov.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const os = typeof attributes.os === "string" ? attributes.os : "";
    const arch = typeof attributes.arch === "string" ? attributes.arch : "";
    const filename = typeof attributes.filename === "string" ? attributes.filename : "";
    const downloadUrl = typeof attributes["download-url"] === "string" ? attributes["download-url"] : "";
    const shasum = typeof attributes.shasum === "string" ? attributes.shasum : "";
    if (os === "" || arch === "" || filename === "" || downloadUrl === "" || shasum === "") {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "os, arch, filename, download-url, and shasum are required" }] };
    }
    const id = `provplat-${crypto.randomUUID()}`;
    await db.insert(registryProviderPlatforms).values({ id, versionId, os, arch, filename, downloadUrl, shasum, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "registry-provider-platforms", attributes: { os, arch, filename, "download-url": downloadUrl, shasum } } };
  })
  .delete("/api/v2/registry-provider-platforms/:platform_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const platformId = params.platform_id ?? "";
    const platform = await db.query.registryProviderPlatforms.findFirst({ where: eq(registryProviderPlatforms.id, platformId) });
    if (platform === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, platform.versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (prov === undefined || !(await checkOrganizationPermission(prov.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviderPlatforms).where(eq(registryProviderPlatforms.id, platformId));
    (set as { status: number }).status = 204;
    return {};
  })
  // Canonical organization-scoped provider version/platform paths. The
  // generic resource-ID endpoints above remain available to Terrence clients.
  .get("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name/versions", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const provider = org === undefined ? undefined : await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.name ?? ""), eq(registryProviders.registryName, "private")) });
    if (org === undefined || provider === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "providers", tokenOrgId, teamId ?? null))) return registryNotFound(set);
    const versions = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, provider.id), orderBy: [desc(registryProviderVersions.createdAt)] });
    return { data: versions.map(registryProviderVersionResource) };
  })
  .get("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name/versions/:version", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const provider = org === undefined ? undefined : await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.name ?? ""), eq(registryProviders.registryName, "private")) });
    if (org === undefined || provider === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "providers", tokenOrgId, teamId ?? null))) return registryNotFound(set);
    const version = await db.query.registryProviderVersions.findFirst({ where: and(eq(registryProviderVersions.providerId, provider.id), eq(registryProviderVersions.version, params.version ?? "")) });
    return version === undefined ? registryNotFound(set) : { data: registryProviderVersionResource(version) };
  })
  .post("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name/versions", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const provider = org === undefined ? undefined : await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.name ?? ""), eq(registryProviders.registryName, "private")) });
    if (org === undefined || provider === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return registryNotFound(set);
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attrs = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const version = typeof attrs.version === "string" ? attrs.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version is required" }] }; }
    const rawKeyId = attrs["key-id"];
    if (rawKeyId !== undefined && (typeof rawKeyId !== "string" || rawKeyId === "")) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "key-id must identify a GPG key" }] }; }
    const keyId = typeof rawKeyId === "string" ? rawKeyId.toUpperCase() : null;
    if (keyId !== null && await registrySigningKey(org.id, provider.namespace, keyId) === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "key-id must identify a GPG key in the provider namespace" }] }; }
    const id = `provver-${crypto.randomUUID()}`;
    const protocols = Array.isArray(attrs.protocols) ? (attrs.protocols as string[]) : ["5.0"];
    const createdAt = Date.now();
    try {
      await db.insert(registryProviderVersions).values({ id, providerId: provider.id, version, keyId, protocols, shasumsUrl: typeof attrs["shasums-url"] === "string" ? attrs["shasums-url"] : null, shasumsSignatureUrl: typeof attrs["shasums-signature-url"] === "string" ? attrs["shasums-signature-url"] : null, createdAt });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Provider version already exists" }] };
    }
    (set as { status: number }).status = 201;
    const created = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, id) });
    return created === undefined ? registryNotFound(set) : { data: registryProviderVersionResource(created) };
  })
  .delete("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name/versions/:version", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const provider = org === undefined ? undefined : await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.name ?? ""), eq(registryProviders.registryName, "private")) });
    if (org === undefined || provider === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return registryNotFound(set);
    const version = await db.query.registryProviderVersions.findFirst({ where: and(eq(registryProviderVersions.providerId, provider.id), eq(registryProviderVersions.version, params.version ?? "")) });
    if (version === undefined) return registryNotFound(set);
    await db.delete(registryProviderVersions).where(eq(registryProviderVersions.id, version.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name/versions/:version/platforms", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const provider = org === undefined ? undefined : await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.name ?? ""), eq(registryProviders.registryName, "private")) });
    const version = provider === undefined ? undefined : await db.query.registryProviderVersions.findFirst({ where: and(eq(registryProviderVersions.providerId, provider.id), eq(registryProviderVersions.version, params.version ?? "")) });
    if (org === undefined || provider === undefined || version === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return registryNotFound(set);
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attrs = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const os = typeof attrs.os === "string" ? attrs.os : "";
    const arch = typeof attrs.arch === "string" ? attrs.arch : "";
    const filename = typeof attrs.filename === "string" ? attrs.filename : "";
    const downloadUrl = typeof attrs["download-url"] === "string" ? attrs["download-url"] : "";
    const shasum = typeof attrs.shasum === "string" ? attrs.shasum : "";
    if (os === "" || arch === "" || filename === "" || downloadUrl === "" || shasum === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "os, arch, filename, download-url, and shasum are required" }] }; }
    const id = `provplat-${crypto.randomUUID()}`;
    try {
      await db.insert(registryProviderPlatforms).values({ id, versionId: version.id, os, arch, filename, downloadUrl, shasum, createdAt: Date.now() });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Provider platform already exists" }] };
    }
    (set as { status: number }).status = 201;
    const created = await db.query.registryProviderPlatforms.findFirst({ where: eq(registryProviderPlatforms.id, id) });
    return created === undefined ? registryNotFound(set) : { data: registryProviderPlatformResource(created) };
  })
  .get("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name/versions/:version/platforms", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const provider = org === undefined ? undefined : await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.name ?? ""), eq(registryProviders.registryName, "private")) });
    const version = provider === undefined ? undefined : await db.query.registryProviderVersions.findFirst({ where: and(eq(registryProviderVersions.providerId, provider.id), eq(registryProviderVersions.version, params.version ?? "")) });
    if (org === undefined || provider === undefined || version === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "providers", tokenOrgId, teamId ?? null))) return registryNotFound(set);
    const platforms = await db.query.registryProviderPlatforms.findMany({ where: eq(registryProviderPlatforms.versionId, version.id) });
    return { data: platforms.map(registryProviderPlatformResource) };
  })
  .get("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name/versions/:version/platforms/:os/:arch", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const provider = org === undefined ? undefined : await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.name ?? ""), eq(registryProviders.registryName, "private")) });
    const version = provider === undefined ? undefined : await db.query.registryProviderVersions.findFirst({ where: and(eq(registryProviderVersions.providerId, provider.id), eq(registryProviderVersions.version, params.version ?? "")) });
    const platform = version === undefined ? undefined : await db.query.registryProviderPlatforms.findFirst({ where: and(eq(registryProviderPlatforms.versionId, version.id), eq(registryProviderPlatforms.os, params.os ?? ""), eq(registryProviderPlatforms.arch, params.arch ?? "")) });
    if (org === undefined || provider === undefined || version === undefined || platform === undefined || !(await checkRegistryManagementRead(user?.id, org.id, "providers", tokenOrgId, teamId ?? null))) return registryNotFound(set);
    return { data: registryProviderPlatformResource(platform) };
  })
  .delete("/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name/versions/:version/platforms/:os/:arch", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    if (params.registry_name !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.org_name ?? "");
    const provider = org === undefined ? undefined : await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.orgId, org.id), eq(registryProviders.namespace, params.namespace ?? ""), eq(registryProviders.type, params.name ?? ""), eq(registryProviders.registryName, "private")) });
    const version = provider === undefined ? undefined : await db.query.registryProviderVersions.findFirst({ where: and(eq(registryProviderVersions.providerId, provider.id), eq(registryProviderVersions.version, params.version ?? "")) });
    const platform = version === undefined ? undefined : await db.query.registryProviderPlatforms.findFirst({ where: and(eq(registryProviderPlatforms.versionId, version.id), eq(registryProviderPlatforms.os, params.os ?? ""), eq(registryProviderPlatforms.arch, params.arch ?? "")) });
    if (org === undefined || provider === undefined || version === undefined || platform === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return registryNotFound(set);
    await db.delete(registryProviderPlatforms).where(eq(registryProviderPlatforms.id, platform.id));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Module Versions ---
  .post("/api/v2/organizations/:org_name/registry-modules/:registry_name/:namespace/:module_name/:provider/versions", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const org = await cachedOrgByName(params.org_name ?? "");
    if (org === undefined || params.registry_name !== "private" || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    const mod = await db.query.registryModules.findFirst({
      where: and(
        eq(registryModules.orgId, org.id),
        eq(registryModules.namespace, params.namespace ?? ""),
        eq(registryModules.name, params.module_name ?? ""),
        eq(registryModules.provider, params.provider ?? ""),
      ),
    });
    if (mod === undefined) return registryNotFound(set);
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    if (data.type !== undefined && data.type !== "registry-module-versions") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be registry-module-versions" }] };
    }
    const attributes = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    return createRegistryModuleVersion(mod, attributes, set);
  })
  .get("/api/v2/registry-modules/:module_id/versions", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const moduleId = params.module_id ?? "";
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
    if (mod === undefined || !(await checkRegistryManagementRead(user?.id, mod.orgId, "modules", tokenOrgId, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const versions = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, moduleId), orderBy: [desc(registryModuleVersions.createdAt)] });
    return { data: versions.map(registryModuleVersionResource) };
  })
  .post("/api/v2/registry-modules/:module_id/versions", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const moduleId = params.module_id ?? "";
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    return createRegistryModuleVersion(mod, attributes, set);
  })
  .post("/api/v2/registry-modules/:module_id/versions/:version/test", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const target = await moduleTestTarget(params.module_id ?? "", params.version ?? "");
    if (
      target === undefined
      || !(await checkOrganizationPermission(target.mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (
      target.version.status !== "ok"
      || target.version.archivePath === null
      || !(await Bun.file(target.version.archivePath).exists())
    ) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The module version has no published archive" }] };
    }
    const configuration = moduleTestConfiguration(body);
    if ("error" in configuration) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: configuration.error }] };
    }
    const legacyRunId = `legacy-module-test-${crypto.randomUUID()}`;
    let result: Awaited<ReturnType<typeof runModuleTest>>;
    try {
      result = await runModuleTest(target.version.id, target.version.archivePath, configuration, undefined, await moduleTestEnvironmentFactory(target.mod.id, target.mod.name, target.mod.orgId, legacyRunId));
    } finally {
      await revokeWorkloadIdentityTokens(legacyRunId);
    }
    (set as { status: number }).status = 201;
    return { data: moduleTestResource(result, target.mod.id, target.version.version) };
  })
  .get("/api/v2/registry-modules/:module_id/versions/:version/test", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const target = await moduleTestTarget(params.module_id ?? "", params.version ?? "");
    if (
      target === undefined
      || !(await checkOrganizationPermission(target.mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const result = await readModuleTestResult(target.version.id);
    if (result === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: moduleTestResource(result, target.mod.id, target.version.version) };
  })
  .delete("/api/v2/registry-module-versions/:version_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params.version_id ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryModuleVersions).where(eq(registryModuleVersions.id, versionId));
    if (ver.archivePath !== null) await rm(ver.archivePath, { force: true });
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Module Version Upload ---
  .put("/api/v2/registry-module-versions/:version_id/upload", async ({ params, body, request, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (mod.publishingMechanism !== "manual") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "VCS-backed module versions are ingested from their configured VCS connection" }] };
    }
    if (ver.archivePath !== null) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Module version content was already uploaded" }] };
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_MODULE_ARCHIVE_BYTES) {
      (set as { status: number }).status = 413;
      return { errors: [{ status: "413", title: "Payload Too Large", detail: "Module archive exceeds the upload limit" }] };
    }
    const bytes = await uploadedBytes(body, request);
    if (bytes.byteLength > MAX_MODULE_ARCHIVE_BYTES) {
      (set as { status: number }).status = 413;
      return { errors: [{ status: "413", title: "Payload Too Large", detail: "Module archive exceeds the upload limit" }] };
    }
    const claimed = await db.update(registryModuleVersions)
      .set({ status: "ingesting", updatedAt: Date.now() })
      .where(and(
        eq(registryModuleVersions.id, versionId),
        isNull(registryModuleVersions.archivePath),
        ne(registryModuleVersions.status, "ingesting"),
      ))
      .returning({ id: registryModuleVersions.id });
    if (claimed.length !== 1) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Module version content was already uploaded" }] };
    }
    const rawPath = join(CV_STORAGE_DIR, `registry-module-${versionId}.${crypto.randomUUID()}.upload`);
    const archivePath = join(REGISTRY_MODULE_STORAGE_DIR, `${versionId}.tar.gz`);
    try {
      await mkdir(CV_STORAGE_DIR, { recursive: true, mode: 0o700 });
      await writeFile(rawPath, bytes, { mode: 0o600 });
      const metadata = await ingestModuleArchive(rawPath, archivePath, "", inspectRegistryModule);
      const publishedAt = Date.now();
      await db.transaction(async (tx): Promise<void> => {
        await tx.update(registryModuleVersions).set({
          archivePath,
          status: "ok",
          metadata,
          ingestError: null,
          publishedAt,
          updatedAt: publishedAt,
        }).where(eq(registryModuleVersions.id, versionId));
        await tx.update(registryModules).set({
          status: "setup_complete",
          description: metadata.description,
          updatedAt: publishedAt,
        }).where(eq(registryModules.id, mod.id));
      });
      const updated = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
      (set as { status: number }).status = 200;
      if (updated === undefined) throw new Error("Uploaded registry module version could not be loaded");
      return { data: registryModuleVersionResource(updated) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Module archive ingestion failed";
      await db.update(registryModuleVersions).set({ status: "errored", ingestError: message.slice(0, 2_000), updatedAt: Date.now() }).where(eq(registryModuleVersions.id, versionId));
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: message }] };
    } finally {
      await rm(rawPath, { force: true });
    }
  })
  .patch("/api/v2/registry-module-versions/:version_id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }

    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes: Record<string, unknown> = (data?.attributes ?? {}) as Record<string, unknown>;

    if (typeof attributes.deprecated !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "deprecated must be a boolean" }] };
    }
    await db.update(registryModuleVersions).set({ isDeprecated: attributes.deprecated, updatedAt: Date.now() }).where(eq(registryModuleVersions.id, versionId));
    const updated = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (updated === undefined) throw new Error("Updated registry module version could not be loaded");
    return { data: registryModuleVersionResource(updated) };
  })
  .delete("/api/v2/registry-module-versions/:version_id/actions/revert-deprecation", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }

    await db.update(registryModuleVersions).set({ isDeprecated: false, updatedAt: Date.now() }).where(eq(registryModuleVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/test-runs/configuration-versions", async ({ params, user, orgId: tokenOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const mod = await findTestRunModule(params);
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    const now = Date.now();
    const id = `cv-${crypto.randomUUID()}`;
    await db.insert(moduleTestConfigurationVersions).values({ id, moduleId: mod.id, archivePath: null, status: "pending", createdAt: now, uploadedAt: null });
    (set as { status: number }).status = 201;
    return { data: testConfigurationVersionResource({ id, moduleId: mod.id, archivePath: null, status: "pending", createdAt: now, uploadedAt: null }, mod.id, request) };
  })
  .put("/api/v2/module-test-configuration-versions/:configuration_version_id/upload", async ({ params, body, request, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const configuration = await db.query.moduleTestConfigurationVersions.findFirst({ where: eq(moduleTestConfigurationVersions.id, params.configuration_version_id ?? "") });
    const mod = configuration === undefined ? undefined : await db.query.registryModules.findFirst({ where: eq(registryModules.id, configuration.moduleId) });
    const path = `/api/v2/module-test-configuration-versions/${params.configuration_version_id ?? ""}/upload`;
    const authorized = mod !== undefined && (await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"));
    if (configuration === undefined || mod === undefined || (!authorized && !validSignedApiURL(request, path, "PUT"))) return registryNotFound(set);
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_MODULE_ARCHIVE_BYTES) {
      (set as { status: number }).status = 413;
      return { errors: [{ status: "413", title: "Payload Too Large", detail: "Configuration archive exceeds the upload limit" }] };
    }
    const bytes = await uploadedBytes(body, request);
    if (bytes.byteLength === 0) {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Configuration archive is empty" }] };
    }
    if (bytes.byteLength > MAX_MODULE_ARCHIVE_BYTES) {
      (set as { status: number }).status = 413;
      return { errors: [{ status: "413", title: "Payload Too Large", detail: "Configuration archive exceeds the upload limit" }] };
    }
    const claimed = await db.update(moduleTestConfigurationVersions)
      .set({ status: "uploading" })
      .where(and(
        eq(moduleTestConfigurationVersions.id, configuration.id),
        eq(moduleTestConfigurationVersions.status, "pending"),
        isNull(moduleTestConfigurationVersions.archivePath),
      ))
      .returning({ id: moduleTestConfigurationVersions.id });
    if (claimed.length !== 1) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Configuration content was already uploaded" }] };
    }
    const archivePath = join(CV_STORAGE_DIR, `module-test-config-${configuration.id}.tar.gz`);
    try {
      await mkdir(CV_STORAGE_DIR, { recursive: true, mode: 0o700 });
      await writeFile(archivePath, bytes, { mode: 0o600 });
      const uploadedAt = Date.now();
      await db.update(moduleTestConfigurationVersions).set({ archivePath, status: "uploaded", uploadedAt }).where(eq(moduleTestConfigurationVersions.id, configuration.id));
    } catch (error: unknown) {
      await db.update(moduleTestConfigurationVersions).set({ status: "pending" }).where(and(eq(moduleTestConfigurationVersions.id, configuration.id), eq(moduleTestConfigurationVersions.status, "uploading")));
      throw error;
    }
    const updated = await db.query.moduleTestConfigurationVersions.findFirst({ where: eq(moduleTestConfigurationVersions.id, configuration.id) });
    if (updated === undefined) return registryNotFound(set);
    (set as { status: number }).status = 200;
    return { data: testConfigurationVersionResource(updated, mod.id, request) };
  })
  .post("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/test-runs", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const mod = await findTestRunModule(params);
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    const configuration = moduleTestConfiguration(body);
    if ("error" in configuration) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: configuration.error }] };
    }
    const rawPayload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = rawPayload.data !== null && typeof rawPayload.data === "object" ? rawPayload.data as Record<string, unknown> : {};
    const relationships = data.relationships !== null && typeof data.relationships === "object" ? data.relationships as Record<string, unknown> : {};
    const configurationRelationship = relationships["configuration-version"];
    const configurationData = configurationRelationship !== null && typeof configurationRelationship === "object" ? (configurationRelationship as Record<string, unknown>).data : undefined;
    const configurationVersionId = configurationData !== null && typeof configurationData === "object" && typeof (configurationData as Record<string, unknown>).id === "string"
      ? (configurationData as Record<string, unknown>).id as string
      : undefined;
    const selected = await testRunConfigurationArchive(mod.id, configurationVersionId, mod.orgId);
    if (configurationVersionId !== undefined && selected.archivePath === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The configuration version is not uploaded or is not available to this module" }] };
    }
    const versions = await availableModuleVersions(mod.id);
    const version = versions[0];
    if (version === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The module has no published version available for testing" }] };
    }
    const archivePath = selected.archivePath ?? version.archivePath;
    if (archivePath === null || !(await Bun.file(archivePath).exists())) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The module archive is not available for testing" }] };
    }
    const now = Date.now();
    const id = `trun-${crypto.randomUUID()}`;
    const runValues: typeof moduleTestRuns.$inferInsert = {
      id,
      moduleId: mod.id,
      versionId: version.id,
      configurationVersionId: selected.moduleConfigurationVersionId,
      status: "queued",
      testStatus: null,
      testsPassed: null,
      testsFailed: null,
      testsErrored: null,
      testsSkipped: null,
      verbose: configuration.verbose,
      filters: [...configuration.filters],
      testDirectory: configuration.testDirectory,
      variables: configuration.variables.map((variable) => ({ ...variable })),
      source: "tfe-api",
      message: "Queued manually via the remote-workflow API",
      output: null,
      error: null,
      createdBy: user?.id ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(moduleTestRuns).values(runValues);
    await enqueueDurableJob("module-test", { runId: id }, { dedupeKey: id });
    const created = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, id) });
    if (created === undefined) throw new Error("Created module test run could not be loaded");
    (set as { status: number }).status = 201;
    return { data: testRunResource(created, mod.id, version.version) };
  })
  .get("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/test-runs", async ({ params, request, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const mod = await findTestRunModule(params);
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    const search = new URL(request.url).searchParams;
    const rawSources = search.get("filter[source]");
    const sources = rawSources === null || rawSources.trim() === "" ? [] : rawSources.split(",").map((source) => source.trim()).filter((source) => source !== "");
    const where = sources.length === 0
      ? eq(moduleTestRuns.moduleId, mod.id)
      : and(eq(moduleTestRuns.moduleId, mod.id), inArray(moduleTestRuns.source, sources));
    const { number, size } = pageRequest(request);
    const [rows, total] = await Promise.all([
      db.query.moduleTestRuns.findMany({ where, orderBy: [desc(moduleTestRuns.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(moduleTestRuns).where(where),
    ]);
    const versions = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, mod.id) });
    const versionById = new Map(versions.map((version) => [version.id, version.version]));
    return {
      data: rows.map((row) => testRunResource(row, mod.id, versionById.get(row.versionId) ?? row.versionId)),
      ...pagination(request, number, size, total[0]?.total ?? 0),
    };
  })
  .get("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/test-runs/:test_run_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const mod = await findTestRunModule(params);
    const run = mod === undefined ? undefined : await db.query.moduleTestRuns.findFirst({ where: and(eq(moduleTestRuns.id, params.test_run_id ?? ""), eq(moduleTestRuns.moduleId, mod.id)) });
    if (mod === undefined || run === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    const version = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, run.versionId) });
    return { data: testRunResource(run, mod.id, version?.version ?? run.versionId) };
  })
  .post("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/test-runs/:test_run_id/cancel", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const mod = await findTestRunModule(params);
    const run = mod === undefined ? undefined : await db.query.moduleTestRuns.findFirst({ where: and(eq(moduleTestRuns.id, params.test_run_id ?? ""), eq(moduleTestRuns.moduleId, mod.id)) });
    if (mod === undefined || run === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    if (!(["queued", "pending", "running"] as string[]).includes(run.status)) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Test was not running" }] };
    }
    const canceled = await db.update(moduleTestRuns)
      .set({ status: "canceled", updatedAt: Date.now(), message: "Canceled via the remote-workflow API" })
      .where(and(eq(moduleTestRuns.id, run.id), inArray(moduleTestRuns.status, ["queued", "pending", "running"])))
      .returning({ id: moduleTestRuns.id });
    if (canceled.length === 0) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Test was not running" }] };
    }
    await cancelDurableJobs("module-test", run.id);
    (set as { status: number }).status = 202;
    return {};
  })
  .post("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/test-runs/:test_run_id/force-cancel", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const mod = await findTestRunModule(params);
    const run = mod === undefined ? undefined : await db.query.moduleTestRuns.findFirst({ where: and(eq(moduleTestRuns.id, params.test_run_id ?? ""), eq(moduleTestRuns.moduleId, mod.id)) });
    if (mod === undefined || run === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    if (!(["queued", "pending", "running"] as string[]).includes(run.status)) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Test was not running" }] };
    }
    const canceled = await db.update(moduleTestRuns)
      .set({ status: "canceled", updatedAt: Date.now(), message: "Force-canceled via the remote-workflow API" })
      .where(and(eq(moduleTestRuns.id, run.id), inArray(moduleTestRuns.status, ["queued", "pending", "running"])))
      .returning({ id: moduleTestRuns.id });
    if (canceled.length === 0) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Test was not running" }] };
    }
    await cancelDurableJobs("module-test", run.id);
    (set as { status: number }).status = 202;
    return {};
  })
  .get("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/vars", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const mod = await findTestVarsModule(params);
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const rows = await db.query.testVariables.findMany({ where: eq(testVariables.moduleId, mod.id) });
    return { data: rows.map(testVariableResource) };
  })
  .post("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/vars", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const mod = await findTestVarsModule(params);
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const input = testVariableInput(body, true);
    if ("error" in input) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: input.error }] }; }
    const existing = await db.query.testVariables.findFirst({ where: and(eq(testVariables.moduleId, mod.id), eq(testVariables.key, input.key ?? "")) });
    if (existing !== undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A test variable with this key already exists" }] }; }
    const id = `var-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Date.now();
    const created = { id, moduleId: mod.id, key: input.key ?? "", value: input.value ?? "", sensitive: input.sensitive ?? false, hcl: input.hcl ?? false, category: input.category ?? "terraform", description: input.description ?? null, createdAt: now, updatedAt: now };
    await db.insert(testVariables).values(created);
    (set as { status: number }).status = 201;
    return { data: testVariableResource(created) };
  })
  .get("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/vars/:variable_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const variable = await findTestVariable(params);
    if (variable === undefined || !(await checkOrganizationPermission((await findTestVarsModule(params))?.orgId ?? "", user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: testVariableResource(variable) };
  })
  .patch("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/vars/:variable_id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const variable = await findTestVariable(params);
    if (variable === undefined || !(await checkOrganizationPermission((await findTestVarsModule(params))?.orgId ?? "", user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const input = testVariableInput(body, false);
    if ("error" in input) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: input.error }] }; }
    const updates: Partial<typeof testVariables.$inferInsert> = { updatedAt: Date.now() };
    if (input.key !== undefined) {
      if (input.key.trim() === "") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "key must not be empty" }] };
      }
      const dup = await db.query.testVariables.findFirst({ where: and(eq(testVariables.moduleId, variable.moduleId), eq(testVariables.key, input.key), ne(testVariables.id, variable.id)) });
      if (dup !== undefined) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A test variable with this key already exists" }] };
      }
      updates.key = input.key;
    }
    if (input.value !== undefined) updates.value = input.value;
    if (input.sensitive !== undefined) updates.sensitive = input.sensitive;
    if (input.hcl !== undefined) updates.hcl = input.hcl;
    if (input.category !== undefined) updates.category = input.category;
    if (input.description !== undefined) updates.description = input.description ?? null;
    let conflict = "";
    await db.transaction(async (tx): Promise<void> => {
      // Duplicate-key enforcement and the write share one transaction so a
      // concurrent create cannot slip a same-key row between check and update.
      if (input.key !== undefined) {
        if (input.key.trim() === "") { conflict = "key must not be empty"; return; }
        const dup = await tx.query.testVariables.findFirst({ where: and(eq(testVariables.moduleId, variable.moduleId), eq(testVariables.key, input.key), ne(testVariables.id, variable.id)) });
        if (dup !== undefined) { conflict = "A test variable with this key already exists"; return; }
        updates.key = input.key;
      }
      await tx.update(testVariables).set(updates).where(eq(testVariables.id, variable.id));
    });
    if (conflict !== "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: conflict }] };
    }
    const updated = await db.query.testVariables.findFirst({ where: eq(testVariables.id, variable.id) });
    return { data: updated === undefined ? undefined : testVariableResource(updated) };
  })
  .delete("/api/v2/organizations/:org_name/tests/registry-modules/:registry_name/:namespace/:module_name/:provider/vars/:variable_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const variable = await findTestVariable(params);
    if (variable === undefined || !(await checkOrganizationPermission((await findTestVarsModule(params))?.orgId ?? "", user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(testVariables).where(eq(testVariables.id, variable.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/registry-module-versions/:version_id/actions/revoke", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }

    await db.update(registryModuleVersions).set({ isRevoked: true, isDeprecated: true, updatedAt: Date.now() }).where(eq(registryModuleVersions.id, versionId));
    return {
      data: {
        id: versionId,
        type: "registry-module-versions",
        attributes: {
          version: ver.version,
          status: ver.status,
          deprecated: true,
          revoked: true,
        },
      },
    };
  })
  .post("/api/v2/registry-module-versions/:version_id/actions/revert-revocation", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }

    await db.update(registryModuleVersions).set({ isRevoked: false, isDeprecated: true, updatedAt: Date.now() }).where(eq(registryModuleVersions.id, versionId));
    return {
      data: {
        id: versionId,
        type: "registry-module-versions",
        attributes: {
          version: ver.version,
          status: ver.status,
          deprecated: true,
          revoked: false,
        },
      },
    };
  })
  .get("/api/v2/registry-modules/:module_id/:namespace/:name/:provider/test-configuration", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.module_id !== "private") return registryNotFound(set);
    const org = await cachedOrgByName(params.namespace ?? "");
    const mod = org === undefined ? undefined : await db.query.registryModules.findFirst({
      where: and(
        eq(registryModules.orgId, org.id),
        eq(registryModules.namespace, params.namespace ?? ""),
        eq(registryModules.name, params.name ?? ""),
        eq(registryModules.provider, params.provider ?? ""),
      ),
    });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) return registryNotFound(set);
    const configuration = await db.query.moduleTestConfigurations.findFirst({ where: eq(moduleTestConfigurations.moduleId, mod.id) });
    if (configuration === undefined) return registryNotFound(set);
    return {
      data: testConfigurationResource(
        configuration,
        mod.id,
        `/api/v2/registry-modules/private/${encodeURIComponent(mod.namespace)}/${encodeURIComponent(mod.name)}/${encodeURIComponent(mod.provider)}/test-configuration`,
      ),
    };
  })
  .patch("/api/v2/registry-modules/:module_id/:namespace/:name/:provider/test-configuration", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params.module_id !== "private") return registryNotFound(set);
    const { namespace, name, provider } = params;
    const org = await cachedOrgByName(namespace ?? "");
    const mod = await db.query.registryModules.findFirst({
      where: and(eq(registryModules.orgId, org?.id ?? ""), eq(registryModules.namespace, namespace ?? ""), eq(registryModules.name, name ?? ""), eq(registryModules.provider, provider ?? "")),
    });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = (data?.attributes as Record<string, unknown>) ?? {};
    const rawEnabled = attrs["oidc-enabled"];
    const rawProvider = attrs["oidc-provider"];
    const rawConfiguration = attrs["oidc-configuration"];
    const legacyProviderUrl = typeof attrs["oidc-provider-url"] === "string" ? attrs["oidc-provider-url"] : null;
    if (rawEnabled !== undefined && typeof rawEnabled !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "oidc-enabled must be a boolean" }] };
    }
    const existing = await db.query.moduleTestConfigurations.findFirst({ where: eq(moduleTestConfigurations.moduleId, mod.id) });
    const id = existing?.id ?? crypto.randomUUID();
    const oidcEnabled = typeof rawEnabled === "boolean" ? rawEnabled : existing?.oidcEnabled ?? legacyProviderUrl !== null;
    const oidcProvider = typeof rawProvider === "string" ? rawProvider : existing?.oidcProvider ?? null;
    if (oidcEnabled && (oidcProvider === null || !["aws", "gcp", "azure", "vault"].includes(oidcProvider))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "oidc-provider must be aws, gcp, azure, or vault when OIDC is enabled" }] };
    }
    if (rawConfiguration !== undefined && (rawConfiguration === null || typeof rawConfiguration !== "object" || Array.isArray(rawConfiguration))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "oidc-configuration must be an object" }] };
    }
    const oidcConfiguration = rawConfiguration === undefined
      ? existing?.oidcConfiguration ?? null
      : rawConfiguration as Record<string, unknown>;
    if (oidcEnabled && oidcConfiguration === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "oidc-configuration is required when OIDC is enabled" }] };
    }
    if (oidcEnabled && oidcConfiguration !== null) {
      const requiredFields: Record<string, readonly string[]> = {
        aws: ["role-arn"],
        gcp: ["service-account-email", "workload-provider-name"],
        azure: ["tenant-id", "client-id", "subscription-id"],
        vault: ["url", "role-name"],
      };
      const missing = (requiredFields[oidcProvider ?? ""] ?? []).filter((field): boolean => typeof oidcConfiguration[field] !== "string" || oidcConfiguration[field] === "");
      if (missing.length > 0) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `oidc-configuration requires ${missing.join(", ")}` }] };
      }
    }
    const updatedAt = Date.now();
    if (existing !== undefined) {
      await db.update(moduleTestConfigurations).set({ oidcEnabled, oidcProvider, oidcConfiguration, oidcProviderUrl: legacyProviderUrl ?? existing.oidcProviderUrl, updatedAt }).where(eq(moduleTestConfigurations.id, id));
    } else {
      await db.insert(moduleTestConfigurations).values({ id, moduleId: mod.id, oidcEnabled, oidcProvider, oidcConfiguration, oidcProviderUrl: legacyProviderUrl, updatedAt });
    }
    const configuration = await db.query.moduleTestConfigurations.findFirst({ where: eq(moduleTestConfigurations.id, id) });
    if (configuration === undefined) throw new Error("Updated test configuration could not be loaded");
    return {
      data: testConfigurationResource(configuration, mod.id, `/api/v2/registry-modules/private/${encodeURIComponent(mod.namespace)}/${encodeURIComponent(mod.name)}/${encodeURIComponent(mod.provider)}/test-configuration`),
    };
  })
  .post("/api/v2/registry-modules/:module_id/versions/:version/actions/test", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const modId = params.module_id ?? "";
    const versionStr = params.version ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({
      where: and(eq(registryModuleVersions.moduleId, modId), eq(registryModuleVersions.version, versionStr)),
    });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, modId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }

    if (ver.status !== "ok" || ver.archivePath === null || !(await Bun.file(ver.archivePath).exists())) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The module version has no published archive" }] };
    }
    const legacyRunId = `legacy-module-test-${crypto.randomUUID()}`;
    let result: Awaited<ReturnType<typeof runModuleTest>>;
    try {
      result = await runModuleTest(ver.id, ver.archivePath, {
        verbose: false,
        filters: [],
        testDirectory: "tests",
        variables: [],
      }, undefined, await moduleTestEnvironmentFactory(mod.id, mod.name, mod.orgId, legacyRunId));
    } finally {
      await revokeWorkloadIdentityTokens(legacyRunId);
    }
    (set as { status: number }).status = 201;
    return { data: moduleTestResource(result, mod.id, ver.version) };
  })
  .get("/api/v2/registry-modules/:module_id/versions/:version/tests", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const modId = params.module_id ?? "";
    const versionStr = params.version ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({
      where: and(eq(registryModuleVersions.moduleId, modId), eq(registryModuleVersions.version, versionStr)),
    });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, modId) });
    if (mod === undefined || !(await checkOrganizationPermission(mod.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }

    const [latest, tests] = await Promise.all([
      readModuleTestResult(ver.id),
      db.query.moduleTestResults.findMany({ where: eq(moduleTestResults.versionId, ver.id) }),
    ]);
    return {
      data: [
        ...(latest === undefined ? [] : [moduleTestResource(latest, mod.id, ver.version)]),
        ...tests.map((t) => ({
        id: t.id,
        type: "module-tests",
        attributes: { status: t.status, output: t.output },
        })),
      ],
    };
  });
