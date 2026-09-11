import { newResourceId } from "../lib/resource-id";
import { Elysia } from "elysia";
import { db, isPostgres, rawQueryAll } from "../db";
import { agentPools, projects, workspaces, workspaceTags, projectTags, workspaceVariables, runs, configurationVersions, remoteStateConsumers, dataRetentionPolicies, githubAppInstallations, oauthClients, oauthTokens, stateVersions, variableSets, variableSetWorkspaces, sshKeys, type users } from "../db/schema";
import { eq, and, asc, desc, count, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  workspaceResource,
  workspaceOutputResources,
  workspaceVariableResource,
  variableSetVariableResource,
  variableSetResource,
  tagBindingResource,
  type WorkspaceResourcePermissions,
} from "../lib/response";
import { CLIENT_ENCRYPTED_STATE_ERROR, decodeStatePayload, isClientEncryptedState, isUniqueConstraintError, validVariableAttributes } from "../lib/validation";
import { variableValueForWrite, variableValueForRead } from "../lib/variable-crypto";
import { validateVersion, caseInsensitiveLike, checkOrgPermission, checkOrganizationPermission, checkWorkspacePermission, workspacePermissionSets, workspaceAllows, findAuthorizedWorkspace, findWorkspaceByName, findLockedInheritedTagKey, parseTagBindings, parseStatePayload, auditLog, strictAuditEnabled, lockPrincipal, ownsWorkspaceLock, ifMatchSatisfied, type DeepReadonly } from "../lib/utils";
import { pageRequest, pagination } from "../lib/pagination";
import { applyDataRetentionGarbageCollection, promoteIntermediateStateVersion, safeDeleteWorkspace, deleteWorkspace } from "../lib/lifecycle";

import { archiveContainsWorkingDir, invalidTriggerPatternIndexes, invalidTriggerPrefixIndexes, listArchiveMembers, MAX_ARCHIVE_METADATA_BYTES, normalizeWorkingDirectory, readBoundedProcessOutput, summarizeTopLevelEntries } from "../workspace";
import { authPlugin } from "../auth";
import { agentPoolAllowsWorkspace } from "../lib/agent-pool-scope";
import { ensureDefaultProject, isAutoDestroyDuration, parseSettingOverwrites } from "./projects";
import { cachedOrgByName, cachedOrgById } from "../lib/cached-lookups";
import { isExecutionMode } from "../lib/constants";
import { scheduleExplorerInventory } from "../lib/explorer-inventory";
import { isValidTagsRegex } from "../lib/vcs-repo";
import { effectiveWorkspaceVariables } from "../lib/effective-variables";


type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

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
    readonly headers: Readonly<{ get(name: string): string | null }>;
  }>;
  readonly set: SetObj;
}>;

type WsItem = DeepReadonly<typeof workspaces.$inferSelect>;
type TagItem = DeepReadonly<typeof workspaceTags.$inferSelect>;
type VarItem = DeepReadonly<typeof workspaceVariables.$inferSelect>;
type WorkspaceVcsRepo = NonNullable<typeof workspaces.$inferSelect.vcsRepo>;
type DependencyGraphNode = Readonly<{ address: string; dependencies: readonly string[] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValues(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stateResourceAddress(resource: Record<string, unknown>): string | null {
  if (typeof resource["type"] !== "string" || typeof resource["name"] !== "string") return null;
  const module = typeof resource["module"] === "string" && resource["module"] !== "" ? `${resource["module"]}.` : "";
  const mode = resource["mode"] === "data" ? "data." : "";
  return `${module}${mode}${resource["type"]}.${resource["name"]}`;
}

function dependencyGraphFromState(statePayload: string | null): readonly DependencyGraphNode[] {
  if (statePayload === null) return [];
  const parsed = parseStatePayload(decodeStatePayload(statePayload));
  if (!isRecord(parsed) || !Array.isArray(parsed["resources"])) return [];

  const resources = new Map<string, Set<string>>();
  for (const value of parsed["resources"]) {
    if (!isRecord(value)) continue;
    const address = stateResourceAddress(value);
    if (address === null) continue;
    const dependencies = resources.get(address) ?? new Set<string>();
    stringValues(value["dependencies"]).forEach((dependency): void => { dependencies.add(dependency); });
    if (Array.isArray(value["instances"])) {
      for (const instance of value["instances"]) {
        if (isRecord(instance)) stringValues(instance["dependencies"]).forEach((dependency): void => { dependencies.add(dependency); });
      }
    }
    resources.set(address, dependencies);
  }

  const addresses = [...resources.keys()];
  const resolve = (reference: string): string | undefined => {
    if (resources.has(reference)) return reference;
    return addresses
      .filter((address): boolean => reference.startsWith(`${address}.`) || reference.startsWith(`${address}[`))
      .sort((left, right): number => right.length - left.length)[0];
  };
  return addresses.map((address): DependencyGraphNode => ({
    address,
    dependencies: [...new Set([...resources.get(address) ?? []]
      .map(resolve)
      .filter((dependency): dependency is string => dependency !== undefined && dependency !== address))],
  }));
}

const MAX_README_BYTES = 256 * 1024;
const README_ARCHIVE_TIMEOUT_MS = 5_000;

// Bound tar output so malformed archives cannot make the API buffer unbounded data.
async function readProcessOutput(process: Readonly<{
  exited: Promise<number>;
  stdout: Readonly<ReadableStream<Uint8Array>>;
  kill: (exitCode?: number | NodeJS.Signals) => void;
}>, maxBytes: number): Promise<string | null> {
  return readBoundedProcessOutput(process, maxBytes, README_ARCHIVE_TIMEOUT_MS);
}

async function readmeFromArchive(archivePath: string): Promise<string | null> {
  const listing = await readProcessOutput(
    Bun.spawn(["tar", "-tzf", archivePath], { stdout: "pipe", stderr: "ignore" }),
    MAX_ARCHIVE_METADATA_BYTES,
  );
  if (listing === null) return null;
  const member = listing
    .split("\n")
    .map((entry: string): string => entry.trim())
    .find((entry: string): boolean => entry === "README.md" || entry.endsWith("/README.md"));
  if (member === undefined) return null;

  const details = await readProcessOutput(
    Bun.spawn(["tar", "-tvzf", archivePath], { stdout: "pipe", stderr: "ignore" }),
    MAX_ARCHIVE_METADATA_BYTES,
  );
  if (details === null) return null;
  const detail = details.split("\n").find((entry: string): boolean => entry.trimEnd().endsWith(` ${member}`));
  if (detail?.trimStart().charAt(0) !== "-") return null;

  return readProcessOutput(
    Bun.spawn(["tar", "-xOzf", archivePath, "--", member], { stdout: "pipe", stderr: "ignore" }),
    MAX_README_BYTES,
  );
}

async function resourcePermissions(
  workspace: WsItem,
  userId: string | undefined,
  principalOrgId: string | null,
  teamId: string | null,
): Promise<WorkspaceResourcePermissions> {
  // One access-base load for the whole permission matrix instead of one per
  // level (the per-level derivation is pure in-memory afterwards).
  const sets = await workspacePermissionSets(workspace.orgId, userId, principalOrgId, teamId);
  const canManageOrgRunTasks = await checkOrganizationPermission(workspace.orgId, userId, principalOrgId, teamId, "manage-run-tasks");
  return {
    canPlan: workspaceAllows(sets.plan, workspace.id),
    canApply: workspaceAllows(sets.apply, workspace.id),
    canLock: workspaceAllows(sets.lock, workspace.id),
    canAdmin: workspaceAllows(sets.admin, workspace.id),
    canWriteVariables: workspaceAllows(sets.variablesWrite, workspace.id),
    canReadVariables: workspaceAllows(sets.variablesRead, workspace.id),
    canReadStateVersions: workspaceAllows(sets.stateRead, workspace.id),
    canWriteStateVersions: workspaceAllows(sets.stateWrite, workspace.id),
    canManageRunTasks: workspaceAllows(sets.runTasks, workspace.id) && canManageOrgRunTasks,
  };
}

/** Audit finding 9: single-workspace GETs must honor include=current_run
 * like the list endpoint does. Bounded to one row (newest run for this
 * workspace); undefined when not requested so the relationship stays out. */
async function currentRunForWorkspace(workspaceId: string, include: string): Promise<{ id: string } | null | undefined> {
  const wantsCurrentRun = include
    .split(",")
    .map((value: string): string => value.trim())
    .includes("current_run");
  if (!wantsCurrentRun) return undefined;
  const latest = await db.query.runs.findFirst({
    where: eq(runs.workspaceId, workspaceId),
    orderBy: [desc(runs.createdAt), asc(runs.id)],
    columns: { id: true },
  });
  return latest === undefined ? null : { id: latest.id };
}

function parseLockReason(body: unknown): Readonly<{ reason: string | null; error: string | null }> {
  if (body === undefined || body === null) return { reason: null, error: null };
  if (typeof body !== "object" || Array.isArray(body)) return { reason: null, error: "Lock reason must be a string" };
  const { attributes } = updateBodySections(body);
  const value = (body as Record<string, unknown>)["reason"] ?? attributes["reason"];
  if (value === undefined || value === null) return { reason: null, error: null };
  if (typeof value !== "string") return { reason: null, error: "Lock reason must be a string" };
  const reason = value.trim();
  if (reason.length > 300) return { reason: null, error: "Lock reason must be at most 300 characters" };
  return { reason: reason === "" ? null : reason, error: null };
}

function resolveVcsIdentifier(
  raw: Readonly<Record<string, unknown>>,
  existing: DeepReadonly<WorkspaceVcsRepo> | undefined,
): { identifier: string } | { error: string } {
  const identifierValue = raw["identifier"];
  const identifier = identifierValue === undefined
    ? existing?.identifier ?? ""
    : typeof identifierValue === "string" ? identifierValue.trim() : "";
  if (identifier === "") return { error: "Repository identifier is required" };
  return { identifier };
}

function resolveVcsCredential(
  raw: Readonly<Record<string, unknown>>,
  existing: DeepReadonly<WorkspaceVcsRepo> | undefined,
  dashedKey: string,
  field: "githubAppInstallationId" | "oauthTokenId",
): { id: string | undefined } | { error: string } {
  const value = Object.hasOwn(raw, dashedKey) ? raw[dashedKey] : raw[field];
  if (value !== undefined && value !== null && typeof value !== "string") {
    return { error: `${dashedKey} must be a string or null` };
  }
  return { id: value === null ? undefined : typeof value === "string" ? value.trim() : existing?.[field] };
}

function checkVcsCredentialPair(
  installationId: string | undefined,
  oauthTokenId: string | undefined,
): string | null {
  if ((installationId !== undefined && installationId !== "") && (oauthTokenId !== undefined && oauthTokenId !== "")) {
    return "A vcs-repo may contain either a GitHub App installation or an OAuth token, not both";
  }
  if ((installationId === undefined || installationId === "") && (oauthTokenId === undefined || oauthTokenId === "")) {
    return "A GitHub App installation or OAuth token is required";
  }
  return null;
}

async function checkVcsInstallation(
  database: typeof db,
  installationId: string | undefined,
  orgId: string,
): Promise<string | null> {
  if (installationId === undefined || installationId === "") return null;
  const installation = await database.query.githubAppInstallations.findFirst({
    where: and(eq(githubAppInstallations.id, installationId), eq(githubAppInstallations.orgId, orgId)),
  });
  if (installation === undefined) return "GitHub App installation is not registered in this organization";
  return null;
}

async function checkVcsOauthToken(
  database: typeof db,
  oauthTokenId: string | undefined,
  orgId: string,
): Promise<string | null> {
  if (oauthTokenId === undefined || oauthTokenId === "") return null;
  let token = await database.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, oauthTokenId) });
  if (token !== undefined && isPostgres) {
    const execute = (database as unknown as { execute: (query: unknown) => Promise<unknown> }).execute.bind(database);
    // Match deletion's client-before-token lock order, then re-read after
    // waiting so a delete that won the race cannot leave a JSON reference.
    await execute(sql`SELECT id FROM oauth_clients WHERE id = ${token.oauthClientId} FOR KEY SHARE`);
    await execute(sql`SELECT id FROM oauth_tokens WHERE id = ${oauthTokenId} FOR KEY SHARE`);
    token = await database.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, oauthTokenId) });
  }
  const client = token === undefined
    ? undefined
    : await database.query.oauthClients.findFirst({
        where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, orgId)),
      });
  if (client === undefined) return "OAuth token is not registered in this organization";
  return null;
}

function resolveVcsTagsRegex(
  raw: Readonly<Record<string, unknown>>,
  existing: DeepReadonly<WorkspaceVcsRepo> | undefined,
): { tagsRegex: string | undefined } | { error: string } {
  const tagsRegexValue = raw["tags-regex"] ?? raw["tagsRegex"];
  if (tagsRegexValue !== undefined && tagsRegexValue !== null && typeof tagsRegexValue !== "string") {
    return { error: "tags-regex must be a string or null" };
  }
  const tagsRegex = tagsRegexValue === null
    ? undefined
    : typeof tagsRegexValue === "string" ? tagsRegexValue : existing?.tagsRegex;
  if (tagsRegex === undefined) return { tagsRegex };
  if (tagsRegex.length > 256) return { error: "tags-regex must be at most 256 characters" };
  if (!isValidTagsRegex(tagsRegex)) return { error: "tags-regex must be a valid, non-pathological regular expression" };
  return { tagsRegex };
}

function validateVcsBranchField(branchValue: unknown): string | null {
  if (branchValue !== undefined && branchValue !== null && typeof branchValue !== "string") {
    return "branch must be a string or null";
  }
  return null;
}

function validateVcsIngressField(ingressValue: unknown): string | null {
  if (ingressValue !== undefined && typeof ingressValue !== "boolean") {
    return "ingress-submodules must be a boolean";
  }
  return null;
}

