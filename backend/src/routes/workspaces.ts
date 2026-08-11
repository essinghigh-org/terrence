import { Elysia } from "elysia";
import { db } from "../db";
import { agentPools, projects, workspaces, workspaceTags, projectTags, workspaceVariables, runs, configurationVersions, remoteStateConsumers, dataRetentionPolicies, githubAppInstallations, oauthClients, oauthTokens, stateVersions, type users } from "../db/schema";
import { eq, and, asc, desc, count, inArray, like, notInArray, sql } from "drizzle-orm";
import {
  workspaceResource,
  workspaceOutputResources,
  workspaceVariableResource,
  tagBindingResource,
  type WorkspaceResourcePermissions,
} from "../lib/response";
import { validVariableAttributes } from "../lib/validation";
import { validateVersion, checkOrgPermission, checkOrganizationPermission, checkWorkspacePermission, workspacePermissionSets, workspaceAllows, findAuthorizedWorkspace, findWorkspaceByName, findLockedInheritedTagKey, pageRequest, pagination, parseTagBindings, auditLog, strictAuditEnabled, applyDataRetentionGarbageCollection, promoteIntermediateStateVersion, safeDeleteWorkspace, deleteWorkspaceData , type DeepReadonly } from "../lib/utils";

import { normalizeWorkingDirectory } from "../workspace";
import { authPlugin } from "../auth";
import { agentPoolAllowsWorkspace } from "../lib/agent-pool-scope";
import { ensureDefaultProject, isAutoDestroyDuration, parseSettingOverwrites } from "./projects";
import { cachedOrgByName, cachedOrgById } from "../lib/cached-lookups";
import { isExecutionMode } from "../lib/constants";


type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: DeepReadonly<typeof users.$inferSelect> | null;
  readonly orgId?: string | null;
  readonly teamId?: string | null;
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

/**
 * Guard against ReDoS-prone patterns (e.g. nested quantified groups such as
 * `(a+)+`) that could make regex evaluation catastrophic on untrusted Git tag
 * names. Also surfaced as a bounded validation for the tags-regex setting.
 */
function isBraceQuantifierStart(pattern: string, index: number): boolean {
  if (pattern[index] !== "{") return false;
  const end = pattern.indexOf("}", index);
  if (end === -1) return false;
  return /^\d+(,\d*)?$/.test(pattern.slice(index + 1, end));
}

function isGroupQuantifier(pattern: string, index: number): boolean {
  const char = pattern[index] ?? "";
  return char === "*" || char === "+" || char === "?" || isBraceQuantifierStart(pattern, index);
}

function hasNestedQuantifiers(pattern: string): boolean {
  const openGroups: boolean[] = [];
  let inClass = false;
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") { inClass = true; continue; }
    if (char === "(") { openGroups.push(false); continue; }
    if (char === ")") {
      const nested = openGroups.pop() ?? false;
      if (nested && isGroupQuantifier(pattern, index + 1)) return true;
      // The closed group's contents are fixed; if it held a quantifier,
      // propagate that to its parent so cases like ((a+))+ are caught at the
      // outer group's close instead of losing the nested state.
      if (nested && openGroups.length > 0) openGroups[openGroups.length - 1] = true;
      continue;
    }
    if (char === "*" || char === "+" || char === "?" || char === "{") {
      if (openGroups.length > 0) openGroups[openGroups.length - 1] = true;
    }
  }
  return false;
}

function isValidTagsRegex(pattern: string): boolean {
  if (pattern.length > 256) return false;
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch {
    return false;
  }
  if (hasNestedQuantifiers(pattern)) return false;
  // Reject excessive alternation fan-out that can also degrade matching.
  if ((compiled.source.match(/\|/g) ?? []).length > 100) return false;
  return true;
}