function assembleVcsRepoValue(args: Readonly<{
  identifier: string;
  branchValue: unknown;
  ingressValue: unknown;
  oauthTokenId: string | undefined;
  installationId: string | undefined;
  tagsRegex: string | undefined;
  existing: DeepReadonly<WorkspaceVcsRepo> | undefined;
}>): WorkspaceVcsRepo {
  const value: WorkspaceVcsRepo = { identifier: args.identifier };
  const branch = args.branchValue === null
    ? undefined
    : typeof args.branchValue === "string" ? args.branchValue : args.existing?.branch;
  const ingressSubmodules = typeof args.ingressValue === "boolean" ? args.ingressValue : args.existing?.ingressSubmodules;
  if (branch !== undefined) value.branch = branch;
  if (args.oauthTokenId !== undefined && args.oauthTokenId !== "") value.oauthTokenId = args.oauthTokenId;
  if (args.installationId !== undefined && args.installationId !== "") value.githubAppInstallationId = args.installationId;
  if (ingressSubmodules !== undefined) value.ingressSubmodules = ingressSubmodules;
  if (args.tagsRegex !== undefined) value.tagsRegex = args.tagsRegex;
  const cloneUrl: unknown = args.existing?.cloneUrl;
  if (typeof cloneUrl === "string") value.cloneUrl = cloneUrl;
  return value;
}

async function normalizeVcsRepo(
  input: unknown,
  orgId: string,
  existing?: DeepReadonly<WorkspaceVcsRepo>,
  database: typeof db = db,
): Promise<Readonly<{ value: WorkspaceVcsRepo | null }> | Readonly<{ error: string }>> {
  if (input === null) return { value: null };
  if (typeof input !== "object") return { error: "vcs-repo must be an object or null" };
  const raw = input as Record<string, unknown>;

  const identifier = resolveVcsIdentifier(raw, existing);
  if ("error" in identifier) return identifier;
  const installation = resolveVcsCredential(raw, existing, "github-app-installation-id", "githubAppInstallationId");
  if ("error" in installation) return installation;
  const oauth = resolveVcsCredential(raw, existing, "oauth-token-id", "oauthTokenId");
  if ("error" in oauth) return oauth;
  const pairError = checkVcsCredentialPair(installation.id, oauth.id);
  if (pairError !== null) return { error: pairError };
  const installationError = await checkVcsInstallation(database, installation.id, orgId);
  if (installationError !== null) return { error: installationError };
  const oauthError = await checkVcsOauthToken(database, oauth.id, orgId);
  if (oauthError !== null) return { error: oauthError };

  const branchValue = raw["branch"];
  const branchError = validateVcsBranchField(branchValue);
  if (branchError !== null) return { error: branchError };
  const tags = resolveVcsTagsRegex(raw, existing);
  if ("error" in tags) return tags;
  const ingressValue = raw["ingress-submodules"] ?? raw["ingressSubmodules"];
  const ingressError = validateVcsIngressField(ingressValue);
  if (ingressError !== null) return { error: ingressError };

  return {
    value: assembleVcsRepoValue({
      identifier: identifier.identifier,
      branchValue,
      ingressValue,
      oauthTokenId: oauth.id,
      installationId: installation.id,
      tagsRegex: tags.tagsRegex,
      existing,
    }),
  };
}

// Attach the workspace's latest state outputs (type "workspace-outputs") to a
// workspace resource when the caller requests ?include=outputs (go-tfe's
// tfe_outputs data source). Returns the enriched resource plus included docs.
// Callers must already enforce workspace read access; outputs ride along for
// any reader (matches the reference format, where workspace readers can read outputs; covered
// by the team-token workspace authorization test).
async function maybeAttachOutputs(
  data: Record<string, unknown>,
  workspace: WsItem,
  includeParam: string,
): Promise<{ data: Record<string, unknown>; included?: Record<string, unknown>[] }> {
  const includes = includeParam.split(",").map((s): string => s.trim());
  if (!includes.includes("outputs")) return { data };
  const sv = await db.query.stateVersions.findFirst({
    where: and(
      eq(stateVersions.workspaceId, workspace.id),
      eq(stateVersions.status, "finalized"),
      eq(stateVersions.intermediate, false),
    ),
    orderBy: [desc(stateVersions.serial)],
  });
  if (sv === undefined) return { data };
  if (isClientEncryptedState(sv.statePayload)) {
    return { data: { ...data, relationships: {
      ...(data["relationships"] as Record<string, unknown>),
      outputs: { data: null, meta: { "unavailable-reason": CLIENT_ENCRYPTED_STATE_ERROR } },
    } } };
  }
  const outputs = workspaceOutputResources(sv);
  const dataWithRels = data as { relationships?: Record<string, unknown> };
  dataWithRels.relationships = {
    ...(dataWithRels.relationships ?? {}),
    outputs: {
      data: outputs.map((o: Record<string, unknown>): Record<string, string> => ({ id: String(o["id"]), type: "workspace-outputs" })),
      links: { related: `/api/v2/workspaces/${workspace.id}/current-state-version-outputs` },
    },
  };
  return { data: dataWithRels, included: outputs };
}

function isRelationshipIdentifier(value: unknown, expectedType: string): value is { id: string; type: string } {
  return value !== null
    && typeof value === "object"
    && typeof (value as Record<string, unknown>)["id"] === "string"
    && (value as Record<string, unknown>)["id"] !== ""
    && (value as Record<string, unknown>)["type"] === expectedType;
}

async function validatedRemoteStateConsumerIds(
  workspaceId: string,
  orgId: string,
  items: readonly unknown[],
): Promise<string[] | null> {
  const ids: string[] = [];
  for (const item of items) {
    if (!isRelationshipIdentifier(item, "workspaces")) return null;
    ids.push(item.id);
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const candidates = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, uniqueIds),
    columns: { id: true, orgId: true },
  });
  const byId = new Map(candidates.map((candidate): [string, Readonly<{ id: string; orgId: string }>] => [candidate.id, candidate]));
  return uniqueIds.every((id): boolean => id !== workspaceId && byId.get(id)?.orgId === orgId) ? uniqueIds : null;
}
type LatestRunRow = Readonly<{
  id: string;
  workspaceId: string;
  status: string;
  message: string | null;
  // SQLite returns raw 0/1 integers; postgres.js returns bigint columns
  // as strings. Normalize with Number() at the consumption site.
  isDestroy: number | string;
  createdAt: number | string;
  autoApply: number | string;
}>;

function csvParam(searchParams: URLSearchParams, name: string): string[] {
  return [...new Set(searchParams.get(name)?.split(",").filter(Boolean) ?? [])];
}

function resolveListSortAndLocked(searchParams: URLSearchParams): { sort: string; locked: string | null } | { error: string } {
  const sort = searchParams.get("sort") ?? "name";
  const locked = searchParams.get("filter[locked]");
  if (!["name", "-name"].includes(sort) || (locked !== null && locked !== "true" && locked !== "false")) {
    return { error: "sort must be name or -name; filter[locked] must be true or false." };
  }
  return { sort, locked };
}

function allowedWorkspaceCondition(allowedWorkspaceIds: ReadonlySet<string> | null): unknown {
  if (allowedWorkspaceIds === null) return null;
  return allowedWorkspaceIds.size > 0
    ? inArray(workspaces.id, [...allowedWorkspaceIds])
    : eq(workspaces.id, "__no_authorized_workspace__");
}

function pageTotal(countRows: readonly { total: number }[]): number {
  return countRows[0]?.total ?? 0;
}

function collectListTextFilters(searchParams: URLSearchParams): unknown[] {
  const found: unknown[] = [];
  const query = searchParams.get("search[query]")?.trim();
  if (query !== undefined && query !== "") {
    // An escaped literal substring matches the same names/tags as the list UI.
    const pattern = `%${query.replace(/[!%_]/g, "!$&")}%`;
    const match = isPostgres ? sql`ILIKE` : sql`LIKE`;
    found.push(sql`(${workspaces.name} ${match} ${pattern} ESCAPE '!'
      OR EXISTS (SELECT 1 FROM workspace_tags WHERE workspace_id = ${workspaces.id}
        AND key ${match} ${pattern} ESCAPE '!'))`);
  }
  const search = searchParams.get("search[name]")?.trim() ?? searchParams.get("q")?.trim();
  if (search !== undefined && search !== "") found.push(caseInsensitiveLike(workspaces.name, `%${search}%`));
  return found;
}

async function collectListTagFilters(searchParams: URLSearchParams): Promise<unknown[]> {
  const found: unknown[] = [];
  const tags = csvParam(searchParams, "search[tags]");
  if (tags.length > 0) {
    const tagRows = await db.query.workspaceTags.findMany({
      where: inArray(workspaceTags.key, [...new Set(tags)]),
      columns: { key: true, workspaceId: true },
    });
    const idsByTag = new Map<string, string[]>();
    for (const row of tagRows) {
      const ids = idsByTag.get(row.key);
      if (ids === undefined) idsByTag.set(row.key, [row.workspaceId]);
      else ids.push(row.workspaceId);
    }
    for (const tag of tags) {
      const workspaceIds = idsByTag.get(tag) ?? [];
      found.push(workspaceIds.length > 0
        ? inArray(workspaces.id, [...new Set(workspaceIds)])
        : eq(workspaces.id, "__no_matching_workspace__"));
    }
  }
  const excludeTags = csvParam(searchParams, "search[exclude-tags]");
  if (excludeTags.length > 0) {
    const excludedIds = (await db.query.workspaceTags.findMany({
      where: inArray(workspaceTags.key, excludeTags),
      columns: { workspaceId: true },
    })).map((t: Readonly<{ workspaceId: string }>): string => t.workspaceId);
    found.push(notInArray(workspaces.id, [...new Set(excludedIds)]));
  }
  const projectIds = csvParam(searchParams, "filter[project][id]");
  if (projectIds.length > 0) found.push(inArray(workspaces.projectId, projectIds));
  return found;
}

async function collectListTaggedBindingFilters(searchParams: URLSearchParams): Promise<unknown[]> {
  const tagged = new Map<number, { key?: string; value?: string }>();
  for (const [name, value] of searchParams) {
    const match = /^filter\[tagged\]\[(\d+)\]\[(key|value)\]$/.exec(name);
    if (match === null) continue;
    const index = Number(match[1]);
    const field = match[2];
    if (!Number.isSafeInteger(index) || (field !== "key" && field !== "value")) continue;
    tagged.set(index, { ...tagged.get(index), [field]: value });
  }
  const tagBindings = [...tagged.values()].filter(
    (binding): binding is { key: string; value: string } =>
      typeof binding.key === "string" && binding.key !== ""
      && typeof binding.value === "string",
  );
  const bindingKeys = [...new Set(tagBindings.map((binding: Readonly<{ key: string }>): string => binding.key))];
  const singleBinding = tagBindings.length === 1 ? tagBindings[0] : undefined;
  const taggedWorkspaceTagRows = bindingKeys.length === 0
    ? []
    : (await db.query.workspaceTags.findMany({
      where: singleBinding === undefined
        ? inArray(workspaceTags.key, bindingKeys)
        : and(eq(workspaceTags.key, singleBinding.key), eq(workspaceTags.value, singleBinding.value)),
      columns: { workspaceId: true, key: true, value: true },
    }));
  // Index rows by "key\0value" so we need exactly one query regardless of
  // how many tag bindings the caller supplied.
  const workspaceIdsByTag = new Map<string, string[]>();
  for (const row of taggedWorkspaceTagRows) {
    const tag = `${row.key}\u0000${row.value ?? ""}`;
    const list = workspaceIdsByTag.get(tag) ?? [];
    list.push(row.workspaceId);
    workspaceIdsByTag.set(tag, list);
  }
  const matchingTagIds = tagBindings.map((binding: Readonly<{ key: string; value: string }>): string[] =>
    workspaceIdsByTag.get(`${binding.key}\u0000${binding.value}`) ?? [],
  );
  const found: unknown[] = [];
  for (const workspaceIds of matchingTagIds) {
    found.push(workspaceIds.length > 0
      ? inArray(workspaces.id, [...new Set(workspaceIds)])
      : eq(workspaces.id, "__no_matching_workspace__"));
  }
  return found;
}

type WorkspaceListPageData = Readonly<{
  tagRows: DeepReadonly<typeof workspaceTags.$inferSelect>[];
  latestRunRows: LatestRunRow[];
  currentRunsByWorkspace: ReadonlyMap<string, LatestRunRow>;
  tagsByWorkspace: ReadonlyMap<string, DeepReadonly<typeof workspaceTags.$inferSelect>[]>;
}>;

async function loadWorkspaceListPageData(
  wsList: WsItem[],
  includeCurrentRun: boolean,
): Promise<WorkspaceListPageData> {
  // Batch the per-row N+1 (workspace_tags + org name): one query for the
  // whole page instead of two per workspace.
  const tagRows = wsList.length === 0
    ? []
    : await db.query.workspaceTags.findMany({
      where: inArray(workspaceTags.workspaceId, wsList.map((w: WsItem): string => w.id)),
      orderBy: [asc(workspaceTags.key)],
    });
  // Server-side latest-run aggregation (10.1/10.4): when the caller asks
  // for include=current_run, resolve the newest run per workspace of the
  // current page IN SQL (ROW_NUMBER window over runs(workspace_id,
  // created_at), rowid ASC tie-break) instead of transferring org-wide run
  // history. The same query shape as the current-run status filter above.
  const latestRunRows: LatestRunRow[] = includeCurrentRun && wsList.length > 0
    ? await rawQueryAll<LatestRunRow>(sql`
        SELECT id, workspace_id AS "workspaceId", status, message,
               is_destroy AS "isDestroy", created_at AS "createdAt",
               auto_apply AS "autoApply"
        FROM (
          SELECT id, workspace_id, status, message, is_destroy, created_at,
                 auto_apply,
                 ROW_NUMBER() OVER (
                   PARTITION BY workspace_id ORDER BY created_at DESC, id ASC
                 ) AS rn
          FROM runs
          WHERE ${inArray(runs.workspaceId, wsList.map((w: WsItem): string => w.id))}
        )
        WHERE rn = 1
      `)
    : [];
  const currentRunsByWorkspace = new Map(latestRunRows.map((row): [string, LatestRunRow] => [row.workspaceId, row]));
  const tagsByWorkspace = new Map<string, DeepReadonly<typeof workspaceTags.$inferSelect>[]>();
  for (const tag of tagRows) {
    const list = tagsByWorkspace.get(tag.workspaceId) ?? [];
    list.push(tag);
    tagsByWorkspace.set(tag.workspaceId, list);
  }
  return { tagRows, latestRunRows, currentRunsByWorkspace, tagsByWorkspace };
}