function stringValues(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stateResourceAddress(resource: Record<string, unknown>): string | null {
  if (typeof resource.type !== "string" || typeof resource.name !== "string") return null;
  const module = typeof resource.module === "string" && resource.module !== "" ? `${resource.module}.` : "";
  const mode = resource.mode === "data" ? "data." : "";
  return `${module}${mode}${resource.type}.${resource.name}`;
}

function dependencyGraphFromState(statePayload: string | null): readonly DependencyGraphNode[] {
  if (statePayload === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(statePayload) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.resources)) return [];

  const resources = new Map<string, Set<string>>();
  for (const value of parsed.resources) {
    if (!isRecord(value)) continue;
    const address = stateResourceAddress(value);
    if (address === null) continue;
    const dependencies = resources.get(address) ?? new Set<string>();
    stringValues(value.dependencies).forEach((dependency): void => { dependencies.add(dependency); });
    if (Array.isArray(value.instances)) {
      for (const instance of value.instances) {
        if (isRecord(instance)) stringValues(instance.dependencies).forEach((dependency): void => { dependencies.add(dependency); });
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
const MAX_ARCHIVE_METADATA_BYTES = 4 * 1024 * 1024;
const README_ARCHIVE_TIMEOUT_MS = 5_000;

// Bound tar output so malformed archives cannot make the API buffer unbounded data.
async function readProcessOutput(process: Readonly<{
  exited: Promise<number>;
  stdout: Readonly<ReadableStream<Uint8Array>>;
  kill: (exitCode?: number | NodeJS.Signals) => void;
}>, maxBytes: number): Promise<string | null> {
  const read = async (): Promise<string | null> => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let output = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > maxBytes) {
          process.kill("SIGKILL");
          return null;
        }
        output += decoder.decode(result.value, { stream: true });
      }
      output += decoder.decode();
      return await process.exited === 0 ? output : null;
    } finally {
      reader.releaseLock();
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const readPromise = read();
  const timeoutPromise = new Promise<null>((resolve): void => {
    timer = setTimeout((): void => {
      process.kill("SIGKILL");
      resolve(null);
    }, README_ARCHIVE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([readPromise, timeoutPromise]);
    if (result === null) {
      process.kill("SIGKILL");
      await Promise.allSettled([readPromise, process.exited]);
    }
    return result;
  } catch {
    process.kill("SIGKILL");
    await Promise.allSettled([readPromise, process.exited]);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function isUniqueConstraintError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (("message" in err && typeof err.message === "string" && err.message.includes("UNIQUE")) || ("code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE"));
}

function parseLockReason(body: unknown): Readonly<{ reason: string | null; error: string | null }> {
  if (body === undefined || body === null) return { reason: null, error: null };
  if (typeof body !== "object" || Array.isArray(body)) return { reason: null, error: "Lock reason must be a string" };
  const payload = body as Record<string, unknown>;
  const data = payload.data !== null && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : undefined;
  const attributes = data?.attributes !== null && typeof data?.attributes === "object"
    ? data.attributes as Record<string, unknown>
    : undefined;
  const value = payload.reason ?? attributes?.reason;
  if (value === undefined || value === null) return { reason: null, error: null };
  if (typeof value !== "string") return { reason: null, error: "Lock reason must be a string" };
  const reason = value.trim();
  if (reason.length > 300) return { reason: null, error: "Lock reason must be at most 300 characters" };
  return { reason: reason === "" ? null : reason, error: null };
}

async function normalizeVcsRepo(
  input: unknown,
  orgId: string,
  existing?: DeepReadonly<WorkspaceVcsRepo>,
): Promise<Readonly<{ value: WorkspaceVcsRepo | null }> | Readonly<{ error: string }>> {
  if (input === null) return { value: null };
  if (typeof input !== "object") return { error: "vcs-repo must be an object or null" };
  const raw = input as Record<string, unknown>;

  const identifierValue = raw.identifier;
  const identifier = identifierValue === undefined
    ? existing?.identifier ?? ""
    : typeof identifierValue === "string" ? identifierValue.trim() : "";
  if (identifier === "") return { error: "Repository identifier is required" };

  const installationValue = raw["github-app-installation-id"] ?? raw.githubAppInstallationId;
  if (installationValue !== undefined && installationValue !== null && typeof installationValue !== "string") {
    return { error: "github-app-installation-id must be a string or null" };
  }
  const installationId = installationValue === null
    ? undefined
    : typeof installationValue === "string" ? installationValue.trim() : existing?.githubAppInstallationId;

  const oauthTokenValue = raw["oauth-token-id"] ?? raw.oauthTokenId;
  if (oauthTokenValue !== undefined && oauthTokenValue !== null && typeof oauthTokenValue !== "string") {
    return { error: "oauth-token-id must be a string or null" };
  }
  const oauthTokenId = oauthTokenValue === null
    ? undefined
    : typeof oauthTokenValue === "string" ? oauthTokenValue.trim() : existing?.oauthTokenId;
  if ((installationId === undefined || installationId === "") && (oauthTokenId === undefined || oauthTokenId === "")) {
    return { error: "A GitHub App installation or OAuth token is required" };
  }

  if (installationId !== undefined && installationId !== "") {
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.id, installationId), eq(githubAppInstallations.orgId, orgId)),
    });
    if (installation === undefined) return { error: "GitHub App installation is not registered in this organization" };
  }
  if (oauthTokenId !== undefined && oauthTokenId !== "") {
    const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, oauthTokenId) });
    const client = token === undefined
      ? undefined
      : await db.query.oauthClients.findFirst({
          where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, orgId)),
        });
    if (client === undefined) return { error: "OAuth token is not registered in this organization" };
  }

  const branchValue = raw.branch;
  if (branchValue !== undefined && branchValue !== null && typeof branchValue !== "string") {
    return { error: "branch must be a string or null" };
  }
  const tagsRegexValue = raw["tags-regex"] ?? raw.tagsRegex;
  if (tagsRegexValue !== undefined && tagsRegexValue !== null && typeof tagsRegexValue !== "string") {
    return { error: "tags-regex must be a string or null" };
  }
  const tagsRegex = tagsRegexValue === null
    ? undefined
    : typeof tagsRegexValue === "string" ? tagsRegexValue : existing?.tagsRegex;
  if (tagsRegex !== undefined) {
    if (tagsRegex.length > 256) return { error: "tags-regex must be at most 256 characters" };
    if (!isValidTagsRegex(tagsRegex)) return { error: "tags-regex must be a valid, non-pathological regular expression" };
  }
  const ingressValue = raw["ingress-submodules"] ?? raw.ingressSubmodules;
  if (ingressValue !== undefined && typeof ingressValue !== "boolean") {
    return { error: "ingress-submodules must be a boolean" };
  }

  const value: WorkspaceVcsRepo = { identifier };
  const branch = branchValue === null
    ? undefined
    : typeof branchValue === "string" ? branchValue : existing?.branch;
  const ingressSubmodules = typeof ingressValue === "boolean" ? ingressValue : existing?.ingressSubmodules;
  if (branch !== undefined) value.branch = branch;
  if (oauthTokenId !== undefined && oauthTokenId !== "") value.oauthTokenId = oauthTokenId;
  if (installationId !== undefined && installationId !== "") value.githubAppInstallationId = installationId;
  if (ingressSubmodules !== undefined) value.ingressSubmodules = ingressSubmodules;
  if (tagsRegex !== undefined) value.tagsRegex = tagsRegex;
  const cloneUrl: unknown = existing?.cloneUrl;
  if (typeof cloneUrl === "string") value.cloneUrl = cloneUrl;
  return { value };
}

// Attach the workspace's latest state outputs (type "workspace-outputs") to a
// workspace resource when the caller requests ?include=outputs (go-tfe's
// tfe_outputs data source). Returns the enriched resource plus included docs.
// Callers must already enforce workspace read access; outputs ride along for
// any reader (matches TFE, where workspace readers can read outputs; covered
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
  const outputs = workspaceOutputResources(sv);
  const dataWithRels = data as { relationships?: Record<string, unknown> };
  dataWithRels.relationships = {
    ...(dataWithRels.relationships ?? {}),
    outputs: {
      data: outputs.map((o: Record<string, unknown>): Record<string, string> => ({ id: String(o.id), type: "workspace-outputs" })),
      links: { related: `/api/v2/workspaces/${workspace.id}/current-state-version-outputs` },
    },
  };
  return { data: dataWithRels, included: outputs };
}

export const workspaceRoutes = new Elysia({ name: "workspaces" })

  .use(authPlugin)
  // --- Organization Workspaces ---
  .get("/api/v2/organizations/:org_name/workspaces", async ({ params, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId ?? null, teamId ?? null))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const searchParams = new URL(request.url).searchParams;
    const csv = (name: string): string[] => [...new Set(searchParams.get(name)?.split(",").filter(Boolean) ?? [])];
    const conditions: unknown[] = [eq(workspaces.orgId, org.id)];
    const permSets = await workspacePermissionSets(org.id, user?.id, principalOrgId ?? null, teamId ?? null);
    const allowedWorkspaceIds = permSets.read;
    if (allowedWorkspaceIds !== null) {
      conditions.push(allowedWorkspaceIds.size > 0
        ? inArray(workspaces.id, [...allowedWorkspaceIds])
        : eq(workspaces.id, "__no_authorized_workspace__"));
    }
    const search = searchParams.get("search[name]")?.trim() ?? searchParams.get("q")?.trim();
    if (search !== undefined && search !== "") conditions.push(like(workspaces.name, `%${search}%`));
    const tags = csv("search[tags]");
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
        conditions.push(workspaceIds.length > 0
          ? inArray(workspaces.id, [...new Set(workspaceIds)])
          : eq(workspaces.id, "__no_matching_workspace__"));
      }
    }
    const excludeTags = csv("search[exclude-tags]");
    if (excludeTags.length > 0) {
      const excludedIds = (await db.query.workspaceTags.findMany({
        where: inArray(workspaceTags.key, excludeTags),
        columns: { workspaceId: true },
      })).map((t: Readonly<{ workspaceId: string }>): string => t.workspaceId);
      conditions.push(notInArray(workspaces.id, [...new Set(excludedIds)]));
    }
    const projectIds = csv("filter[project][id]");
    if (projectIds.length > 0) conditions.push(inArray(workspaces.projectId, projectIds));
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
    for (const workspaceIds of matchingTagIds) {
      conditions.push(workspaceIds.length > 0
        ? inArray(workspaces.id, [...new Set(workspaceIds)])
        : eq(workspaces.id, "__no_matching_workspace__"));
    }
    const currentRunStatuses = csv("filter[current-run][status]");
    if (currentRunStatuses.length > 0) {
      // Latest run per workspace selected IN SQL (ROW_NUMBER window), scoped
      // to this org's workspaces, so a deep org run history never transfers
      // every run to the app (the runs(workspace_id, created_at) index from
      // migration 0059 serves the partition). rowid ASC tie-break preserves
      // the previous in-memory first-seen ordering for equal created_at.
      // When the access set is explicit we reuse it instead of re-reading the
      // same workspace ids via a separate org-scoped query.
      const orgWorkspaceIdRows = allowedWorkspaceIds === null
        ? await db.query.workspaces.findMany({
          where: eq(workspaces.orgId, org.id),
          columns: { id: true },
        })
        : [...allowedWorkspaceIds].map((id: string): Readonly<{ id: string }> => ({ id }));
      const latestRunRows = orgWorkspaceIdRows.length === 0
        ? []
        : db.all<{ workspaceId: string; status: string }>(sql`
          SELECT workspace_id AS workspaceId, status
          FROM (
            SELECT workspace_id, status,
              ROW_NUMBER() OVER (
                PARTITION BY workspace_id ORDER BY created_at DESC, rowid ASC
              ) AS rn
            FROM runs
            WHERE ${inArray(runs.workspaceId, orgWorkspaceIdRows.map((row): string => row.id))}
          )
          WHERE rn = 1
        `);
      const matchingWsIds = latestRunRows
        .filter((row): boolean => currentRunStatuses.includes(row.status))
        .map((row): string => row.workspaceId);
      conditions.push(matchingWsIds.length > 0
        ? inArray(workspaces.id, matchingWsIds)
        : eq(workspaces.id, "__no_matching_workspace__"));
    }
    const where = and(...(conditions as Parameters<typeof and>));
    const [wsList, countRows] = await Promise.all([
      db.query.workspaces.findMany({ where, orderBy: [asc(workspaces.name)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(workspaces).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    const canManageOrgRunTasks = await checkOrganizationPermission(org.id, user?.id, principalOrgId ?? null, teamId ?? null, "manage-run-tasks");
    // Batch the per-row N+1 (workspace_tags + org name): one query for the
    // whole page instead of two per workspace. `org` is already loaded, so
    // the org name costs nothing extra.
    const tagRows = wsList.length === 0
      ? []
      : await db.query.workspaceTags.findMany({
        where: inArray(workspaceTags.workspaceId, wsList.map((w: WsItem): string => w.id)),
        orderBy: [asc(workspaceTags.key)],
      });
    const tagsByWorkspace = new Map<string, DeepReadonly<typeof workspaceTags.$inferSelect>[]>();
    for (const tag of tagRows) {
      const list = tagsByWorkspace.get(tag.workspaceId) ?? [];
      list.push(tag);
      tagsByWorkspace.set(tag.workspaceId, list);
    }
    const data = await Promise.all(wsList.map(async (w: WsItem): Promise<Record<string, unknown>> =>
      workspaceResource(w, org.defaultIacBinary, {
        canAdmin: workspaceAllows(permSets.admin, w.id),
        canApply: workspaceAllows(permSets.apply, w.id),
        canLock: workspaceAllows(permSets.lock, w.id),
        canManageRunTasks: canManageOrgRunTasks && workspaceAllows(permSets.runTasks, w.id),
        canPlan: workspaceAllows(permSets.plan, w.id),
        canReadStateVersions: workspaceAllows(permSets.stateRead, w.id),
        canWriteStateVersions: workspaceAllows(permSets.stateWrite, w.id),
        canReadVariables: workspaceAllows(permSets.variablesRead, w.id),
        canWriteVariables: workspaceAllows(permSets.variablesWrite, w.id),
      }, {
        orgName: org.name,
        tags: tagsByWorkspace.get(w.id) ?? [],
      })));
    return { data, ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/organizations/:org_name/workspaces", async ({ params, body, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrganizationPermission(org.id, user?.id, principalOrgId ?? null, teamId ?? null, "manage-workspaces"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    const description = attributes.description;
    const autoApply = typeof attributes["auto-apply"] === "boolean" ? attributes["auto-apply"] : false;
    const terraformVersion = attributes["terraform-version"];
    const workingDirectory = attributes["working-directory"];
    const sourceName = typeof attributes["source-name"] === "string" ? attributes["source-name"] : null;
    const sourceUrl = typeof attributes["source-url"] === "string" ? attributes["source-url"] : null;
    const source = typeof attributes.source === "string" ? attributes.source : "tfe-api";
    const iacBinary = attributes["iac-binary"];
    let executionMode = attributes["execution-mode"];
    if (executionMode === undefined && typeof attributes.operations === "boolean") {
      executionMode = attributes.operations ? "remote" : "local";
    }
    const globalRemoteState = attributes["global-remote-state"] === true;
    const projectRemoteState = attributes["project-remote-state"] === true;
    if (globalRemoteState && projectRemoteState) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "global-remote-state and project-remote-state cannot both be true" }] };
    }
    const rawAgentPoolId = attributes["agent-pool-id"];
    const rawAutoDestroyActivityDuration = attributes["auto-destroy-activity-duration"];
    const rawSettingOverwrites = attributes["setting-overwrites"];
    const rawVcsRepo = attributes["vcs-repo"];
    const ownedByType = attributes["owned-by-type"];
    const ownedById = attributes["owned-by-id"];
    const contactEmail = attributes["contact-email"];
    if (
      ownedByType !== undefined && ownedByType !== null
      && !["team", "user", "service"].includes(ownedByType as string)
    ) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "owned-by-type must be team, user, or service" }] };
    }
    if (ownedById !== undefined && ownedById !== null && typeof ownedById !== "string") {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "owned-by-id must be a string or null" }] };
    }
    if (contactEmail !== undefined && contactEmail !== null && (typeof contactEmail !== "string" || contactEmail.length > 254)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "contact-email must be a string under 255 characters" }] };
    }
    if (name === "" || !/^[A-Za-z0-9_-]+$/.test(name)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] };
    }
    if ((await findWorkspaceByName(org.id, name)) !== undefined) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] };
    }
    if (description !== undefined && description !== null && typeof description !== "string") {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] };
    }
    if (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] };
    }
    if (executionMode !== undefined && !isExecutionMode(executionMode)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "execution-mode must be remote, local, or agent" }] };
    }
    if (iacBinary !== undefined && iacBinary !== null && typeof iacBinary === "string" && !["tofu", "terraform"].includes(iacBinary)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] };
    }
    let vcsRepo: typeof workspaces.$inferInsert.vcsRepo;
    if (rawVcsRepo !== undefined && rawVcsRepo !== null) {
      const normalized = await normalizeVcsRepo(rawVcsRepo, org.id);
      if ("error" in normalized) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: normalized.error }] };
      }
      vcsRepo = normalized.value;
    }
    let normalizedWorkingDirectory: string | null = null;
    if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory === "string") {
      try { normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory); } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Invalid working directory";
        (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: msg }] };
      }
    }
    const id = `ws-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const rawTagBindings = rels["tag-bindings"] as Record<string, unknown> | undefined;
    const tagBindingsData = rawTagBindings?.data;
    const tagBindings = tagBindingsData === undefined ? undefined : parseTagBindings(tagBindingsData);
    if (tagBindingsData !== undefined && tagBindings === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid tag bindings" }] };
    }
    let project: typeof projects.$inferSelect | undefined;
    if (rels.project === undefined || (typeof rels.project === "object" && rels.project !== null && (rels.project as Record<string, unknown>).data === null)) {
      project = await ensureDefaultProject(org.id);
    } else {
      const projRel = typeof rels.project === "object" && rels.project !== null ? rels.project as Record<string, unknown> : {};
      const projData = typeof projRel.data === "object" && projRel.data !== null ? projRel.data as Record<string, unknown> : {};
      const projectId = typeof projData.id === "string" ? projData.id : "";
      project = await db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.orgId, org.id)) });
      if (project === undefined || (projData.type !== undefined && projData.type !== "projects")) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Project must belong to the workspace organization" }] };
      }
    }
    const parsedOverwrites = parseSettingOverwrites(rawSettingOverwrites, undefined);
    if ("error" in parsedOverwrites) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: parsedOverwrites.error }] };
    }
    const suppliedOverwrites = rawSettingOverwrites as Record<string, unknown> | undefined;
    const executionOverride = executionMode !== undefined || suppliedOverwrites?.["execution-mode"] === true;
    const agentPoolOverride = suppliedOverwrites?.["agent-pool"] as boolean | undefined ?? rawAgentPoolId !== undefined;
    if (executionOverride && executionMode === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "execution-mode is required when setting-overwrites.execution-mode is true" }] };
    }
    const effectiveExecutionMode = executionOverride
      ? typeof executionMode === "string" ? executionMode : "remote"
      : project.defaultExecutionMode ?? "remote";
    if (rawAgentPoolId !== undefined && rawAgentPoolId !== null && typeof rawAgentPoolId !== "string") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent-pool-id must be a string or null" }] };
    }
    const agentPoolId = effectiveExecutionMode === "agent"
      ? agentPoolOverride ? typeof rawAgentPoolId === "string" ? rawAgentPoolId : null : project.defaultAgentPoolId
      : null;
    if (effectiveExecutionMode === "agent" && agentPoolId === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "An agent pool is required for agent execution mode" }] };
    }
    if (effectiveExecutionMode !== "agent" && typeof rawAgentPoolId === "string") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent-pool-id is only valid for agent execution mode" }] };
    }
    if (agentPoolId !== null) {
      const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, agentPoolId) });
      if (pool?.orgId !== org.id) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Agent pool must belong to the workspace organization" }] };
      }
      if (!(await agentPoolAllowsWorkspace(pool, id, project.id))) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Agent pool is not allowed for this workspace or project" }] };
      }
    }
    if (
      rawAutoDestroyActivityDuration !== undefined
      && rawAutoDestroyActivityDuration !== null
      && !isAutoDestroyDuration(rawAutoDestroyActivityDuration)
    ) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "auto-destroy-activity-duration must be null or a duration such as 14d or 24h" }] };
    }
    const inheritsProjectAutoDestroy = rawAutoDestroyActivityDuration === undefined;
    const workspaceSettingOverwrites = {
      ...parsedOverwrites.value,
      "execution-mode": executionOverride,
      "agent-pool": agentPoolOverride,
    };
    const lockedTagKey = await findLockedInheritedTagKey(org.id, project.id, tagBindings?.map((binding): string => binding.key) ?? []);
    if (lockedTagKey !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Tag key "${lockedTagKey}" cannot override its inherited project tag` }] };
    }
    const finalDesc = typeof description === "string" ? description : null;
    const finalTfVer = typeof terraformVersion === "string" ? terraformVersion : "latest";
    const finalIac = typeof iacBinary === "string"
      ? iacBinary
      : request.headers.get("terraform-version") !== null ? "terraform" : (org.defaultIacBinary ?? null);
    await db.insert(workspaces).values({
      id, name, orgId: org.id, description: finalDesc, projectId: project.id,
      autoApply, terraformVersion: finalTfVer,
      workingDirectory: normalizedWorkingDirectory, sourceName,
      sourceUrl, source, iacBinary: finalIac, vcsRepo,
      executionMode: effectiveExecutionMode,
      agentPoolId,
      autoDestroyActivityDuration: inheritsProjectAutoDestroy
        ? project.autoDestroyActivityDuration
        : rawAutoDestroyActivityDuration,
      inheritsProjectAutoDestroy,
      settingOverwrites: workspaceSettingOverwrites,
      ownedByType: ownedByType === undefined || ownedByType === null ? null : ownedByType as "team" | "user" | "service",
      ownedById: ownedById === undefined || ownedById === null ? null : ownedById as string,
      contactEmail: contactEmail === undefined || contactEmail === null ? null : contactEmail as string,
      createdAt: Date.now(),
    });
    if (tagBindings !== undefined && tagBindings.length > 0) {
      await db.insert(workspaceTags).values(tagBindings.map((binding): typeof workspaceTags.$inferInsert => ({
        id: crypto.randomUUID(),
        workspaceId: id,
        key: binding.key,
        value: binding.value,
      })));
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await auditLog("create", "workspaces", id, user?.id ?? null, org.id, {
      name: ws.name,
      projectId: ws.projectId,
    });
    (set as { status: number }).status = 201;
    return {
      data: await workspaceResource(
        ws,
        org.defaultIacBinary,
        await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
        { orgName: org.name },
      ),
    };
  })
  .get("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const workspaceName = params.workspace_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const data = await workspaceResource(
      ws,
      org.defaultIacBinary,
      await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
      { orgName: org.name },
    );
    return maybeAttachOutputs(data, ws, new URL(request.url).searchParams.get("include") ?? "");
  })
  .patch("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params, body, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const workspaceName = params.workspace_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return updateWorkspaceResponse(
      ws,
      org.defaultIacBinary,
      { userId: user?.id, principalOrgId: principalOrgId ?? null, teamId: teamId ?? null },
      body,
      set,
      org.name,
    );
  })
  .delete("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params.org_name ?? "";
    const workspaceName = params.workspace_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    await deleteWorkspaceData(ws.id);
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/organizations/:org_name/workspaces/:workspace_name/actions/safe-delete", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const workspaceName = params.workspace_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ok = await safeDeleteWorkspace(ws.id);
    if (!ok) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace contains managed resources" }] }; }
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/workspaces/:workspace_id", async ({ params, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await cachedOrgById(ws.orgId);
    const data = await workspaceResource(
      ws,
      org?.defaultIacBinary,
      await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
      { orgName: org?.name ?? null },
    );
    return maybeAttachOutputs(data, ws, new URL(request.url).searchParams.get("include") ?? "");
  })
  .get("/api/v2/workspaces/:workspace_id/resources", async ({ params, user, orgId: principalOrgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
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
      const jsonStateSource = latestState.jsonState ?? latestState.statePayload ?? null;
      if (jsonStateSource !== null) {
        try {
          const parsed: unknown = typeof jsonStateSource === "string"
            ? JSON.parse(jsonStateSource) as unknown
            : jsonStateSource;
          const rawResources = parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>).resources
            : undefined;
          const resList = Array.isArray(rawResources) ? rawResources : [];
          const dateStr = new Date(latestState.createdAt).toISOString().split("T")[0];

          for (const r of resList) {
            if (r !== null && typeof r === "object") {
              const rObj = r as Record<string, unknown>;
              const rType = typeof rObj.type === "string" ? rObj.type : "resource";
              const rName = typeof rObj.name === "string" ? rObj.name : "unnamed";
              const mod = typeof rObj.module === "string" && rObj.module !== "" ? rObj.module : "root";
              const address = mod === "root" ? `${rType}.${rName}` : `${mod}.${rType}.${rName}`;

              let provider = "hashicorp/provider";
              if (typeof rObj.provider === "string") {
                const match = /provider\["[^"]*\/([^"]+)"\]/.exec(rObj.provider)
                  ?? /provider\["([^"]+)"\]/.exec(rObj.provider);
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
    const workspaceId = params.workspace_id ?? "";
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
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "state-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const latestRun = await db.query.runs.findFirst({
      where: eq(runs.workspaceId, workspaceId),
      orderBy: [desc(runs.createdAt)],
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
  .patch("/api/v2/workspaces/:workspace_id", async ({ params, body, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await cachedOrgById(ws.orgId);
    return updateWorkspaceResponse(
      ws,
      org?.defaultIacBinary,
      { userId: user?.id, principalOrgId: principalOrgId ?? null, teamId: teamId ?? null },
      body,
      set,
      org?.name ?? null,
    );
  })
  .delete("/api/v2/workspaces/:workspace_id", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    await deleteWorkspaceData(ws.id);
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/workspaces/:workspace_id/actions/safe-delete", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ok = await safeDeleteWorkspace(ws.id);
    if (!ok) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace contains managed resources" }] }; }
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Tags ---
  .get("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId), orderBy: [asc(workspaceTags.key)] });
    return { data: tags.map((t: TagItem): Record<string, unknown> => tagBindingResource(t)) };
  })
  .get("/api/v2/workspaces/:workspace_id/effective-tag-bindings", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
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
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data;
    const tags = Array.isArray(data) ? data : (data !== null && data !== undefined ? [data] : []);
    const entries = tags.map((t: unknown): { key: string; value: string } => {
      const item = t !== null && typeof t === "object" ? (t as Record<string, unknown>) : {};
      const attrs = typeof item.attributes === "object" && item.attributes !== null ? (item.attributes as Record<string, unknown>) : {};
      const key = typeof attrs.key === "string" ? attrs.key : "";
      const value = typeof attrs.value === "string" ? attrs.value : "";
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
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId) });
    return { data: tags.map((t: TagItem): Record<string, string> => ({ id: t.key, type: "tags" })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params, body, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    const entries = new Map<string, string>();
    for (const item of Array.isArray(items) ? items : []) {
      if (item !== null && typeof item === "object") {
        const itemObj = item as Record<string, unknown>;
        const attrs = typeof itemObj.attributes === "object" && itemObj.attributes !== null ? (itemObj.attributes as Record<string, unknown>) : {};
        const keyVal = attrs.key ?? itemObj.id;
        const key = typeof keyVal === "string" ? keyVal : "";
        if (key !== "") entries.set(key, typeof attrs.value === "string" ? attrs.value : "");
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
  .delete("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params, body, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      const keys = items.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== "");
      if (keys.length > 0) await db.delete(workspaceTags).where(and(eq(workspaceTags.workspaceId, workspaceId), inArray(workspaceTags.key, keys)));
    }
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Workspace Variables ---
  .get("/api/v2/workspaces/:workspace_id/vars", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
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
  .post("/api/v2/workspaces/:workspace_id/vars", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "variables-write");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    if (data?.type !== "vars" || !validVariableAttributes(attributes)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const varId = `wsvar-${crypto.randomUUID()}`;
    const key = typeof attributes.key === "string" ? attributes.key : "";
    const value = typeof attributes.value === "string" ? attributes.value : "";
    const category = typeof attributes.category === "string" ? attributes.category : "terraform";
    const sensitive = typeof attributes.sensitive === "boolean" ? attributes.sensitive : false;
    const hcl = typeof attributes.hcl === "boolean" ? attributes.hcl : false;
    const description = typeof attributes.description === "string" ? attributes.description : null;
    await db.insert(workspaceVariables).values({ id: varId, workspaceId, key, value, category, sensitive, hcl, description });
    (set as { status: number }).status = 201;
    return { data: workspaceVariableResource({ id: varId, workspaceId, key, value, category, sensitive, hcl, description }) };
  })
  .get("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const varId = params.var_id ?? "";
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
    const workspaceId = params.workspace_id ?? "";
    const varId = params.var_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "variables-write");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)) });
    if (variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    if (data?.type !== "vars" || !validVariableAttributes(attrs, true)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    let sensitive = typeof attrs.sensitive === "boolean" ? attrs.sensitive : (variable.sensitive ?? false);
    if ((variable.sensitive ?? false) && !sensitive && attrs.value === undefined) sensitive = true;
    const key = typeof attrs.key === "string" ? attrs.key : variable.key;
    const value = typeof attrs.value === "string" ? attrs.value : variable.value;
    const category = typeof attrs.category === "string" ? attrs.category : variable.category;
    const hcl = typeof attrs.hcl === "boolean" ? attrs.hcl : (variable.hcl ?? false);
    const description = typeof attrs.description === "string" ? attrs.description : variable.description;
    const updated = { key, value, category, sensitive, hcl, description };
    try {
      await db.update(workspaceVariables).set(updated).where(eq(workspaceVariables.id, varId));
    } catch (error: unknown) {
      const isUnique: boolean = isUniqueConstraintError(error);
      if (isUnique) {
        (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this workspace" }] };
      }
      throw error;
    }
    return { data: workspaceVariableResource({ ...variable, ...updated }) };
  })
  .delete("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const varId = params.var_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null, "variables-write");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)) });
    if (variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, varId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Lock/Unlock ---
  .post("/api/v2/workspaces/:workspace_id/actions/lock", async ({ params, body, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {

    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "lock"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (ws.locked === true) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is already locked" }] }; }
    const lockReason = parseLockReason(body);
    if (lockReason.error !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: lockReason.error }] };
    }

    await db.update(workspaces).set({ locked: true, lockedReason: lockReason.reason }).where(eq(workspaces.id, workspaceId));
    await auditLog("lock", "workspaces", workspaceId, user?.id ?? null, ws.orgId, teamId !== null && teamId !== undefined ? { teamId } : undefined);
    const org = await cachedOrgById(ws.orgId);
    return {
      data: await workspaceResource(
        { ...ws, locked: true, lockedReason: lockReason.reason },
        org?.defaultIacBinary,
        await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
        { orgName: org?.name ?? null },
      ),
    };
  })

  .post("/api/v2/workspaces/:workspace_id/actions/unlock", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(ws, user?.id, principalOrgId ?? null, teamId ?? null, "lock"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (ws.locked !== true) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is not locked" }] }; }
    await promoteIntermediateStateVersion(workspaceId);
    await db.update(workspaces).set({ locked: false, lockedReason: null }).where(eq(workspaces.id, workspaceId));
    const org = await cachedOrgById(ws.orgId);
    return {
      data: await workspaceResource(
        { ...ws, locked: false, lockedReason: null },
        org?.defaultIacBinary,
        await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
        { orgName: org?.name ?? null },
      ),
    };
  })
  .post("/api/v2/workspaces/:workspace_id/actions/force-unlock", async ({ params, user, orgId: principalOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await promoteIntermediateStateVersion(workspaceId);
    await db.update(workspaces).set({ locked: false, lockedReason: null }).where(eq(workspaces.id, workspaceId));
    const org = await cachedOrgById(ws.orgId);
    return {
      data: await workspaceResource(
        { ...ws, locked: false, lockedReason: null },
        org?.defaultIacBinary,
        await resourcePermissions(ws, user?.id, principalOrgId ?? null, teamId ?? null),
        { orgName: org?.name ?? null },
      ),
    };
  })
  // --- Remote State Consumers ---
  .get("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const consumers = await db.query.remoteStateConsumers.findMany({ where: eq(remoteStateConsumers.workspaceId, workspaceId) });
    return { data: consumers.map((c: Readonly<{ consumerWorkspaceId: string }>): Record<string, string> => ({ id: c.consumerWorkspaceId, type: "workspaces" })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    const list = Array.isArray(items) ? items : (items !== null && items !== undefined ? [items] : []);
    const batch: { id: string; workspaceId: string; consumerWorkspaceId: string }[] = [];
    for (const item of list) {
      if (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
        const consumerWorkspaceId = (item as Record<string, unknown>).id as string;
        batch.push({ id: `rsc-${crypto.randomUUID()}`, workspaceId, consumerWorkspaceId });
      }
    }
    if (batch.length > 0) await db.insert(remoteStateConsumers).values(batch).onConflictDoNothing();
    (set as { status: number }).status = 204;
    return {};
  })
  .patch("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(remoteStateConsumers).where(eq(remoteStateConsumers.workspaceId, workspaceId));
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    const list = Array.isArray(items) ? items : (items !== null && items !== undefined ? [items] : []);
    const batch: { id: string; workspaceId: string; consumerWorkspaceId: string }[] = [];
    for (const item of list) {
      if (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
        const consumerWorkspaceId = (item as Record<string, unknown>).id as string;
        batch.push({ id: `rsc-${crypto.randomUUID()}`, workspaceId, consumerWorkspaceId });
      }
    }
    if (batch.length > 0) await db.insert(remoteStateConsumers).values(batch).onConflictDoNothing();
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      const ids = items.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== "");
      if (ids.length > 0) await db.delete(remoteStateConsumers).where(and(eq(remoteStateConsumers.workspaceId, workspaceId), inArray(remoteStateConsumers.consumerWorkspaceId, ids)));
    }
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Data Retention ---
  .get("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
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
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const existing = await db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspaceId) });
    const pid = existing?.id ?? `drp-${crypto.randomUUID()}`;
    const policyType = typeof data?.type === "string" ? data.type : null;
    const rawDeleteOlderThanNDays = attrs["delete-older-than-n-days"] ?? attrs.deleteOlderThanNDays;
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
    (set as { status: number }).status = 201;
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
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const gcSummary = await applyDataRetentionGarbageCollection(workspaceId);
    return { data: { status: "ok", ...gcSummary } };
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(dataRetentionPolicies).where(eq(dataRetentionPolicies.workspaceId, workspaceId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- SSH Key assignment ---
  .patch("/api/v2/workspaces/:workspace_id/relationships/ssh-key", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, teamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const sshKeyData = payload.data as Record<string, unknown> | undefined;
    const sshKeyId = typeof sshKeyData?.id === "string" ? sshKeyData.id : null;
    await db.update(workspaces).set({ sshKeyId }).where(eq(workspaces.id, workspaceId));
    return { data: { id: workspaceId, type: "workspaces", relationships: { "ssh-key": { data: sshKeyId !== null ? { id: sshKeyId, type: "ssh-keys" } : null } } } };
  });

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
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload.data as Record<string, unknown> | undefined;
  const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
  const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
  const rawTagBindings = rels["tag-bindings"] as Record<string, unknown> | undefined;
  const tagBindingsData = rawTagBindings !== undefined ? rawTagBindings.data : undefined;
  const tagBindings = tagBindingsData === undefined ? undefined : parseTagBindings(tagBindingsData);
  const name = typeof attributes.name === "string" ? attributes.name : undefined;
  const description = attributes.description;
  const autoApply = typeof attributes["auto-apply"] === "boolean" ? attributes["auto-apply"] : undefined;
  const terraformVersion = typeof attributes["terraform-version"] === "string" ? attributes["terraform-version"] : undefined;
  const workingDirectory = attributes["working-directory"];
  const sourceName = attributes["source-name"];
  const sourceUrl = attributes["source-url"];
    const source = typeof attributes.source === "string" ? attributes.source : undefined;
  const iacBinary = attributes["iac-binary"];
  let executionMode = attributes["execution-mode"];
  if (executionMode === undefined && typeof attributes.operations === "boolean") {
    executionMode = attributes.operations ? "remote" : "local";
  }
  const rawAgentPoolId = attributes["agent-pool-id"];
  const rawAutoDestroyActivityDuration = attributes["auto-destroy-activity-duration"];
  const rawInheritsProjectAutoDestroy = attributes["inherits-project-auto-destroy"];
  const rawSettingOverwrites = attributes["setting-overwrites"];
  const rawVcsRepo = attributes["vcs-repo"];

  const newGlobal = typeof attributes["global-remote-state"] === "boolean" ? attributes["global-remote-state"] : workspace.globalRemoteState;
  const newProject = typeof attributes["project-remote-state"] === "boolean" ? attributes["project-remote-state"] : workspace.projectRemoteState;
  if (newGlobal === true && newProject === true) {
    (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "global-remote-state and project-remote-state cannot both be true" }] };
  }

  if (tagBindingsData !== undefined && tagBindings === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid tag bindings" }] }; }
  if (name !== undefined && !/^[A-Za-z0-9_-]+$/.test(name)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] }; }
  if (description !== undefined && description !== null && typeof description !== "string") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] }; }
  if ((sourceName !== undefined && sourceName !== null && typeof sourceName !== "string") || (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== "string")) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "source-name and source-url must be strings or null" }] }; }
  if (terraformVersion !== undefined && !validateVersion(terraformVersion)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] }; }
  if (executionMode !== undefined && !isExecutionMode(executionMode)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "execution-mode must be remote, local, or agent" }] }; }
  if (iacBinary !== undefined && iacBinary !== null && typeof iacBinary === "string" && !["tofu", "terraform"].includes(iacBinary)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] }; }
  if (rawAgentPoolId !== undefined && rawAgentPoolId !== null && typeof rawAgentPoolId !== "string") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent-pool-id must be a string or null" }] }; }
  if (rawAutoDestroyActivityDuration !== undefined && rawAutoDestroyActivityDuration !== null && !isAutoDestroyDuration(rawAutoDestroyActivityDuration)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "auto-destroy-activity-duration must be null or a duration such as 14d or 24h" }] }; }
  if (rawInheritsProjectAutoDestroy !== undefined && typeof rawInheritsProjectAutoDestroy !== "boolean") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "inherits-project-auto-destroy must be a boolean" }] }; }
  if (rawAutoDestroyActivityDuration !== undefined && rawInheritsProjectAutoDestroy === true) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "An auto-destroy override cannot also inherit from the project" }] }; }
  const rawOwnedByType = attributes["owned-by-type"];
  if (rawOwnedByType !== undefined && rawOwnedByType !== null && !["team", "user", "service"].includes(rawOwnedByType as string)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "owned-by-type must be team, user, or service" }] }; }
  const rawOwnedById = attributes["owned-by-id"];
  if (rawOwnedById !== undefined && rawOwnedById !== null && typeof rawOwnedById !== "string") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "owned-by-id must be a string or null" }] }; }
  const rawContactEmail = attributes["contact-email"];
  if (rawContactEmail !== undefined && rawContactEmail !== null && (typeof rawContactEmail !== "string" || rawContactEmail.length > 254)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "contact-email must be a string under 255 characters" }] }; }

  let normalizedWorkingDirectory = workspace.workingDirectory;
  if (workingDirectory !== undefined && typeof workingDirectory === "string") {
    try { normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory); } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Invalid working directory";
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: msg }] };
    }
  }

  if (name !== undefined && name !== workspace.name) {
    const duplicate = await findWorkspaceByName(workspace.orgId, name);
    if (duplicate !== undefined && duplicate.id !== workspace.id) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] }; }
  }

  const projectRel = rels.project;
  let project: typeof projects.$inferSelect | undefined;
  if (projectRel === undefined && workspace.projectId !== null) {
    project = await db.query.projects.findFirst({
      where: and(eq(projects.id, workspace.projectId), eq(projects.orgId, workspace.orgId)),
    });
  } else if (
    projectRel === undefined
    || (typeof projectRel === "object" && projectRel !== null && (projectRel as Record<string, unknown>).data === null)
  ) {
    project = await ensureDefaultProject(workspace.orgId);
  } else {
    const relationship = typeof projectRel === "object" && projectRel !== null ? projectRel as Record<string, unknown> : {};
    const projectData = typeof relationship.data === "object" && relationship.data !== null ? relationship.data as Record<string, unknown> : {};
    const projectId = typeof projectData.id === "string" ? projectData.id : "";
    if (projectData.type !== undefined && projectData.type !== "projects") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid project relationship" }] };
    }
    project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, workspace.orgId)),
    });
  }
  if (project === undefined) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Project must belong to the workspace organization" }] };
  }
  const newProjectId = project.id;
  const parsedOverwrites = parseSettingOverwrites(rawSettingOverwrites, workspace.settingOverwrites);
  if ("error" in parsedOverwrites) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: parsedOverwrites.error }] };
  }
  const suppliedOverwrites = rawSettingOverwrites as Record<string, unknown> | undefined;
  const workspaceSettingOverwrites: Record<string, boolean> = {
    "agent-pool": false,
    ...parsedOverwrites.value,
  };
  if (executionMode !== undefined) {
    workspaceSettingOverwrites["execution-mode"] = true;
  }
  if (rawAgentPoolId !== undefined && suppliedOverwrites?.["agent-pool"] === undefined) {
    workspaceSettingOverwrites["agent-pool"] = true;
  }
  const effectiveExecutionMode = workspaceSettingOverwrites["execution-mode"] === true
    ? typeof executionMode === "string" ? executionMode : workspace.executionMode
    : project.defaultExecutionMode ?? "remote";
  const effectiveAgentPoolId = effectiveExecutionMode === "agent"
    ? workspaceSettingOverwrites["agent-pool"] === true
      ? rawAgentPoolId !== undefined ? rawAgentPoolId : workspace.agentPoolId
      : project.defaultAgentPoolId
    : null;
  if (effectiveExecutionMode === "agent" && effectiveAgentPoolId === null) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "An agent pool is required for agent execution mode" }] };
  }
  if (effectiveExecutionMode !== "agent" && typeof rawAgentPoolId === "string") {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent-pool-id is only valid for agent execution mode" }] };
  }
  if (effectiveAgentPoolId !== null) {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, effectiveAgentPoolId) });
    if (pool?.orgId !== workspace.orgId) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Agent pool must belong to the workspace organization" }] };
    }
    if (!(await agentPoolAllowsWorkspace(pool, workspace.id, newProjectId))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Agent pool is not allowed for this workspace or project" }] };
    }
  }
  const inheritsProjectAutoDestroy = rawAutoDestroyActivityDuration !== undefined
    ? false
    : rawInheritsProjectAutoDestroy === true
      ? true
      : rawInheritsProjectAutoDestroy === false
        ? false
        : workspace.inheritsProjectAutoDestroy;
  const effectiveAutoDestroyActivityDuration = rawAutoDestroyActivityDuration !== undefined
    ? rawAutoDestroyActivityDuration
    : inheritsProjectAutoDestroy
      ? project.autoDestroyActivityDuration
      : workspace.autoDestroyActivityDuration;
  const overrideKeys = tagBindings !== undefined
    ? tagBindings.map((binding): string => binding.key)
    : newProjectId !== workspace.projectId
      ? (await db.query.workspaceTags.findMany({
          where: eq(workspaceTags.workspaceId, workspace.id),
          columns: { key: true },
        })).map((tag: Readonly<{ key: string }>): string => tag.key)
      : [];
  const lockedTagKey = await findLockedInheritedTagKey(workspace.orgId, newProjectId, overrideKeys);
  if (lockedTagKey !== undefined) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Tag key "${lockedTagKey}" cannot override its inherited project tag` }] };
  }
  let newVcsRepo = workspace.vcsRepo;
  if (rawVcsRepo !== undefined) {
    const normalized = await normalizeVcsRepo(rawVcsRepo, workspace.orgId, workspace.vcsRepo ?? undefined);
    if ("error" in normalized) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: normalized.error }] };
    }
    newVcsRepo = normalized.value;
  }

  const updated: Partial<typeof workspaces.$inferInsert> = {
    name: name ?? workspace.name,
    description: typeof description === "string" ? description : (description === null ? null : workspace.description),
    projectId: newProjectId,
    autoApply: autoApply ?? workspace.autoApply,
    autoApplyRunTrigger: typeof attributes["auto-apply-run-trigger"] === "boolean" ? attributes["auto-apply-run-trigger"] : workspace.autoApplyRunTrigger,
    fileTriggersEnabled: typeof attributes["file-triggers-enabled"] === "boolean" ? attributes["file-triggers-enabled"] : workspace.fileTriggersEnabled,
    triggerPrefixes: Array.isArray(attributes["trigger-prefixes"]) ? (attributes["trigger-prefixes"] as string[]) : workspace.triggerPrefixes === null ? null : [...workspace.triggerPrefixes],
    triggerPatterns: Array.isArray(attributes["trigger-patterns"]) ? (attributes["trigger-patterns"] as string[]) : workspace.triggerPatterns === null ? null : [...workspace.triggerPatterns],
    vcsRepo: newVcsRepo,
    queueAllRuns: typeof attributes["queue-all-runs"] === "boolean" ? attributes["queue-all-runs"] : workspace.queueAllRuns,
    speculativeEnabled: typeof attributes["speculative-enabled"] === "boolean" ? attributes["speculative-enabled"] : workspace.speculativeEnabled,
    allowDestroyPlan: typeof attributes["allow-destroy-plan"] === "boolean" ? attributes["allow-destroy-plan"] : workspace.allowDestroyPlan,
    globalRemoteState: typeof attributes["global-remote-state"] === "boolean" ? attributes["global-remote-state"] : workspace.globalRemoteState,
    projectRemoteState: typeof attributes["project-remote-state"] === "boolean" ? attributes["project-remote-state"] : workspace.projectRemoteState,
    executionMode: effectiveExecutionMode,
    agentPoolId: effectiveAgentPoolId,
    assessmentsEnabled: typeof attributes["assessments-enabled"] === "boolean" ? attributes["assessments-enabled"] : workspace.assessmentsEnabled,
    autoDestroyAt: typeof attributes["auto-destroy-at"] === "string" ? attributes["auto-destroy-at"] : workspace.autoDestroyAt,
    autoDestroyActivityDuration: effectiveAutoDestroyActivityDuration,
    inheritsProjectAutoDestroy,
    settingOverwrites: workspaceSettingOverwrites,
    terraformVersion: terraformVersion ?? workspace.terraformVersion,
    workingDirectory: normalizedWorkingDirectory,
    sourceName: typeof sourceName === "string" ? sourceName : (sourceName === null ? null : workspace.sourceName),
    sourceUrl: typeof sourceUrl === "string" ? sourceUrl : (sourceUrl === null ? null : workspace.sourceUrl),
    source: source ?? workspace.source,
    iacBinary: typeof iacBinary === "string" ? iacBinary : (iacBinary === null ? null : workspace.iacBinary),
    ownedByType: typeof attributes["owned-by-type"] === "string"
      ? attributes["owned-by-type"] as "team" | "user" | "service"
      : (attributes["owned-by-type"] === null ? null : workspace.ownedByType),
    ownedById: typeof attributes["owned-by-id"] === "string"
      ? attributes["owned-by-id"] as string
      : (attributes["owned-by-id"] === null ? null : workspace.ownedById),
    contactEmail: typeof attributes["contact-email"] === "string"
      ? attributes["contact-email"] as string
      : (attributes["contact-email"] === null ? null : workspace.contactEmail),
  };

  await db.update(workspaces).set(updated).where(eq(workspaces.id, workspace.id));
  if (tagBindings !== undefined) {
    await db.transaction(async (tx: unknown): Promise<void> => {
      const dbTx = tx as typeof db;
      await dbTx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspace.id));
      if (tagBindings.length > 0) {
        await dbTx.insert(workspaceTags).values(tagBindings.map((b: Readonly<{ key: string; value: string }>): { id: string; workspaceId: string; key: string; value: string } => ({ id: crypto.randomUUID(), workspaceId: workspace.id, ...b })));
      }
    });
  }
  const saved = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace.id) });
  if (saved === undefined) throw new Error("Unable to update workspace");
  return {
    data: await workspaceResource(
      saved,
      defaultIacBinary,
      await resourcePermissions(saved, principal.userId, principal.principalOrgId, principal.teamId),
      { orgName: orgName ?? null },
    ),
  };
}