function summarizeWorkspaceList(
  summaryRows: readonly { locked: boolean | number; status: string | null; total: number | string }[],
): { total: number; locked: number; "run-statuses": Record<string, number> } {
  const summary = { total: 0, locked: 0, "run-statuses": {} as Record<string, number> };
  for (const row of summaryRows) {
    const total = Number(row.total);
    summary.total += total;
    if (row.locked === true || row.locked === 1) summary.locked += total;
    if (row.status !== null) summary["run-statuses"][row.status] = (summary["run-statuses"][row.status] ?? 0) + total;
  }
  return summary;
}

export const workspaceRoutes = new Elysia({ name: "workspaces" })
  .use(authPlugin)
  // --- Organization Workspaces ---
  .get("/api/v2/organizations/:org_name/workspaces", async ({ params, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const actor = actorScope(user, principalOrgId, teamId);
    if (!(await checkOrgPermission(actor.actorId, org.id, "member", actor.actorOrgId, actor.actorTeamId))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const searchParams = new URL(request.url).searchParams;
    const conditions: unknown[] = [eq(workspaces.orgId, org.id)];
    const permSets = await workspacePermissionSets(org.id, actor.actorId, actor.actorOrgId, actor.actorTeamId);
    const allowedWorkspaceIds = permSets.read;
    const allowedCondition = allowedWorkspaceCondition(allowedWorkspaceIds);
    if (allowedCondition !== null) conditions.push(allowedCondition);
    const sortAndLocked = resolveListSortAndLocked(searchParams);
    if ("error" in sortAndLocked) return failWorkspaceUpdate(set, 400, sortAndLocked.error);
    const authorizedWhere = and(...(conditions as Parameters<typeof and>));
    const latestRunStatus = sql<string | null>`(
      SELECT status FROM runs WHERE workspace_id = ${workspaces.id}
      ORDER BY created_at DESC, id ASC LIMIT 1
    )`;
    if (sortAndLocked.locked !== null) conditions.push(eq(workspaces.locked, sortAndLocked.locked === "true"));
    conditions.push(...collectListTextFilters(searchParams));
    conditions.push(...(await collectListTagFilters(searchParams)));
    conditions.push(...(await collectListTaggedBindingFilters(searchParams)));
    const currentRunStatuses = csvParam(searchParams, "filter[current-run][status]");
    if (currentRunStatuses.length > 0) conditions.push(inArray(latestRunStatus, currentRunStatuses));
    const includeSummary = (searchParams.get("include") ?? "").split(",").includes("workspace_summary");
    const where = and(...(conditions as Parameters<typeof and>));
    const [wsList, countRows, summaryRows] = await Promise.all([
      db.query.workspaces.findMany({ where, orderBy: [sortAndLocked.sort === "-name" ? desc(workspaces.name) : asc(workspaces.name), asc(workspaces.id)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(workspaces).where(where),
      includeSummary
        ? rawQueryAll<{ locked: boolean | number; status: string | null; total: number | string }>(sql`
            SELECT locked, status, COUNT(*) AS total FROM (
              SELECT ${workspaces.locked} AS locked, ${latestRunStatus} AS status
              FROM workspaces WHERE ${authorizedWhere}
            ) AS visible_workspaces GROUP BY locked, status
          `)
        : Promise.resolve([]),
    ]);
    const totalCount = pageTotal(countRows);
    const canManageOrgRunTasks = await checkOrganizationPermission(org.id, actor.actorId, actor.actorOrgId, actor.actorTeamId, "manage-run-tasks");
    const includeCurrentRun = (searchParams.get("include") ?? "")
      .split(",")
      .map((value: string): string => value.trim())
      .includes("current_run");
    const pageData = await loadWorkspaceListPageData(wsList, includeCurrentRun);
    const { latestRunRows, currentRunsByWorkspace, tagsByWorkspace } = pageData;
    const data = await Promise.all(wsList.map(async (w: WsItem): Promise<Record<string, unknown>> => {
      const baseOptions = {
        orgName: org.name,
        tags: tagsByWorkspace.get(w.id) ?? [],
      };
      const resourceOptions = includeCurrentRun
        ? { ...baseOptions, currentRun: currentRunsByWorkspace.get(w.id) ?? null }
        : baseOptions;
      return workspaceResource(w, org.defaultIacBinary, {
        canAdmin: workspaceAllows(permSets.admin, w.id),
        canApply: workspaceAllows(permSets.apply, w.id),
        canLock: workspaceAllows(permSets.lock, w.id),
        canManageRunTasks: canManageOrgRunTasks && workspaceAllows(permSets.runTasks, w.id),
        canPlan: workspaceAllows(permSets.plan, w.id),
        canReadStateVersions: workspaceAllows(permSets.stateRead, w.id),
        canWriteStateVersions: workspaceAllows(permSets.stateWrite, w.id),
        canReadVariables: workspaceAllows(permSets.variablesRead, w.id),
        canWriteVariables: workspaceAllows(permSets.variablesWrite, w.id),
      }, resourceOptions);
    }));
    const included = includeCurrentRun
      ? latestRunRows.map((run: LatestRunRow): Record<string, unknown> => ({
          id: run.id,
          type: "runs",
          attributes: {
            status: run.status,
            message: run.message,
            "created-at": new Date(Number(run.createdAt)).toISOString(),
            // Normalize the raw SQLite 0/1 integers (and postgres.js bigint
            // strings) to booleans.
            "is-destroy": Number(run.isDestroy) === 1,
            "auto-apply": Number(run.autoApply) === 1,
          },
          relationships: {
            workspace: { data: { id: run.workspaceId, type: "workspaces" } },
          },
        }))
      : undefined;
    const page = pagination(request, number, size, totalCount);
    const summary = summarizeWorkspaceList(summaryRows);
    return {
      data, ...(included === undefined ? {} : { included }), ...page,
      meta: { ...page.meta, ...(includeSummary ? { "workspace-summary": summary } : {}) },
    };
  })
  .post("/api/v2/organizations/:org_name/workspaces", async ({ params, body, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const actor = actorScope(user, principalOrgId, teamId);
    if (!(await checkOrganizationPermission(org.id, actor.actorId, actor.actorOrgId, actor.actorTeamId, "manage-workspaces"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const parsed = parseWorkspaceUpdateBody(body);
    const attributes = parsed.attributes;
    const preambleError = validateCreatePreamble(attributes);
    if (preambleError !== null) return failWorkspaceUpdate(set, 422, preambleError);
    const nameResult = await resolveCreateNameAndDup(parsed, org.id);
    if ("error" in nameResult) return failWorkspaceUpdate(set, nameResult.status, nameResult.error);
    const fieldTypesError = validateCreateFieldTypes(attributes, parsed.executionMode);
    if (fieldTypesError !== null) return failWorkspaceUpdate(set, 422, fieldTypesError);
    const workingDirAndTags = await resolveCreateWorkingDirAndTags(attributes, parsed.rels);
    if ("error" in workingDirAndTags) return failWorkspaceUpdate(set, 422, workingDirAndTags.error);
    const id = newResourceId("ws");
    const execution = await resolveCreateExecutionChain({
      rels: parsed.rels,
      orgId: org.id,
      rawSettingOverwrites: attributes["setting-overwrites"],
      executionMode: parsed.executionMode,
      rawAgentPoolId: parsed.rawAgentPoolId,
      workspaceId: id,
    });
    if ("error" in execution) return failWorkspaceUpdate(set, 422, execution.error);
    const durationError = validateCreateDuration(attributes);
    if (durationError !== null) return failWorkspaceUpdate(set, 422, durationError);
    // Boundary narrowing: validateCreatePreamble/validateCreateDuration
    // already rejected non-string ownership and duration values.
    const autoDestroyDuration = attributes["auto-destroy-activity-duration"] as string | null | undefined;
    const ownedById = attributes["owned-by-id"] as string | null | undefined;
    const contactEmail = attributes["contact-email"] as string | null | undefined;
    const inheritsProjectAutoDestroy = autoDestroyDuration === undefined;
    const lockedTagKey = await findLockedInheritedTagKey(org.id, execution.project.id, tagBindingKeys(workingDirAndTags.tagBindings));
    if (lockedTagKey !== undefined) return failWorkspaceUpdate(set, 422, `Tag key "${lockedTagKey}" cannot override its inherited project tag`);
    const row = buildWorkspaceCreateRow({
      attributes,
      id,
      orgId: org.id,
      name: nameResult.name,
      project: execution.project,
      mode: execution.mode,
      poolId: execution.poolId,
      settingOverwrites: execution.settingOverwrites,
      dir: workingDirAndTags.dir,
      inheritsProjectAutoDestroy,
      autoDestroyDuration,
      ownedById,
      contactEmail,
      terraformVersionHeader: request.headers.get("terraform-version"),
      orgDefaultIacBinary: org.defaultIacBinary,
    });
    const vcsError = await db.transaction(async (tx): Promise<string | null> => insertWorkspaceTx(tx, {
      row,
      vcsRepo: attributes["vcs-repo"],
      orgId: org.id,
      workspaceId: id,
      tagBindings: workingDirAndTags.tagBindings,
    }));
    if (vcsError !== null) return failWorkspaceUpdate(set, 422, vcsError);
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    scheduleExplorerInventory(ws.id);
    await auditLog("create", "workspaces", id, actor.actorId ?? null, org.id, {
      name: ws.name,
      projectId: ws.projectId,
    });
    (set as { status: number }).status = 201;
    return {
      data: await workspaceResource(
        ws,
        org.defaultIacBinary,
        await resourcePermissions(ws, actor.actorId, actor.actorOrgId, actor.actorTeamId),
        { orgName: org.name },
      ),
    };
  })
  .get("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params, user, orgId: principalOrgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const workspaceName = params["workspace_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    const runScoped = run !== undefined && run !== null && ws !== undefined && run.workspaceId === ws.id;
    if (ws === undefined || (!runScoped && !(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "read")))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const currentRunByName = await currentRunForWorkspace(ws.id, new URL(request.url).searchParams.get("include") ?? "");
    const data = await workspaceResource(
      ws,
      org.defaultIacBinary,
      await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
      { orgName: org.name, ...(currentRunByName === undefined ? {} : { currentRun: currentRunByName }) },
    );
    return maybeAttachOutputs(data, ws, new URL(request.url).searchParams.get("include") ?? "");
  })
  .patch("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params, body, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const workspaceName = params["workspace_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    {
      const ifMatch = request.headers.get("if-match");
      if (ifMatch !== null && ifMatch.trim() !== "*") {
        const currentResource = await workspaceResource(
          ws,
          org.defaultIacBinary,
          await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
          { orgName: org.name },
        );
        if (!ifMatchSatisfied(request, { data: currentResource })) { (set as { status: number }).status = 412; return { errors: [{ status: "412", title: "Precondition Failed" }] }; }
      }
    }
    return updateWorkspaceResponse(
      ws,
      org.defaultIacBinary,
      { userId: user?.id, principalOrgId: principalOrgId ?? null, teamId: teamId ?? null },
      body,
      set,
      org.name,
    );
  })
  .delete("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const workspaceName = params["workspace_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    await deleteWorkspace(ws.id);
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .post("/api/v2/organizations/:org_name/workspaces/:workspace_name/actions/safe-delete", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const workspaceName = params["workspace_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ok = await safeDeleteWorkspace(ws.id);
    if (!ok) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace contains managed resources" }] }; }
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .get("/api/v2/workspaces/:workspace_id", async ({ params, user, orgId: principalOrgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const runScoped = run !== undefined && run !== null && run.workspaceId === workspaceId;
    const ws = runScoped
      ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
      : await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await cachedOrgById(ws.orgId);
    const currentRunById = await currentRunForWorkspace(ws.id, new URL(request.url).searchParams.get("include") ?? "");
    const data = await workspaceResource(
      ws,
      org?.defaultIacBinary,
      await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
      { orgName: org?.name ?? null, ...(currentRunById === undefined ? {} : { currentRun: currentRunById }) },
    );
    return maybeAttachOutputs(data, ws, new URL(request.url).searchParams.get("include") ?? "");
  })
  .get("/api/v2/workspaces/:workspace_id/resources", async ({ params, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "state-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const latestState = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, ws.id),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    });

    const resources: Record<string, unknown>[] = [];
    // Prefer jsonState (parsed at record time); fall back to parsing the raw
    // statePayload so older versions (recorded before jsonState existed) still
    // render their resources.
    if (latestState !== undefined) {
      if (isClientEncryptedState(latestState.statePayload)) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unsupported state representation", detail: CLIENT_ENCRYPTED_STATE_ERROR }] };
      }
      const jsonStateSource = latestState.jsonState ?? latestState.statePayload ?? null;
      if (jsonStateSource !== null) {
        try {
          const parsed: unknown = typeof jsonStateSource === "string"
            ? JSON.parse(decodeStatePayload(jsonStateSource)) as unknown
            : jsonStateSource;
          const rawResources = parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)["resources"]
            : undefined;
          const resList = Array.isArray(rawResources) ? rawResources : [];
          const dateStr = new Date(latestState.createdAt).toISOString().split("T")[0];

          for (const r of resList) {
            if (r !== null && typeof r === "object") {
              const rObj = r as Record<string, unknown>;
              const rType = typeof rObj["type"] === "string" ? rObj["type"] : "resource";
              const rName = typeof rObj["name"] === "string" ? rObj["name"] : "unnamed";
              const mod = typeof rObj["module"] === "string" && rObj["module"] !== "" ? rObj["module"] : "root";
              const address = mod === "root" ? `${rType}.${rName}` : `${mod}.${rType}.${rName}`;

              let provider = "hashicorp/provider";
              if (typeof rObj["provider"] === "string") {
                const match = /provider\["([^"]+)"\]/.exec(rObj["provider"]);
                const providerName = match?.[1];
                if (typeof providerName === "string" && providerName !== "") provider = providerName;
              }

              const id = `wsr-${Bun.hash(`${ws.id}:${address}`).toString(36)}`;
              resources.push({
                id,
                type: "resources",
                attributes: {
                  address,
                  name: rName,
                  "created-at": dateStr,
                  "updated-at": dateStr,
                  module: mod,
                  provider,
                  "provider-type": rType,
                  "modified-by-state-version-id": latestState.id,
                  "name-index": null,
                },
              });
            }
          }
        } catch {}
      }
    }

    const { number, size } = pageRequest(request);
    const total = resources.length;
    const paginated = resources.slice((number - 1) * size, number * size);
    return { data: paginated, ...pagination(request, number, size, total) };
  })
  .get("/api/v2/workspaces/:workspace_id/dependency-graph", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "state-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const state = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, workspaceId),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    });
    if (state === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (isClientEncryptedState(state.statePayload)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unsupported state representation", detail: CLIENT_ENCRYPTED_STATE_ERROR }] };
    }
    const nodes = dependencyGraphFromState(state.jsonState ?? state.statePayload);
    const addresses = new Set(nodes.map((node): string => node.address));
    const edges = nodes.flatMap((node): readonly { from: string; to: string }[] => node.dependencies
      .filter((dependency): boolean => addresses.has(dependency))
      .map((dependency): { from: string; to: string } => ({ from: dependency, to: node.address })));
    return {
      data: {
        id: `dependency-graph-${state.id}`,
        type: "dependency-graphs",
        attributes: {
          nodes,
          edges,
          "state-version-id": state.id,
          serial: state.serial,
          "created-at": new Date(state.createdAt).toISOString(),
        },
      },
    };
  })
  .get("/api/v2/workspaces/:workspace_id/readme", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "state-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const latestRun = await db.query.runs.findFirst({
      where: eq(runs.workspaceId, workspaceId),
      orderBy: [desc(runs.createdAt), asc(runs.id)],
    });
    const configurationVersionId = latestRun?.configurationVersionId;
    if (latestRun === undefined || configurationVersionId === null || configurationVersionId === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const configuration = await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, configurationVersionId),
    });
    if (configuration?.archivePath === null || configuration?.archivePath === undefined || !(await Bun.file(configuration.archivePath).exists())) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const content = await readmeFromArchive(configuration.archivePath);
    if (content === null) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: `readme-${latestRun.id}`,
        type: "readmes",
        attributes: {
          content,
          "run-id": latestRun.id,
          "created-at": new Date(latestRun.createdAt).toISOString(),
        },
      },
    };
  })
  .patch("/api/v2/workspaces/:workspace_id", async ({ params, body, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await cachedOrgById(ws.orgId);
    const ifMatch = request.headers.get("if-match");
    if (ifMatch !== null && ifMatch.trim() !== "*") {
      const currentResource = await workspaceResource(
        ws,
        org?.defaultIacBinary,
        await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
        { orgName: org?.name ?? null },
      );
      if (!ifMatchSatisfied(request, { data: currentResource })) { (set as { status: number }).status = 412; return { errors: [{ status: "412", title: "Precondition Failed" }] }; }
    }
    return updateWorkspaceResponse(
      ws,
      org?.defaultIacBinary,
      { userId: user?.id, principalOrgId: principalOrgId ?? null, teamId: teamId ?? null },
      body,
      set,
      org?.name ?? null,
    );
  })
  .delete("/api/v2/workspaces/:workspace_id", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    await deleteWorkspace(ws.id);
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .post("/api/v2/workspaces/:workspace_id/actions/safe-delete", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ok = await safeDeleteWorkspace(ws.id);
    if (!ok) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace contains managed resources" }] }; }
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  // --- Tags ---
  .get("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId), orderBy: [asc(workspaceTags.key)] });
    return { data: tags.map((t: TagItem): Record<string, unknown> => tagBindingResource(t)) };
  })
  .get("/api/v2/workspaces/:workspace_id/effective-tag-bindings", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [tags, inheritedTags] = await Promise.all([
      db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId) }),
      ws.projectId === null
        ? Promise.resolve([])
        : db.query.projectTags.findMany({ where: eq(projectTags.projectId, ws.projectId) }),
    ]);
    const effective = new Map<string, TagItem>();
    for (const tag of inheritedTags) {
      effective.set(tag.key, { id: tag.id, workspaceId, key: tag.key, value: tag.value });
    }
    for (const tag of tags) effective.set(tag.key, tag);
    return {
      data: [...effective.values()]
        .sort((a: TagItem, b: TagItem): number => a.key.localeCompare(b.key))
        .map((tag: TagItem): Record<string, unknown> => tagBindingResource(tag, true)),
    };
  })
  .patch("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"];
    const tags = Array.isArray(data) ? data : (data !== null && data !== undefined ? [data] : []);
    const entries = tags.map((t: unknown): { key: string; value: string } => {
      const item = t !== null && typeof t === "object" ? (t as Record<string, unknown>) : {};
      const attrs = typeof item["attributes"] === "object" && item["attributes"] !== null ? (item["attributes"] as Record<string, unknown>) : {};
      const key = typeof attrs["key"] === "string" ? attrs["key"] : "";
      const value = typeof attrs["value"] === "string" ? attrs["value"] : "";
      return { key, value };
    }).filter((e: Readonly<{ readonly key: string; readonly value: string }>): boolean => e.key !== "");
    const lockedTagKey = await findLockedInheritedTagKey(ws.orgId, ws.projectId, entries.map((entry): string => entry.key));
    if (lockedTagKey !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Tag key "${lockedTagKey}" cannot override its inherited project tag` }] };
    }
    // Single upsert: insert new tag keys and update values for existing ones
    // in one statement, replacing the per-entry INSERT/UPDATE loop.
    await db.insert(workspaceTags).values(
      entries.map((entry: Readonly<{ readonly key: string; readonly value: string }>): typeof workspaceTags.$inferInsert => ({
        id: crypto.randomUUID(),
        workspaceId,
        key: entry.key,
        value: entry.value,
      })),
    ).onConflictDoUpdate({
      target: [workspaceTags.workspaceId, workspaceTags.key],
      set: { value: sql`excluded.value` },
    });

    const updatedTags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId), orderBy: [asc(workspaceTags.key)] });
    return { data: updatedTags.map((t: TagItem): Record<string, unknown> => tagBindingResource(t)) };
  })
  .get("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId) });
    return { data: tags.map((t: TagItem): Record<string, string> => ({ id: t.key, type: "tags" })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params, body, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload["data"];
    const entries = new Map<string, string>();
    for (const item of Array.isArray(items) ? items : []) {
      if (item !== null && typeof item === "object") {
        const itemObj = item as Record<string, unknown>;
        const attrs = typeof itemObj["attributes"] === "object" && itemObj["attributes"] !== null ? (itemObj["attributes"] as Record<string, unknown>) : {};
        const keyVal = attrs["key"] ?? itemObj["id"];
        const key = typeof keyVal === "string" ? keyVal : "";
        if (key !== "") entries.set(key, typeof attrs["value"] === "string" ? attrs["value"] : "");
      }
    }
    const lockedTagKey = await findLockedInheritedTagKey(ws.orgId, ws.projectId, [...entries.keys()]);
    if (lockedTagKey !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Tag key "${lockedTagKey}" cannot override its inherited project tag` }] };
    }
    if (entries.size > 0) {
      await db.insert(workspaceTags).values([...entries].map(([key, value]): typeof workspaceTags.$inferInsert => ({
        id: crypto.randomUUID(),
        workspaceId,
        key,
        value,
      }))).onConflictDoNothing();
    }
    const keys = [...entries.keys()];
    const tags = keys.length === 0
      ? []
      : await db.query.workspaceTags.findMany({
        where: and(eq(workspaceTags.workspaceId, workspaceId), inArray(workspaceTags.key, keys)),
        orderBy: [asc(workspaceTags.key)],
      });
    (set as { status: number }).status = 201;
    return { data: tags.map((tag: TagItem): Record<string, string> => ({ id: tag.key, type: "tags" })) };
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params, body, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload["data"];
    if (Array.isArray(items)) {
      const keys = items.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>)["id"] === "string") ? (i as Record<string, unknown>)["id"] as string : "").filter((s: string): boolean => s !== "");
      if (keys.length > 0) await db.delete(workspaceTags).where(and(eq(workspaceTags.workspaceId, workspaceId), inArray(workspaceTags.key, keys)));
    }
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  // --- Workspace Variables ---
  .get("/api/v2/workspaces/:workspace_id/vars", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "variables-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(workspaceVariables.workspaceId, workspaceId);
    const [vars, countRows] = await Promise.all([
      db.query.workspaceVariables.findMany({ where, orderBy: [asc(workspaceVariables.key)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(workspaceVariables).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    if (strictAuditEnabled()) {
      const sensitiveCount = vars.filter((v: { readonly sensitive: boolean | null }): boolean => v.sensitive === true).length;
      if (sensitiveCount > 0) {
        await auditLog("read", "workspace-variable", workspaceId, user?.id ?? null, ws.orgId, {
          workspaceId,
          scope: "list",
          "sensitive-count": sensitiveCount,
        });
      }
    }
    return { data: vars.map((v: VarItem): Record<string, unknown> => workspaceVariableResource(v)), ...pagination(request, number, size, totalCount) };
  })
  // Effective variable list including variable-set inheritance (what the CLI
  // needs via Variables.ListAll). Same precedence as executionVariables, but
  // stored rows only: serializers null sensitive values, so no decryption
  // happens on the API path.
  .get("/api/v2/workspaces/:workspace_id/all-vars", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "variables-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const effective = await effectiveWorkspaceVariables(workspaceId, ws.orgId, ws.projectId ?? null);
    const totalCount = effective.length;
    const page = effective.slice((number - 1) * size, number * size);
    if (strictAuditEnabled()) {
      const sensitiveCount = page.filter((entry): boolean => entry.variable.sensitive === true).length;
      if (sensitiveCount > 0) {
        await auditLog("read", "workspace-variable", workspaceId, user?.id ?? null, ws.orgId, {
          workspaceId,
          scope: "all-vars-list",
          "sensitive-count": sensitiveCount,
        });
      }
    }
    return {
      data: page.map((entry): Record<string, unknown> => {
        if (entry.source === "workspace") return workspaceVariableResource(entry.variable);
        // Issue #627: name the winning set on inherited rows so clients can
        // show which set won a duplicated key (additive attributes).
        const base = variableSetVariableResource(entry.variable);
        const baseAttributes = base["attributes"];
        return {
          ...base,
          attributes: {
            ...(typeof baseAttributes === "object" && baseAttributes !== null ? baseAttributes : {}),
            "variable-set-id": entry.setId,
            "variable-set-name": entry.setName,
          },
        };
      }),
      ...pagination(request, number, size, totalCount),
    };
  })
  // Dry-run trigger-pattern preview (issue #628): match the saved patterns
  // against the latest uploaded configuration file list so authors see what
  // would (and would not) trigger a run before pushing. Same normalization
  // as the webhook matcher, so the preview agrees with live behavior.
  .get("/api/v2/workspaces/:workspace_id/trigger-preview", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const latestCv = await db.query.configurationVersions.findFirst({
      where: and(
        eq(configurationVersions.workspaceId, workspaceId),
        eq(configurationVersions.status, "uploaded"),
      ),
      orderBy: [desc(configurationVersions.createdAt)],
      columns: { id: true, archivePath: true },
    });
    const cvArchivePath = latestCv?.archivePath;
    if (latestCv === undefined || typeof cvArchivePath !== "string" || cvArchivePath === "" || !(await Bun.file(cvArchivePath).exists())) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Trigger preview needs an uploaded configuration version with a readable archive" }] };
    }
    const members = await listArchiveMembers(cvArchivePath);
    if (members === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Trigger preview could not list the latest configuration archive" }] };
    }
    const files = [...members].map((member): string => member.replace(/^\.\//, "")).filter((file): boolean => file !== "" && !file.endsWith("/"));
    const patterns = Array.isArray(ws.triggerPatterns) ? ws.triggerPatterns.filter((pattern): pattern is string => typeof pattern === "string" && pattern !== "") : [];
    const previews = patterns.map((pattern): Record<string, unknown> => {
      let matched: string[] = [];
      try {
        const glob = new Bun.Glob(pattern.replace(/^\/+/, ""));
        matched = files.filter((file): boolean => {
          try {
            return glob.match(file);
          } catch {
            return false;
          }
        });
      } catch {
        matched = [];
      }
      return { pattern, matches: matched.length, "matched-files": matched.slice(0, 10), truncated: matched.length > 10 };
    });
    return {
      data: {
        id: workspaceId,
        type: "trigger-preview",
        attributes: {
          "configuration-version-id": latestCv.id,
          "files-checked": files.length,
          patterns: previews,
        },
      },
    };
  })
  .post("/api/v2/workspaces/:workspace_id/vars", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "variables-write");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    if (data?.["type"] !== "vars" || !validVariableAttributes(attributes)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const varId = newResourceId("wsvar");
    const key = typeof attributes["key"] === "string" ? attributes["key"] : "";
    const value = typeof attributes["value"] === "string" ? attributes["value"] : "";
    const category = typeof attributes["category"] === "string" ? attributes["category"] : "terraform";
    const sensitive = typeof attributes["sensitive"] === "boolean" ? attributes["sensitive"] : false;
    const hcl = typeof attributes["hcl"] === "boolean" ? attributes["hcl"] : false;
    const description = typeof attributes["description"] === "string" ? attributes["description"] : null;
    // Sensitive values are encrypted at rest (todo 167/168).
    const stored = await variableValueForWrite(sensitive, value);
    try {
      await db.insert(workspaceVariables).values({ id: varId, workspaceId, key, value: stored.value, valueEncrypted: stored.valueEncrypted, category, sensitive, hcl, description });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this workspace" }] }; }
      throw error;
    }
    (set as { status: number }).status = 201;
    return { data: workspaceVariableResource({ id: varId, workspaceId, key, value: stored.value, valueEncrypted: stored.valueEncrypted, category, sensitive, hcl, description }) };
  })
  .get("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const varId = params["var_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "variables-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)) });
    if (variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (strictAuditEnabled() && variable.sensitive === true) {
      await auditLog("read", "workspace-variable", varId, user?.id ?? null, ws.orgId, {
        workspaceId,
        key: variable.key,
        sensitive: true,
      });
    }
    return { data: workspaceVariableResource(variable) };
  })
  .patch("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const varId = params["var_id"] ?? "";
    const actor = actorScope(user, orgId, teamId);
    const ws = await findAuthorizedWorkspace(workspaceId, actor.actorId, actor.actorOrgId, actor.actorTeamId, "variables-write");
    if (ws === undefined) return failWorkspaceUpdate(set, 404);
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)) });
    if (variable === undefined) return failWorkspaceUpdate(set, 404);
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const { attributes: attrs } = updateBodySections(body);
    if (data?.["type"] !== "vars" || !validVariableAttributes(attrs, true)) {
      return failWorkspaceUpdate(set, 422, "Invalid variable attributes");
    }
    const { sensitive, suppliedValue } = resolveVariableSensitive(attrs, variable);
    const stored = await resolveVariableStored(sensitive, suppliedValue, variable);
    const { key, category, hcl, description } = resolveVariableFields(attrs, variable);
    const updated = { key, value: stored.value, valueEncrypted: stored.valueEncrypted, category, sensitive, hcl, description };
    try {
      await db.update(workspaceVariables).set(updated).where(eq(workspaceVariables.id, varId));
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        return failWorkspaceUpdate(set, 422, "Variable key already exists in this workspace");
      }
      throw error;
    }
    return { data: workspaceVariableResource({ ...variable, ...updated }) };
  })
  .delete("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const varId = params["var_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "variables-write");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)) });
    if (variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, varId));
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  // Variable sets attached to this workspace (the reference format model: inherited variables
  // stay on their variable set — the workspace-variable list never flattens them).
  .get("/api/v2/workspaces/:workspace_id/varsets", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "variables-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const links = await db.query.variableSetWorkspaces.findMany({ where: eq(variableSetWorkspaces.workspaceId, workspaceId) });
    const setIds = links.map((link: { readonly variableSetId: string }): string => link.variableSetId);
    const [sets, countRows] = await Promise.all([
      setIds.length === 0
        ? Promise.resolve([])
        : db.query.variableSets.findMany({
            where: inArray(variableSets.id, setIds),
            orderBy: [asc(variableSets.name), asc(variableSets.id)],
            limit: size,
            offset: (number - 1) * size,
          }),
      setIds.length === 0
        ? Promise.resolve([{ total: 0 }])
        : db.select({ total: count() }).from(variableSets).where(inArray(variableSets.id, setIds)),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return {
      data: await Promise.all(sets.map(async (vs: typeof variableSets.$inferSelect): Promise<Record<string, unknown>> => variableSetResource(vs))),
      ...pagination(request, number, size, totalCount),
    };
  })
  // --- Lock/Unlock ---
  .post("/api/v2/workspaces/:workspace_id/actions/lock", async ({ params, body, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {

    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "lock"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (ws.locked === true) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is already locked" }] }; }
    const lockReason = parseLockReason(body);
    if (lockReason.error !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: lockReason.error }] };
    }

    const principal = lockPrincipal(user?.id, principalOrgId, teamId);
    const lockedAt = Date.now();
    const locked = await db.update(workspaces).set({
      locked: true,
      lockedReason: lockReason.reason,
      lockOwnerType: principal.type,
      lockOwnerId: principal.id,
      lockedAt,
    }).where(and(eq(workspaces.id, workspaceId), or(eq(workspaces.locked, false), isNull(workspaces.locked)))).returning({ id: workspaces.id });
    if (locked.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is already locked" }] }; }
    await auditLog("lock", "workspaces", workspaceId, user?.id ?? null, ws.orgId, teamId !== null && teamId !== undefined ? { teamId } : undefined);
    const org = await cachedOrgById(ws.orgId);
    return {
      data: await workspaceResource(
        { ...ws, locked: true, lockedReason: lockReason.reason, lockOwnerType: principal.type, lockOwnerId: principal.id, lockedAt },
        org?.defaultIacBinary,
        await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
        { orgName: org?.name ?? null },
      ),
    };
  })

  .post("/api/v2/workspaces/:workspace_id/actions/unlock", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "lock"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (ws.locked !== true) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is not locked" }] }; }
    const principal = lockPrincipal(user?.id, principalOrgId, teamId);
    const ownerlessLegacyLock = ws.lockOwnerType === null && ws.lockOwnerId === null;
    if (!ownerlessLegacyLock && !ownsWorkspaceLock(ws, principal)) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Only the lock owner can unlock this workspace" }] }; }
    const ownerPredicate = ownerlessLegacyLock
      ? and(isNull(workspaces.lockOwnerType), isNull(workspaces.lockOwnerId))
      : and(eq(workspaces.lockOwnerType, principal.type), eq(workspaces.lockOwnerId, principal.id));
    const unlocked = await db.update(workspaces).set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null, lockedAt: null }).where(and(eq(workspaces.id, workspaceId), eq(workspaces.locked, true), ownerPredicate)).returning({ id: workspaces.id });
    if (unlocked.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace lock changed while unlocking" }] }; }
    await promoteIntermediateStateVersion(workspaceId);
    const org = await cachedOrgById(ws.orgId);
    return {
      data: await workspaceResource(
        { ...ws, locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null, lockedAt: null },
        org?.defaultIacBinary,
        await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
        { orgName: org?.name ?? null },
      ),
    };
  })
  .post("/api/v2/workspaces/:workspace_id/actions/force-unlock", async ({ params, user, orgId: principalOrgId, teamId, set, body }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (ws.locked !== true) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is not locked" }] }; }
    // Issue #617: a lock held by a live run must not be swept away silently —
    // a second apply could be handed the workspace while the first is still
    // writing. Require an explicit force flag for those; stale and manual
    // locks unlock as before.
    const payload = body !== null && typeof body === "object" ? (body as { data?: { attributes?: Record<string, unknown> } }) : {};
    const force = payload.data?.attributes?.["force"] === true;
    if (!force) {
      const { isLiveRunLock } = await import("../lib/agent-jobs");
      if (await isLiveRunLock(ws)) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Workspace lock is held by a live run (${ws.lockOwnerId ?? "unknown"}); cancel or discard the run first, or retry with force to override` }] };
      }
    }
    const unlocked = await db.update(workspaces).set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null, lockedAt: null }).where(and(eq(workspaces.id, workspaceId), eq(workspaces.locked, true))).returning({ id: workspaces.id });
    if (unlocked.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace lock changed while unlocking" }] }; }
    await promoteIntermediateStateVersion(workspaceId);
    const org = await cachedOrgById(ws.orgId);
    return {
      data: await workspaceResource(
        { ...ws, locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null, lockedAt: null },
        org?.defaultIacBinary,
        await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
        { orgName: org?.name ?? null },
      ),
    };
  })
  // --- Remote State Consumers ---
  .get("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const consumers = await db.query.remoteStateConsumers.findMany({ where: eq(remoteStateConsumers.workspaceId, workspaceId) });
    return { data: consumers.map((c: Readonly<{ consumerWorkspaceId: string }>): Record<string, string> => ({ id: c.consumerWorkspaceId, type: "workspaces" })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload["data"];
    const list = Array.isArray(items) ? items : (items !== null && items !== undefined ? [items] : []);
    const consumerWorkspaceIds = await validatedRemoteStateConsumerIds(workspaceId, ws.orgId, list);
    if (consumerWorkspaceIds === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Remote state consumers must reference existing workspaces in the same organization" }] };
    }
    const batch = consumerWorkspaceIds.map((consumerWorkspaceId: string): { id: string; workspaceId: string; consumerWorkspaceId: string } => ({
      id: newResourceId("rsc"),
      workspaceId,
      consumerWorkspaceId,
    }));
    if (batch.length > 0) await db.insert(remoteStateConsumers).values(batch).onConflictDoNothing();
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .patch("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload["data"];
    if (!Array.isArray(items)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Remote state consumers must be an array" }] };
    }
    const list = items;
    const consumerWorkspaceIds = await validatedRemoteStateConsumerIds(workspaceId, ws.orgId, list);
    if (consumerWorkspaceIds === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Remote state consumers must reference existing workspaces in the same organization" }] };
    }
    const batch = consumerWorkspaceIds.map((consumerWorkspaceId: string): { id: string; workspaceId: string; consumerWorkspaceId: string } => ({
      id: newResourceId("rsc"),
      workspaceId,
      consumerWorkspaceId,
    }));
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.delete(remoteStateConsumers).where(eq(remoteStateConsumers.workspaceId, workspaceId));
      if (batch.length > 0) await t.insert(remoteStateConsumers).values(batch).onConflictDoNothing();
    });
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload["data"];
    const list = Array.isArray(items) ? items : (items !== null && items !== undefined ? [items] : []);
    const consumerWorkspaceIds = await validatedRemoteStateConsumerIds(workspaceId, ws.orgId, list);
    if (consumerWorkspaceIds === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Remote state consumers must reference existing workspaces in the same organization" }] };
    }
    if (consumerWorkspaceIds.length > 0) {
      await db.delete(remoteStateConsumers).where(and(eq(remoteStateConsumers.workspaceId, workspaceId), inArray(remoteStateConsumers.consumerWorkspaceId, consumerWorkspaceIds)));
    }
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  // --- Data Retention ---
  .get("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const policy = await db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspaceId) });
    if (policy === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return {
      data: {
        id: policy.id,
        type: policy.deleteOlderThanNDays === null ? "data-retention-policy-dont-deletes" : "data-retention-policy-delete-olders",
        attributes: {
          "state-versions-count": policy.stateVersionsCount,
          "delete-older-than-n-days": policy.deleteOlderThanNDays,
          "auto-destroy-at": policy.autoDestroyAt,
          "auto-destroy-activity-duration": policy.autoDestroyActivityDuration,
        },
      },
    };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const existing = await db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspaceId) });
    const pid = existing?.id ?? newResourceId("drp");
    const policyType = typeof data?.["type"] === "string" ? data["type"] : null;
    const rawDeleteOlderThanNDays = attrs["delete-older-than-n-days"] ?? attrs["deleteOlderThanNDays"];
    const stateVersionsCount = typeof attrs["state-versions-count"] === "number"
      ? attrs["state-versions-count"]
      : existing?.stateVersionsCount ?? null;
    const deleteOlderThanNDays = policyType === "data-retention-policy-dont-deletes"
      ? null
      : typeof rawDeleteOlderThanNDays === "number" && Number.isInteger(rawDeleteOlderThanNDays) && rawDeleteOlderThanNDays > 0
        ? rawDeleteOlderThanNDays
        : existing?.deleteOlderThanNDays ?? null;
    const autoDestroyAt = typeof attrs["auto-destroy-at"] === "string" ? attrs["auto-destroy-at"] : existing?.autoDestroyAt ?? null;
    const autoDestroyActivityDuration = typeof attrs["auto-destroy-activity-duration"] === "string"
      ? attrs["auto-destroy-activity-duration"]
      : existing?.autoDestroyActivityDuration ?? null;
    const values = {
      id: pid,
      workspaceId,
      stateVersionsCount,
      deleteOlderThanNDays,
      autoDestroyAt,
      autoDestroyActivityDuration,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    if (existing !== undefined) { await db.update(dataRetentionPolicies).set(values).where(eq(dataRetentionPolicies.id, pid)); } else { await db.insert(dataRetentionPolicies).values(values); }
    const gcSummary = await applyDataRetentionGarbageCollection(workspaceId);
    (set as { status: number }).status = existing !== undefined ? 200 : 201;
    return {
      data: {
        id: pid,
        type: values.deleteOlderThanNDays === null ? "data-retention-policy-dont-deletes" : "data-retention-policy-delete-olders",
        attributes: {
          "state-versions-count": values.stateVersionsCount,
          "delete-older-than-n-days": values.deleteOlderThanNDays,
          "auto-destroy-at": values.autoDestroyAt,
          "auto-destroy-activity-duration": values.autoDestroyActivityDuration,
        },
        meta: { gc: gcSummary },
      },
    };
  })
  .post("/api/v2/workspaces/:workspace_id/actions/gc", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const gcSummary = await applyDataRetentionGarbageCollection(workspaceId);
    return { data: { status: "ok", ...gcSummary } };
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(dataRetentionPolicies).where(eq(dataRetentionPolicies.workspaceId, workspaceId));
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  // --- SSH Key assignment ---
  .patch("/api/v2/workspaces/:workspace_id/relationships/ssh-key", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const rawSshKeyData = payload["data"];
    let sshKeyId: string | null = null;
    if (rawSshKeyData !== null) {
      if (!isRelationshipIdentifier(rawSshKeyData, "ssh-keys")) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "SSH key must be a valid ssh-keys resource identifier" }] };
      }
      const sshKey = await db.query.sshKeys.findFirst({
        where: and(eq(sshKeys.id, rawSshKeyData.id), eq(sshKeys.orgId, ws.orgId)),
      });
      if (sshKey === undefined) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "SSH key does not belong to the organization" }] };
      }
      sshKeyId = rawSshKeyData.id;
    }
    await db.update(workspaces).set({ sshKeyId }).where(eq(workspaces.id, workspaceId));
    return { data: { id: workspaceId, type: "workspaces", relationships: { "ssh-key": { data: sshKeyId !== null ? { id: sshKeyId, type: "ssh-keys" } : null } } } };
  });

function validateCreatePreamble(attributes: Readonly<Record<string, unknown>>): string | null {
  const globalRemoteState = attributes["global-remote-state"] === true;
  const projectRemoteState = attributes["project-remote-state"] === true;
  if (globalRemoteState && projectRemoteState) {
    return "global-remote-state and project-remote-state cannot both be true";
  }
  return validateOwnershipFields(attributes);
}

type ActorScope = Readonly<{
  actorId: string | undefined;
  actorOrgId: string | null;
  actorTeamId: string | null;
}>;

function actorScope(
  user: { readonly id: string } | null | undefined,
  principalOrgId: string | null | undefined,
  teamId: string | null | undefined,
): ActorScope {
  return { actorId: user?.id, actorOrgId: principalOrgId ?? null, actorTeamId: teamId ?? null };
}

function tagBindingKeys(bindings: readonly { key: string; value: string }[] | undefined): string[] {
  return bindings?.map((binding): string => binding.key) ?? [];
}

async function resolveCreateNameAndDup(
  parsed: ParsedWorkspaceUpdate,
  orgId: string,
): Promise<{ name: string } | { error: string; status: 422 | 409 }> {
  if (parsed.name === undefined || parsed.name === "" || !/^[A-Za-z0-9_-]+$/.test(parsed.name)) {
    return { error: "Invalid workspace name", status: 422 };
  }
  if ((await findWorkspaceByName(orgId, parsed.name)) !== undefined) {
    return { error: "Workspace name already exists in this organization", status: 409 };
  }
  return { name: parsed.name };
}

function validateCreateVersionFields(
  attributes: Readonly<Record<string, unknown>>,
  executionMode: unknown,
): string | null {
  const terraformVersion = attributes["terraform-version"];
  if (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) {
    return "Invalid terraformVersion format";
  }
  if (executionMode !== undefined && !isExecutionMode(executionMode)) return "execution-mode must be remote, local, or agent";
  const iacBinary = attributes["iac-binary"];
  if (iacBinary !== undefined && iacBinary !== null && typeof iacBinary === "string" && !["tofu", "terraform"].includes(iacBinary)) {
    return "iac-binary must be tofu or terraform";
  }
  return null;
}

function validateCreateFieldTypes(
  attributes: Readonly<Record<string, unknown>>,
  executionMode: unknown,
): string | null {
  const descriptionError = validateDescriptionField(attributes);
  if (descriptionError !== null) return descriptionError;
  return validateCreateVersionFields(attributes, executionMode);
}

async function resolveCreateWorkingDirAndTags(
  attributes: Readonly<Record<string, unknown>>,
  rels: Readonly<Record<string, unknown>>,
): Promise<{ dir: string | null; tagBindings: { key: string; value: string }[] | undefined } | { error: string }> {
  const workingDirectory = attributes["working-directory"];
  let dir: string | null = null;
  if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory === "string") {
    try {
      dir = normalizeWorkingDirectory(workingDirectory);
    } catch (error: unknown) {
      return { error: error instanceof Error ? error.message : "Invalid working directory" };
    }
  }
  const rawTagBindings = rels["tag-bindings"] as Record<string, unknown> | undefined;
  const tagBindingsData = rawTagBindings?.["data"];
  const tagBindings = tagBindingsData === undefined ? undefined : parseTagBindings(tagBindingsData);
  if (tagBindingsData !== undefined && tagBindings === undefined) return { error: "Invalid tag bindings" };
  return { dir, tagBindings };
}

async function resolveCreateProject(
  rels: Readonly<Record<string, unknown>>,
  orgId: string,
): Promise<{ project: typeof projects.$inferSelect } | { error: string }> {
  const projectRel = rels["project"];
  if (
    projectRel === undefined
    || (typeof projectRel === "object" && projectRel !== null && (projectRel as Record<string, unknown>)["data"] === null)
  ) {
    return { project: await ensureDefaultProject(orgId) };
  }
  const relationship = typeof projectRel === "object" && projectRel !== null ? projectRel as Record<string, unknown> : {};
  const projectData = typeof relationship["data"] === "object" && relationship["data"] !== null ? relationship["data"] as Record<string, unknown> : {};
  const projectId = typeof projectData["id"] === "string" ? projectData["id"] : "";
  const found = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
  });
  if (found === undefined || (projectData["type"] !== undefined && projectData["type"] !== "projects")) {
    return { error: "Project must belong to the workspace organization" };
  }
  return { project: found };
}

function validateCreateExecutionRequirements(
  executionOverride: boolean,
  executionMode: unknown,
  rawAgentPoolId: unknown,
): string | null {
  if (executionOverride && executionMode === undefined) {
    return "execution-mode is required when setting-overwrites.execution-mode is true";
  }
  if (rawAgentPoolId !== undefined && rawAgentPoolId !== null && typeof rawAgentPoolId !== "string") {
    return "agent-pool-id must be a string or null";
  }
  return null;
}

function resolveCreateExecutionState(args: Readonly<{
  executionMode: unknown;
  executionOverride: boolean;
  projectDefaultMode: string | null;
  agentPoolOverride: boolean;
  rawAgentPoolId: unknown;
  projectDefaultPoolId: string | null;
}>): Readonly<{ mode: string; poolId: string | null }> {
  const mode = args.executionOverride
    ? typeof args.executionMode === "string" ? args.executionMode : "remote"
    : args.projectDefaultMode ?? "remote";
  const poolId = mode === "agent"
    ? args.agentPoolOverride ? typeof args.rawAgentPoolId === "string" ? args.rawAgentPoolId : null : args.projectDefaultPoolId
    : null;
  return { mode, poolId };
}

type ResolvedCreateExecution = Readonly<{
  project: typeof projects.$inferSelect;
  mode: string;
  poolId: string | null;
  settingOverwrites: Record<string, boolean>;
}>;

async function resolveCreateExecutionChain(args: Readonly<{
  rels: Readonly<Record<string, unknown>>;
  orgId: string;
  rawSettingOverwrites: unknown;
  executionMode: unknown;
  rawAgentPoolId: unknown;
  workspaceId: string;
}>): Promise<ResolvedCreateExecution | { error: string }> {
  const project = await resolveCreateProject(args.rels, args.orgId);
  if ("error" in project) return project;
  const parsedOverwrites = parseSettingOverwrites(args.rawSettingOverwrites, undefined);
  if ("error" in parsedOverwrites) return { error: parsedOverwrites.error };
  const suppliedOverwrites = args.rawSettingOverwrites as Record<string, unknown> | undefined;
  const executionOverride = args.executionMode !== undefined || suppliedOverwrites?.["execution-mode"] === true;
  const agentPoolOverride = suppliedOverwrites?.["agent-pool"] as boolean | undefined ?? args.rawAgentPoolId !== undefined;
  const settingOverwrites = {
    ...parsedOverwrites.value,
    "execution-mode": executionOverride,
    "agent-pool": agentPoolOverride,
  };
  const requirementsError = validateCreateExecutionRequirements(executionOverride, args.executionMode, args.rawAgentPoolId);
  if (requirementsError !== null) return { error: requirementsError };
  const execution = resolveCreateExecutionState({
    executionMode: args.executionMode,
    executionOverride,
    projectDefaultMode: project.project.defaultExecutionMode,
    agentPoolOverride,
    rawAgentPoolId: args.rawAgentPoolId,
    projectDefaultPoolId: project.project.defaultAgentPoolId,
  });
  if (execution.mode === "agent" && execution.poolId === null) {
    return { error: "An agent pool is required for agent execution mode" };
  }
  if (execution.mode !== "agent" && typeof args.rawAgentPoolId === "string") {
    return { error: "agent-pool-id is only valid for agent execution mode" };
  }
  const poolError = await checkAgentPoolAccess(execution.poolId, args.orgId, args.workspaceId, project.project.id);
  if (poolError !== null) return { error: poolError };
  return { project: project.project, mode: execution.mode, poolId: execution.poolId, settingOverwrites };
}

function validateCreateDuration(attributes: Readonly<Record<string, unknown>>): string | null {
  const rawAutoDestroyActivityDuration = attributes["auto-destroy-activity-duration"];
  if (
    rawAutoDestroyActivityDuration !== undefined
    && rawAutoDestroyActivityDuration !== null
    && !isAutoDestroyDuration(rawAutoDestroyActivityDuration)
  ) {
    return "auto-destroy-activity-duration must be null or a duration such as 14d or 24h";
  }
  return null;
}

type WorkspaceCreateRowArgs = Readonly<{
  attributes: Readonly<Record<string, unknown>>;
  id: string;
  orgId: string;
  name: string;
  project: typeof projects.$inferSelect;
  mode: string;
  poolId: string | null;
  settingOverwrites: Record<string, boolean>;
  dir: string | null;
  inheritsProjectAutoDestroy: boolean;
  autoDestroyDuration: string | null | undefined;
  ownedById: string | null | undefined;
  contactEmail: string | null | undefined;
  terraformVersionHeader: string | null;
  orgDefaultIacBinary: string | null | undefined;
}>;

function buildWorkspaceCreateRow(args: WorkspaceCreateRowArgs): typeof workspaces.$inferInsert {
  const { attributes } = args;
  const description = attributes["description"];
  const terraformVersion = attributes["terraform-version"];
  const iacBinary = attributes["iac-binary"];
  const ownedByType = attributes["owned-by-type"];
  return {
    id: args.id,
    name: args.name,
    orgId: args.orgId,
    description: typeof description === "string" ? description : null,
    projectId: args.project.id,
    autoApply: booleanUpdateField(attributes["auto-apply"], false),
    terraformVersion: typeof terraformVersion === "string" ? terraformVersion : "latest",
    workingDirectory: args.dir,
    sourceName: nullableStringUpdateField(attributes["source-name"], null),
    sourceUrl: nullableStringUpdateField(attributes["source-url"], null),
    source: typeof attributes["source"] === "string" ? attributes["source"] : "tfe-api",
    iacBinary: typeof iacBinary === "string"
      ? iacBinary
      : args.terraformVersionHeader !== null ? "terraform" : (args.orgDefaultIacBinary ?? null),
    vcsRepo: undefined,
    executionMode: args.mode,
    agentPoolId: args.poolId,
    autoDestroyActivityDuration: args.inheritsProjectAutoDestroy
      ? args.project.autoDestroyActivityDuration
      : args.autoDestroyDuration,
    inheritsProjectAutoDestroy: args.inheritsProjectAutoDestroy,
    settingOverwrites: args.settingOverwrites,
    ownedByType: ownedByType === undefined || ownedByType === null ? null : ownedByType as "team" | "user" | "service",
    ownedById: args.ownedById ?? null,
    contactEmail: args.contactEmail ?? null,
    createdAt: Date.now(),
  };
}

async function insertWorkspaceTx(tx: unknown, args: Readonly<{
  row: typeof workspaces.$inferInsert;
  vcsRepo: unknown;
  orgId: string;
  workspaceId: string;
  tagBindings: { key: string; value: string }[] | undefined;
}>): Promise<string | null> {
  const database = tx as typeof db;
  let vcsRepo: typeof workspaces.$inferInsert.vcsRepo;
  if (args.vcsRepo !== undefined && args.vcsRepo !== null) {
    const normalized = await normalizeVcsRepo(args.vcsRepo, args.orgId, undefined, database);
    if ("error" in normalized) return normalized.error;
    vcsRepo = normalized.value;
  }
  await database.insert(workspaces).values({ ...args.row, vcsRepo });
  if (args.tagBindings !== undefined && args.tagBindings.length > 0) {
    await database.insert(workspaceTags).values(args.tagBindings.map((binding): typeof workspaceTags.$inferInsert => ({
      id: crypto.randomUUID(),
      workspaceId: args.workspaceId,
      key: binding.key,
      value: binding.value,
    })));
  }
  return null;
}

type WorkspaceUpdateFailure = Readonly<{
  errors: readonly Readonly<{ status: string; title: string; detail?: string }>[];
}>;

function failWorkspaceUpdate(set: SetObj, status: 422 | 409, detail: string): WorkspaceUpdateFailure;
function failWorkspaceUpdate(set: SetObj, status: 400 | 403 | 404, detail?: string): WorkspaceUpdateFailure;
function failWorkspaceUpdate(set: SetObj, status: 400 | 403 | 404 | 409 | 422, detail?: string): WorkspaceUpdateFailure {
  (set as { status: number }).status = status;
  const title = status === 422 ? "Unprocessable Entity" : status === 409 ? "Conflict" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Bad Request";
  if (detail === undefined) return { errors: [{ status: String(status), title }] };
  return { errors: [{ status: String(status), title, detail }] };
}

type ParsedWorkspaceUpdate = Readonly<{
  attributes: Record<string, unknown>;
  rels: Record<string, unknown>;
  tagBindingsData: unknown;
  tagBindings: { key: string; value: string }[] | undefined;
  rawAgentPoolId: unknown;
  executionMode: unknown;
  name: string | undefined;
}>;

function updateBodySections(body: unknown): Readonly<{
  attributes: Record<string, unknown>;
  rels: Record<string, unknown>;
}> {
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload["data"] as Record<string, unknown> | undefined;
  const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
  const rels = typeof data?.["relationships"] === "object" && data["relationships"] !== null ? (data["relationships"] as Record<string, unknown>) : {};
  return { attributes, rels };
}

function resolveVariableSensitive(
  attrs: Readonly<Record<string, unknown>>,
  variable: VarItem,
): Readonly<{ sensitive: boolean; suppliedValue: string | null }> {
  let sensitive = typeof attrs["sensitive"] === "boolean" ? attrs["sensitive"] : (variable.sensitive ?? false);
  if ((variable.sensitive ?? false) && !sensitive && attrs["value"] === undefined) sensitive = true;
  const suppliedValue = typeof attrs["value"] === "string" ? attrs["value"] : null;
  return { sensitive, suppliedValue };
}

async function resolveVariableStored(
  sensitive: boolean,
  suppliedValue: string | null,
  variable: VarItem,
): Promise<Readonly<{ value: string; valueEncrypted: string | null }>> {
  const unchangedSensitive = suppliedValue === null && sensitive && variable.sensitive === true && variable.valueEncrypted !== null;
  if (unchangedSensitive) return { value: variable.value, valueEncrypted: variable.valueEncrypted };
  // A value supplied in the PATCH is authoritative; otherwise keep the
  // stored value (decrypting an encrypted one). Flipping sensitive on
  // encrypts the existing plaintext (todo 169).
  return variableValueForWrite(sensitive, suppliedValue ?? (sensitive ? await variableValueForRead(variable) : variable.value));
}

function resolveVariableFields(
  attrs: Readonly<Record<string, unknown>>,
  variable: VarItem,
): Readonly<{ key: string; category: string; hcl: boolean; description: string | null }> {
  const key = typeof attrs["key"] === "string" ? attrs["key"] : variable.key;
  const category = typeof attrs["category"] === "string" ? attrs["category"] : variable.category;
  const hcl = typeof attrs["hcl"] === "boolean" ? attrs["hcl"] : (variable.hcl ?? false);
  const description = typeof attrs["description"] === "string" ? attrs["description"] : variable.description;
  return { key, category, hcl, description };
}

function parseWorkspaceUpdateBody(body: unknown): ParsedWorkspaceUpdate {
  const { attributes, rels } = updateBodySections(body);
  const rawTagBindings = rels["tag-bindings"] as Record<string, unknown> | undefined;
  const tagBindingsData = rawTagBindings !== undefined ? rawTagBindings["data"] : undefined;
  const tagBindings = tagBindingsData === undefined ? undefined : parseTagBindings(tagBindingsData);
  const rawAgentPoolId = attributes["agent-pool-id"] === "" ? null : attributes["agent-pool-id"];
  let executionMode = attributes["execution-mode"];
  if (executionMode === undefined && typeof attributes["operations"] === "boolean") {
    executionMode = attributes["operations"] ? "remote" : "local";
  }
  const name = typeof attributes["name"] === "string" ? attributes["name"] : undefined;
  return { attributes, rels, tagBindingsData, tagBindings, rawAgentPoolId, executionMode, name };
}

type WorkspaceUpdateScalars = Readonly<{
  attributes: Readonly<Record<string, unknown>>;
  workspace: DeepReadonly<typeof workspaces.$inferSelect>;
  tagBindingsData: unknown;
  tagBindings: readonly { key: string; value: string }[] | undefined;
  rawAgentPoolId: unknown;
  executionMode: unknown;
  name: string | undefined;
}>;

function validateRemoteStateFlags(
  attributes: Readonly<Record<string, unknown>>,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
): string | null {
  const newGlobal = typeof attributes["global-remote-state"] === "boolean" ? attributes["global-remote-state"] : workspace.globalRemoteState;
  const newProject = typeof attributes["project-remote-state"] === "boolean" ? attributes["project-remote-state"] : workspace.projectRemoteState;
  if (newGlobal === true && newProject === true) return "global-remote-state and project-remote-state cannot both be true";
  return null;
}

function validateWorkspaceNameField(name: string | undefined): string | null {
  if (name !== undefined && !/^[A-Za-z0-9_-]+$/.test(name)) return "Invalid workspace name";
  return null;
}

function validateDescriptionField(attributes: Readonly<Record<string, unknown>>): string | null {
  const description = attributes["description"];
  if (description !== undefined && description !== null && typeof description !== "string") return "description must be a string or null";
  return null;
}

function validateSourceFields(attributes: Readonly<Record<string, unknown>>): string | null {
  const sourceName = attributes["source-name"];
  const sourceUrl = attributes["source-url"];
  if ((sourceName !== undefined && sourceName !== null && typeof sourceName !== "string") || (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== "string")) {
    return "source-name and source-url must be strings or null";
  }
  return null;
}

function validateVersionAndBinaries(
  attributes: Readonly<Record<string, unknown>>,
  rawAgentPoolId: unknown,
  executionMode: unknown,
): string | null {
  const terraformVersion = typeof attributes["terraform-version"] === "string" ? attributes["terraform-version"] : undefined;
  if (terraformVersion !== undefined && !validateVersion(terraformVersion)) return "Invalid terraformVersion format";
  if (executionMode !== undefined && !isExecutionMode(executionMode)) return "execution-mode must be remote, local, or agent";
  const iacBinary = attributes["iac-binary"];
  if (iacBinary !== undefined && iacBinary !== null && typeof iacBinary === "string" && !["tofu", "terraform"].includes(iacBinary)) {
    return "iac-binary must be tofu or terraform";
  }
  if (rawAgentPoolId !== undefined && rawAgentPoolId !== null && typeof rawAgentPoolId !== "string") {
    return "agent-pool-id must be a string or null";
  }
  return null;
}

function validateAutoDestroyFields(attributes: Readonly<Record<string, unknown>>): string | null {
  const rawAutoDestroyActivityDuration = attributes["auto-destroy-activity-duration"];
  if (rawAutoDestroyActivityDuration !== undefined && rawAutoDestroyActivityDuration !== null && !isAutoDestroyDuration(rawAutoDestroyActivityDuration)) {
    return "auto-destroy-activity-duration must be null or a duration such as 14d or 24h";
  }
  const rawInheritsProjectAutoDestroy = attributes["inherits-project-auto-destroy"];
  if (rawInheritsProjectAutoDestroy !== undefined && typeof rawInheritsProjectAutoDestroy !== "boolean") {
    return "inherits-project-auto-destroy must be a boolean";
  }
  if (rawAutoDestroyActivityDuration !== undefined && rawInheritsProjectAutoDestroy === true) {
    return "An auto-destroy override cannot also inherit from the project";
  }
  return null;
}

function validateVersionExecutionAndDestroy(
  attributes: Readonly<Record<string, unknown>>,
  rawAgentPoolId: unknown,
  executionMode: unknown,
): string | null {
  const binariesError = validateVersionAndBinaries(attributes, rawAgentPoolId, executionMode);
  if (binariesError !== null) return binariesError;
  return validateAutoDestroyFields(attributes);
}

function validateOwnershipFields(attributes: Readonly<Record<string, unknown>>): string | null {
  const rawOwnedByType = attributes["owned-by-type"];
  if (rawOwnedByType !== undefined && rawOwnedByType !== null && !["team", "user", "service"].includes(rawOwnedByType as string)) {
    return "owned-by-type must be team, user, or service";
  }
  const rawOwnedById = attributes["owned-by-id"];
  if (rawOwnedById !== undefined && rawOwnedById !== null && typeof rawOwnedById !== "string") {
    return "owned-by-id must be a string or null";
  }
  const rawContactEmail = attributes["contact-email"];
  if (rawContactEmail !== undefined && rawContactEmail !== null && (typeof rawContactEmail !== "string" || rawContactEmail.length > 254)) {
    return "contact-email must be a string under 255 characters";
  }
  return null;
}

function validateWorkspaceUpdateScalars(args: WorkspaceUpdateScalars): string | null {
  const flagsError = validateRemoteStateFlags(args.attributes, args.workspace);
  if (flagsError !== null) return flagsError;
  if (args.tagBindingsData !== undefined && args.tagBindings === undefined) return "Invalid tag bindings";
  const nameError = validateWorkspaceNameField(args.name);
  if (nameError !== null) return nameError;
  const descriptionError = validateDescriptionField(args.attributes);
  if (descriptionError !== null) return descriptionError;
  const sourceError = validateSourceFields(args.attributes);
  if (sourceError !== null) return sourceError;
  const versionError = validateVersionExecutionAndDestroy(args.attributes, args.rawAgentPoolId, args.executionMode);
  if (versionError !== null) return versionError;
  return validateOwnershipFields(args.attributes);
}

async function resolveUpdateWorkingDirectory(
  attributes: Readonly<Record<string, unknown>>,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
): Promise<{ dir: string | null } | { error: string }> {
  const workingDirectory = attributes["working-directory"];
  let dir = workspace.workingDirectory;
  if (workingDirectory !== undefined && typeof workingDirectory === "string") {
    try {
      dir = normalizeWorkingDirectory(workingDirectory);
    } catch (error: unknown) {
      return { error: error instanceof Error ? error.message : "Invalid working directory" };
    }
  }
  if (workingDirectory === undefined || dir === null) return { dir };
  const latestCv = await db.query.configurationVersions.findFirst({
    where: and(
      eq(configurationVersions.workspaceId, workspace.id),
      eq(configurationVersions.status, "uploaded"),
    ),
    orderBy: [desc(configurationVersions.createdAt)],
    columns: { archivePath: true },
  });
  const cvArchivePath = latestCv?.archivePath;
  if (typeof cvArchivePath !== "string" || cvArchivePath === "" || !(await Bun.file(cvArchivePath).exists())) return { dir };
  const members = await listArchiveMembers(cvArchivePath);
  if (members === null) {
    return { error: "working-directory could not be validated: the latest configuration archive cannot be listed" };
  }
  // Issue #628: fail at save when an explicitly set directory matches
  // nothing in the latest configuration instead of failing mid-plan.
  // Skipped when no readable configuration exists yet; drift after save
  // still surfaces the worker error naming the directory.
  if (!archiveContainsWorkingDir(members, dir)) {
    const tops = summarizeTopLevelEntries(members);
    return { error: "working-directory " + JSON.stringify(dir) + " matches no directory in the latest configuration version" + (tops.length === 0 ? "." : " (top-level entries: " + tops.join(", ") + ")") };
  }
  return { dir };
}

async function checkDuplicateWorkspaceName(
  name: string | undefined,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
): Promise<string | null> {
  if (name === undefined || name === workspace.name) return null;
  const duplicate = await findWorkspaceByName(workspace.orgId, name);
  if (duplicate !== undefined && duplicate.id !== workspace.id) return "Workspace name already exists in this organization";
  return null;
}

async function resolveCurrentProject(orgId: string, projectId: string): Promise<{ project: typeof projects.$inferSelect } | { error: string }> {
  const current = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
  });
  if (current === undefined) return { error: "Project must belong to the workspace organization" };
  return { project: current };
}

function updateProjectIdFromRel(projectRel: unknown): { id: string } | { error: string } {
  const relationship = typeof projectRel === "object" && projectRel !== null ? projectRel as Record<string, unknown> : {};
  const projectData = typeof relationship["data"] === "object" && relationship["data"] !== null ? relationship["data"] as Record<string, unknown> : {};
  if (projectData["type"] !== undefined && projectData["type"] !== "projects") {
    return { error: "Invalid project relationship" };
  }
  return { id: typeof projectData["id"] === "string" ? projectData["id"] : "" };
}

async function resolveUpdateProject(
  rels: Readonly<Record<string, unknown>>,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
): Promise<{ project: typeof projects.$inferSelect } | { error: string }> {
  const projectRel = rels["project"];
  if (projectRel === undefined && workspace.projectId !== null) {
    return resolveCurrentProject(workspace.orgId, workspace.projectId);
  }
  if (
    projectRel === undefined
    || (typeof projectRel === "object" && projectRel !== null && (projectRel as Record<string, unknown>)["data"] === null)
  ) {
    return { project: await ensureDefaultProject(workspace.orgId) };
  }
  const idOrError = updateProjectIdFromRel(projectRel);
  if ("error" in idOrError) return idOrError;
  const found = await db.query.projects.findFirst({
    where: and(eq(projects.id, idOrError.id), eq(projects.orgId, workspace.orgId)),
  });
  if (found === undefined) return { error: "Project must belong to the workspace organization" };
  return { project: found };
}

type ResolvedEffectiveExecution = Readonly<{
  mode: string;
  poolId: string | null;
}>;

function resolveEffectiveExecution(args: Readonly<{
  executionMode: unknown;
  rawAgentPoolId: string | null | undefined;
  overwritesExecutionMode: boolean;
  overwritesAgentPool: boolean;
  workspace: DeepReadonly<typeof workspaces.$inferSelect>;
  project: typeof projects.$inferSelect;
}>): ResolvedEffectiveExecution | { error: string } {
  const mode = args.overwritesExecutionMode
    ? typeof args.executionMode === "string" ? args.executionMode : args.workspace.executionMode
    : args.project.defaultExecutionMode ?? "remote";
  const poolId = mode === "agent"
    ? args.overwritesAgentPool
      ? args.rawAgentPoolId !== undefined ? args.rawAgentPoolId : args.workspace.agentPoolId
      : args.project.defaultAgentPoolId
    : null;
  if (mode === "agent" && poolId === null) return { error: "An agent pool is required for agent execution mode" };
  if (mode !== "agent" && typeof args.rawAgentPoolId === "string") return { error: "agent-pool-id is only valid for agent execution mode" };
  return { mode, poolId };
}

async function checkAgentPoolAccess(
  poolId: string | null,
  orgId: string,
  workspaceId: string,
  projectId: string,
): Promise<string | null> {
  if (poolId === null) return null;
  const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
  if (pool?.orgId !== orgId) return "Agent pool must belong to the workspace organization";
  if (!(await agentPoolAllowsWorkspace(pool, workspaceId, projectId))) return "Agent pool is not allowed for this workspace or project";
  return null;
}

type ResolvedAutoDestroy = Readonly<{
  inherits: boolean;
  duration: string | null | undefined;
}>;

function resolveAutoDestroyFields(
  rawDuration: string | null | undefined,
  rawInherits: unknown,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  project: typeof projects.$inferSelect,
): ResolvedAutoDestroy {
  const inherits = rawDuration !== undefined
    ? false
    : rawInherits === true
      ? true
      : rawInherits === false
        ? false
        : workspace.inheritsProjectAutoDestroy;
  const duration = rawDuration !== undefined
    ? rawDuration
    : inherits
      ? project.autoDestroyActivityDuration
      : workspace.autoDestroyActivityDuration;
  return { inherits, duration };
}

async function checkLockedInheritedTag(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  newProjectId: string,
  tagBindings: readonly { key: string; value: string }[] | undefined,
): Promise<string | null> {
  const overrideKeys = tagBindings !== undefined
    ? tagBindings.map((binding): string => binding.key)
    : newProjectId !== workspace.projectId
      ? (await db.query.workspaceTags.findMany({
          where: eq(workspaceTags.workspaceId, workspace.id),
          columns: { key: true },
        })).map((tag: Readonly<{ key: string }>): string => tag.key)
      : [];
  const lockedTagKey = await findLockedInheritedTagKey(workspace.orgId, newProjectId, overrideKeys);
  if (lockedTagKey !== undefined) return `Tag key "${lockedTagKey}" cannot override its inherited project tag`;
  return null;
}

function validateTriggerFields(attributes: Readonly<Record<string, unknown>>): string | null {
  // Issue #628: fail at save on trigger entries that can never match
  // (non-strings, blanks) instead of silently matching nothing at webhook
  // time. Well-typed patterns stay accepted: preview them below.
  if (Array.isArray(attributes["trigger-prefixes"])) {
    const badPrefixes = invalidTriggerPrefixIndexes(attributes["trigger-prefixes"] as unknown[]);
    if (badPrefixes.length > 0) {
      return "trigger-prefixes entries must be non-blank strings (indexes: " + badPrefixes.join(", ") + ")";
    }
  }
  if (Array.isArray(attributes["trigger-patterns"])) {
    const badPatterns = invalidTriggerPatternIndexes(attributes["trigger-patterns"] as unknown[]);
    if (badPatterns.length > 0) {
      return "trigger-patterns entries must be non-blank strings (indexes: " + badPatterns.join(", ") + ")";
    }
  }
  return null;
}

function booleanUpdateField(value: unknown, fallback: boolean | null): boolean | null {
  return typeof value === "boolean" ? value : fallback;
}

function nullableStringUpdateField(value: unknown, fallback: string | null): string | null {
  if (typeof value === "string") return value;
  if (value === null) return null;
  return fallback;
}

function stringArrayUpdateField(value: unknown, fallback: readonly string[] | null): string[] | null {
  if (Array.isArray(value)) return value as string[];
  if (fallback === null) return null;
  return [...fallback];
}

type WorkspaceUpdateRowArgs = Readonly<{
  attributes: Readonly<Record<string, unknown>>;
  workspace: DeepReadonly<typeof workspaces.$inferSelect>;
  name: string | undefined;
  executionMode: string;
  agentPoolId: string | null;
  newProjectId: string;
  autoDestroy: ResolvedAutoDestroy;
  workspaceSettingOverwrites: Record<string, boolean>;
  normalizedWorkingDirectory: string | null;
}>;

function buildWorkspaceUpdateRow(args: WorkspaceUpdateRowArgs): Partial<typeof workspaces.$inferInsert> {
  const { attributes, workspace } = args;
  return {
    name: args.name ?? workspace.name,
    description: nullableStringUpdateField(attributes["description"], workspace.description),
    projectId: args.newProjectId,
    autoApply: booleanUpdateField(attributes["auto-apply"], workspace.autoApply),
    autoApplyRunTrigger: booleanUpdateField(attributes["auto-apply-run-trigger"], workspace.autoApplyRunTrigger),
    fileTriggersEnabled: booleanUpdateField(attributes["file-triggers-enabled"], workspace.fileTriggersEnabled),
    triggerPrefixes: stringArrayUpdateField(attributes["trigger-prefixes"], workspace.triggerPrefixes),
    triggerPatterns: stringArrayUpdateField(attributes["trigger-patterns"], workspace.triggerPatterns),
    vcsRepo: workspace.vcsRepo,
    queueAllRuns: booleanUpdateField(attributes["queue-all-runs"], workspace.queueAllRuns),
    speculativeEnabled: booleanUpdateField(attributes["speculative-enabled"], workspace.speculativeEnabled),
    allowDestroyPlan: booleanUpdateField(attributes["allow-destroy-plan"], workspace.allowDestroyPlan),
    globalRemoteState: booleanUpdateField(attributes["global-remote-state"], workspace.globalRemoteState),
    projectRemoteState: booleanUpdateField(attributes["project-remote-state"], workspace.projectRemoteState),
    executionMode: args.executionMode,
    agentPoolId: args.agentPoolId,
    assessmentsEnabled: booleanUpdateField(attributes["assessments-enabled"], workspace.assessmentsEnabled),
    autoDestroyAt: typeof attributes["auto-destroy-at"] === "string" ? attributes["auto-destroy-at"] : workspace.autoDestroyAt,
    autoDestroyActivityDuration: args.autoDestroy.duration,
    inheritsProjectAutoDestroy: args.autoDestroy.inherits,
    settingOverwrites: args.workspaceSettingOverwrites,
    terraformVersion: typeof attributes["terraform-version"] === "string" ? attributes["terraform-version"] : workspace.terraformVersion,
    workingDirectory: args.normalizedWorkingDirectory,
    sourceName: nullableStringUpdateField(attributes["source-name"], workspace.sourceName),
    sourceUrl: nullableStringUpdateField(attributes["source-url"], workspace.sourceUrl),
    source: typeof attributes["source"] === "string" ? attributes["source"] : workspace.source,
    iacBinary: nullableStringUpdateField(attributes["iac-binary"], workspace.iacBinary),
    ownedByType: nullableStringUpdateField(attributes["owned-by-type"], workspace.ownedByType),
    ownedById: nullableStringUpdateField(attributes["owned-by-id"], workspace.ownedById),
    contactEmail: nullableStringUpdateField(attributes["contact-email"], workspace.contactEmail),
  };
}

type WorkspaceUpdateTxArgs = Readonly<{
  row: Partial<typeof workspaces.$inferInsert>;
  vcsRepo: unknown;
  orgId: string;
  vcsRepoFallback: DeepReadonly<WorkspaceVcsRepo> | null | undefined;
  tagBindings: readonly { key: string; value: string }[] | undefined;
  workspaceId: string;
}>;

async function applyWorkspaceUpdateTx(tx: unknown, args: WorkspaceUpdateTxArgs): Promise<string | null> {
  const database = tx as typeof db;
  if (args.vcsRepo !== undefined) {
    const normalized = await normalizeVcsRepo(args.vcsRepo, args.orgId, args.vcsRepoFallback ?? undefined, database);
    if ("error" in normalized) return normalized.error;
    args.row.vcsRepo = normalized.value;
  }
  await database.update(workspaces).set(args.row).where(eq(workspaces.id, args.workspaceId));
  if (args.tagBindings !== undefined) {
    await database.delete(workspaceTags).where(eq(workspaceTags.workspaceId, args.workspaceId));
    if (args.tagBindings.length > 0) {
      await database.insert(workspaceTags).values(args.tagBindings.map((b: Readonly<{ key: string; value: string }>): { id: string; workspaceId: string; key: string; value: string } => ({ id: crypto.randomUUID(), workspaceId: args.workspaceId, ...b })));
    }
  }
  return null;
}

async function persistWorkspaceUpdate(
  args: WorkspaceUpdateTxArgs,
): Promise<{ saved: typeof workspaces.$inferSelect } | { error: string }> {
  const vcsError = await db.transaction(async (tx): Promise<string | null> => applyWorkspaceUpdateTx(tx, args));
  if (vcsError !== null) return { error: vcsError };
  const saved = await db.query.workspaces.findFirst({ where: eq(workspaces.id, args.workspaceId) });
  if (saved === undefined) throw new Error("Unable to update workspace");
  scheduleExplorerInventory(saved.id);
  return { saved };
}

function applyExecutionOverwrites(
  overwrites: Record<string, boolean>,
  executionMode: unknown,
  rawAgentPoolId: unknown,
  suppliedOverwrites: Record<string, unknown> | undefined,
): void {
  if (executionMode !== undefined) overwrites["execution-mode"] = true;
  if (rawAgentPoolId !== undefined && suppliedOverwrites?.["agent-pool"] === undefined) overwrites["agent-pool"] = true;
}

function workspaceOrgOption(orgName: string | null | undefined): Readonly<{ orgName: string | null }> {
  // exactOptionalPropertyTypes: the resource options omit orgName when it is
  // undefined but reject an explicit undefined, so normalize it here.
  return { orgName: orgName ?? null };
}

async function updateWorkspaceResponse(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  defaultIacBinary: string | null | undefined,
  principal: Readonly<{
    userId: string | undefined;
    principalOrgId: string | null;
    teamId: string | null;
  }>,
  body: unknown,
  set: SetObj,
  orgName?: string | null,
): Promise<unknown> {
  const parsed = parseWorkspaceUpdateBody(body);
  const attributes = parsed.attributes;
  const scalarsError = validateWorkspaceUpdateScalars({
    attributes,
    workspace,
    tagBindingsData: parsed.tagBindingsData,
    tagBindings: parsed.tagBindings,
    rawAgentPoolId: parsed.rawAgentPoolId,
    executionMode: parsed.executionMode,
    name: parsed.name,
  });
  if (scalarsError !== null) return failWorkspaceUpdate(set, 422, scalarsError);

  const workingDir = await resolveUpdateWorkingDirectory(attributes, workspace);
  if ("error" in workingDir) return failWorkspaceUpdate(set, 422, workingDir.error);
  const normalizedWorkingDirectory = workingDir.dir;
  const duplicateError = await checkDuplicateWorkspaceName(parsed.name, workspace);
  if (duplicateError !== null) return failWorkspaceUpdate(set, 409, duplicateError);
  const project = await resolveUpdateProject(parsed.rels, workspace);
  if ("error" in project) return failWorkspaceUpdate(set, 422, project.error);
  const newProjectId = project.project.id;
  const rawSettingOverwrites = attributes["setting-overwrites"];
  const parsedOverwrites = parseSettingOverwrites(rawSettingOverwrites, workspace.settingOverwrites);
  if ("error" in parsedOverwrites) return failWorkspaceUpdate(set, 422, parsedOverwrites.error);
  const suppliedOverwrites = rawSettingOverwrites as Record<string, unknown> | undefined;
  const workspaceSettingOverwrites: Record<string, boolean> = {
    "agent-pool": false,
    ...parsedOverwrites.value,
  };
  applyExecutionOverwrites(workspaceSettingOverwrites, parsed.executionMode, parsed.rawAgentPoolId, suppliedOverwrites);
  // Boundary narrowing: validateWorkspaceUpdateScalars already rejected a
  // non-string agent-pool-id and a malformed auto-destroy duration, so the
  // unknown payload values are safe to treat with their validated types here.
  const agentPoolId = parsed.rawAgentPoolId as string | null | undefined;
  const autoDestroyDuration = attributes["auto-destroy-activity-duration"] as string | null | undefined;
  const effective = resolveEffectiveExecution({
    executionMode: parsed.executionMode,
    rawAgentPoolId: agentPoolId,
    overwritesExecutionMode: workspaceSettingOverwrites["execution-mode"] === true,
    overwritesAgentPool: workspaceSettingOverwrites["agent-pool"] === true,
    workspace,
    project: project.project,
  });
  if ("error" in effective) return failWorkspaceUpdate(set, 422, effective.error);
  const effectiveExecutionMode = effective.mode;
  const effectiveAgentPoolId = effective.poolId;
  const poolError = await checkAgentPoolAccess(effectiveAgentPoolId, workspace.orgId, workspace.id, newProjectId);
  if (poolError !== null) return failWorkspaceUpdate(set, 422, poolError);
  const autoDestroy = resolveAutoDestroyFields(
    autoDestroyDuration,
    attributes["inherits-project-auto-destroy"],
    workspace,
    project.project,
  );
  const lockedError = await checkLockedInheritedTag(workspace, newProjectId, parsed.tagBindings);
  if (lockedError !== null) return failWorkspaceUpdate(set, 422, lockedError);
  // Issue #628: fail at save on trigger entries that can never match
  // (non-strings, blanks) instead of silently matching nothing at webhook
  // time. Well-typed patterns stay accepted: preview them below.
  const triggerError = validateTriggerFields(attributes);
  if (triggerError !== null) return failWorkspaceUpdate(set, 422, triggerError);
  const updated = buildWorkspaceUpdateRow({
    attributes,
    workspace,
    name: parsed.name,
    executionMode: effectiveExecutionMode,
    agentPoolId: effectiveAgentPoolId,
    newProjectId,
    autoDestroy,
    workspaceSettingOverwrites,
    normalizedWorkingDirectory,
  });

  const persisted = await persistWorkspaceUpdate({
    row: updated,
    vcsRepo: attributes["vcs-repo"],
    orgId: workspace.orgId,
    vcsRepoFallback: workspace.vcsRepo,
    tagBindings: parsed.tagBindings,
    workspaceId: workspace.id,
  });
  if ("error" in persisted) return failWorkspaceUpdate(set, 422, persisted.error);
  const saved = persisted.saved;
  return {
    data: await workspaceResource(
      saved,
      defaultIacBinary,
      await resourcePermissions(saved, principal.userId, principal.principalOrgId, principal.teamId),
      workspaceOrgOption(orgName),
    ),
  };
}
