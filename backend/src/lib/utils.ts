import { db } from "../db";
import {
  users, workspaces,
  runs, stateVersions, workspaceVariables, workspaceTags,
  configurationVersions, variableSets,
  auditLogs, dataRetentionPolicies, remoteStateConsumers,
  agentPools, workspaceRunTasks, logs, organizationMemberships,
} from "../db/schema";
import { and, desc, eq, gte, inArray, like, lt, notInArray, or, sql } from "drizzle-orm";
import { validateVersion } from "../binaryManager";
import { decodeStatePayload, parseStatePayload } from "./validation";

export { validateVersion, decodeStatePayload, parseStatePayload };

const PUBLIC_URL = typeof process.env.PUBLIC_URL === "string" && process.env.PUBLIC_URL !== "" ? new URL(process.env.PUBLIC_URL) : null;

export async function auditLog(
  action: string,
  resourceType: string,
  resourceId: string | null,
  userId: string | null,
  orgId: string | null,
  details?: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId,
      userId,
      action,
      resourceType,
      resourceId,
      details: details !== undefined ? { ...details } : null,
      createdAt: Date.now(),
    });
  } catch {}
}

export async function checkOrgPermission(
  userId: string | undefined,
  orgId: string,
  requiredRole: "owner" | "member" = "member",
  tokenOrgId: string | null = null,
): Promise<boolean> {
  if (tokenOrgId !== null) return tokenOrgId === orgId && requiredRole === "member";
  if (userId === undefined) return false;
  const membership = await db.query.organizationMemberships.findFirst({
    where: and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.orgId, orgId)),
  });
  if (membership === undefined) return false;
  if (requiredRole === "owner" && membership.role !== "owner") return false;
  return true;
}

export async function findWorkspaceVar(workspaceId: string, varId: string): Promise<typeof workspaceVariables.$inferSelect | undefined> {
  return db.query.workspaceVariables.findFirst({
    where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)),
  });
}

export async function findAuthorizedVariableSet(
  variableSetId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
): Promise<typeof variableSets.$inferSelect | undefined> {
  const variableSet = await db.query.variableSets.findFirst({ where: eq(variableSets.id, variableSetId) });
  if (variableSet === undefined) return undefined;
  const hasPerm = await checkOrgPermission(userId, variableSet.orgId, "member", tokenOrgId);
  return hasPerm ? variableSet : undefined;
}

function isJsonApiData(item: unknown, expectedType: string): item is { readonly id: string; readonly type: string } {
  if (item === null || typeof item !== "object") return false;
  const i = item as Record<string, unknown>;
  return i.type === expectedType && typeof i.id === "string" && i.id !== "";
}

export function workspaceRelationshipIds(body: unknown): string[] | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const items = data as unknown[];
  if (items.some((item: unknown): boolean => !isJsonApiData(item, "workspaces"))) return undefined;
  return [...new Set(items.map((item: unknown): string => (item as { readonly id: string }).id))];
}

export function projectRelationshipIds(body: unknown): string[] | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const items = data as unknown[];
  if (items.some((item: unknown): boolean => !isJsonApiData(item, "projects"))) return undefined;
  return [...new Set(items.map((item: unknown): string => (item as { readonly id: string }).id))];
}

type VarRelationshipResult = { many: boolean; resources: unknown[] };

export function variableRelationshipResources(body: unknown): VarRelationshipResult | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.data;
  const many = Array.isArray(data);
  const resources = many ? (data as unknown[]) : [data];
  if (
    resources.length === 0
    || resources.some((item: unknown): boolean => !isJsonApiData(item, "vars"))
    || new Set(resources.map((item: unknown): string => (item as { readonly id: string }).id)).size !== resources.length
  ) return undefined;
  return { many, resources };
}

export async function findWorkspaceByName(orgId: string, name: string): Promise<typeof workspaces.$inferSelect | undefined> {
  return db.query.workspaces.findFirst({
    where: and(eq(workspaces.orgId, orgId), eq(workspaces.name, name)),
  });
}

export async function findAuthorizedWorkspace(
  workspaceId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
): Promise<typeof workspaces.$inferSelect | undefined> {
  const workspace = (await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })) as typeof workspaces.$inferSelect | undefined;
  if (workspace === undefined) return undefined;
  const hasPerm = await checkOrgPermission(userId, workspace.orgId, "member", tokenOrgId);
  return hasPerm ? workspace : undefined;
}

export async function findAuthorizedRun(runId: string, userId: string | undefined, tokenOrgId: string | null): Promise<{ run: typeof runs.$inferSelect; workspace: typeof workspaces.$inferSelect } | undefined> {
  const run = (await db.query.runs.findFirst({ where: eq(runs.id, runId) })) as typeof runs.$inferSelect | undefined;
  if (run === undefined) return undefined;
  const workspace = await findAuthorizedWorkspace(run.workspaceId, userId, tokenOrgId);
  return workspace !== undefined ? { run, workspace } : undefined;
}

export async function findLogCapability(runId: string, token: string): Promise<typeof runs.$inferSelect | undefined> {
  const { timingSafeEqual } = await import("node:crypto");
  const run = (await db.query.runs.findFirst({ where: eq(runs.id, runId) })) as typeof runs.$inferSelect | undefined;
  if (run === undefined || typeof run.logToken !== "string") return undefined;
  const expected = Buffer.from(run.logToken);
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? run : undefined;
}

type RequestWithUrl = Readonly<{ readonly url: string }>;

export function pageRequest(request: RequestWithUrl): { number: number; size: number } {
  const params = new URL(request.url).searchParams;
  const number = Number.parseInt(params.get("page[number]") ?? "1", 10);
  const size = Number.parseInt(params.get("page[size]") ?? "20", 10);
  return {
    number: Number.isSafeInteger(number) && number > 0 ? number : 1,
    size: Number.isSafeInteger(size) && size > 0 ? Math.min(size, 100) : 20,
  };
}

export function pagination(request: RequestWithUrl, currentPage: number, pageSize: number, totalCount: number): { links: Record<string, string | null>; meta: Record<string, unknown> } {
  const totalPages = Math.ceil(totalCount / pageSize);
  const pageLink = (page: number): string => {
    const url = new URL(request.url);
    url.searchParams.set("page[number]", String(page));
    url.searchParams.set("page[size]", String(pageSize));
    return url.toString();
  };

  return {
    links: {
      self: pageLink(currentPage),
      first: pageLink(1),
      prev: currentPage > 1 ? pageLink(currentPage - 1) : null,
      next: currentPage < totalPages ? pageLink(currentPage + 1) : null,
      last: pageLink(Math.max(1, totalPages)),
    },
    meta: {
      pagination: {
        "current-page": currentPage,
        "page-size": pageSize,
        "prev-page": currentPage > 1 ? currentPage - 1 : null,
        "next-page": currentPage < totalPages ? currentPage + 1 : null,
        "total-pages": totalPages,
        "total-count": totalCount,
      },
    },
  };
}

export function apiURL(request: RequestWithUrl, path: string): string {
  return new URL(path, PUBLIC_URL ?? request.url).toString();
}

export function logChunk(output: string, request: RequestWithUrl): Uint8Array {
  const params = new URL(request.url).searchParams;
  const parsedOffset = Number.parseInt(params.get("offset") ?? "0", 10);
  const parsedLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const bytes = Buffer.from(output);
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : bytes.length;
  return bytes.subarray(offset, offset + limit);
}

/** Map VCS service provider identifier to human-readable display name */
export function serviceProviderDisplayName(provider: string): string {
  const map: Record<string, string> = {
    github: "GitHub",
    github_enterprise: "GitHub Enterprise",
    gitlab: "GitLab",
    gitlab_ce: "GitLab Community Edition",
    gitlab_ee: "GitLab Enterprise Edition",
    bitbucket: "Bitbucket Cloud",
    bitbucket_data_center: "Bitbucket Data Center",
    azure_devops_server: "Azure DevOps Server",
    ado_server: "Azure DevOps Server",
  };
  return map[provider] ?? provider;
}

export function parseTagBindings(data: unknown): { key: string; value: string }[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const bindings = new Map<string, { key: string; value: string }>();
  for (const item of data) {
    const i = item as Record<string, unknown> | null;
    if (i === null) return undefined;
    const attrs = i.attributes as Record<string, unknown> | undefined;
    const key = attrs?.key as string | undefined;
    const value = typeof attrs?.value === "string" ? attrs.value : "";
    if (i.type !== "tag-bindings" || typeof key !== "string" || key.trim() === "" || typeof value !== "string") {
      return undefined;
    }
    bindings.set(key.trim(), { key: key.trim(), value });
  }
  if (bindings.size === 0) return undefined;
  return [...bindings.values()];
}

export function workspaceRunHistoryWhere(request: RequestWithUrl, workspaceId: string): ReturnType<typeof and> {
  const params = new URL(request.url).searchParams;
  const csv = (name: string): string[] | undefined => params.get(name)?.split(",").map((value: string): string => value.trim()).filter((s: string): boolean => s !== "");
  const conditions: (ReturnType<typeof eq>         | ReturnType<typeof or>)[] = [eq(runs.workspaceId, workspaceId)];
  const statuses = csv("filter[status]");
  if (statuses !== undefined && statuses.length > 0) conditions.push(inArray(runs.status, statuses));

  const operations = csv("filter[operation]");
  if (operations !== undefined && operations.length > 0) {
    const destroy = operations.includes("destroy");
    const planAndApply = operations.includes("plan_and_apply");
    if (destroy !== planAndApply) conditions.push(eq(runs.isDestroy, destroy));
    else if (!destroy) conditions.push(sql`false`);
  }

  const sources = csv("filter[source]");
  if (sources !== undefined && sources.length > 0 && !sources.includes("tfe-api")) conditions.push(sql`false`);

  const statusGroup = params.get("filter[status_group]");
  if (statusGroup === "final") conditions.push(inArray(runs.status, FINAL_RUN_STATUSES));
  else if (statusGroup === "non_final") conditions.push(notInArray(runs.status, FINAL_RUN_STATUSES));
  else if (statusGroup === "discardable") conditions.push(inArray(runs.status, DISCARDABLE_RUN_STATUSES));
  else if (statusGroup !== null && statusGroup !== "") conditions.push(sql`false`);

  const timeframe = params.get("filter[timeframe]");
  if (timeframe === "year") {
    conditions.push(gte(runs.createdAt, Date.now() - 365 * 24 * 60 * 60 * 1000));
  } else if (timeframe !== null && /^\d{4}$/.test(timeframe)) {
    const year = Number(timeframe);
    conditions.push(gte(runs.createdAt, Date.UTC(year, 0, 1)));
    conditions.push(lt(runs.createdAt, Date.UTC(year + 1, 0, 1)));
  } else if (timeframe !== null && timeframe !== "") {
    conditions.push(sql`false`);
  }

  const basic = params.get("search[basic]")?.trim();
  if (basic !== undefined && basic !== "") conditions.push(or(like(runs.id, `%${basic}%`), like(runs.message, `%${basic}%`)));

  const userSearch = params.get("search[user]")?.trim();
  if (userSearch !== undefined && userSearch !== "") {
    const userMatches = db.select({ id: users.id }).from(users)
      .where(like(users.username, `%${userSearch}%`));
    conditions.push(inArray(runs.createdBy, userMatches));
  }

  const agentPoolNames = csv("filter[agent_pool_names]");
  if (agentPoolNames !== undefined && agentPoolNames.length > 0) {
    const matchingPools = db.select({ id: agentPools.id }).from(agentPools)
      .where(inArray(agentPools.name, agentPoolNames));
    const matchingWorkspaces = db.select({ id: workspaces.id }).from(workspaces)
      .where(inArray(workspaces.agentPoolId, matchingPools));
    conditions.push(inArray(runs.workspaceId, matchingWorkspaces));
  }

  const commitSearch = params.get("search[commit]")?.trim();
  if (commitSearch !== undefined && commitSearch !== "") {
    conditions.push(
      inArray(runs.id,
        db.select({ id: runs.id }).from(runs)
          .innerJoin(configurationVersions, eq(runs.configurationVersionId, configurationVersions.id))
          .where(sql`COALESCE(json_extract(${configurationVersions.ingressAttributes}, '$.commitSha'), '') LIKE ${`%${commitSearch}%`}`)
      )
    );
  }

  return and(...conditions);
}

export const FINAL_RUN_STATUSES = [
  "applied",
  "planned_and_finished",
  "policy_soft_failed",
  "discarded",
  "errored",
  "canceled",
  "force_canceled",
];
export const CAPACITY_PENDING_STATUSES = ["pending", "queuing", "plan_queued", "apply_queued"];
export const CAPACITY_RUNNING_STATUSES = ["planning", "applying"];
export const DISCARDABLE_RUN_STATUSES = [
  "planned",
  "planned_and_saved",
  "cost_estimated",
  "policy_checked",
  "policy_override",
  "post_plan_running",
  "post_plan_completed",
];

/**
 * Delete all data associated with a workspace.
 * Uses cascade-friendly approach: deletes logs, state_versions, CVs, variables, tags, etc. directly.
 * The workspace itself is deleted by the calling route.
 */
export async function deleteWorkspaceData(workspaceId: string): Promise<void> {
  // Runs cascade to logs, policy_checks, run_comments
  const runsToDelete = await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId), columns: { id: true } });
  for (const r of runsToDelete) {
    await db.delete(logs).where(eq(logs.runId, r.id));
  }
  await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
  await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
  await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspaceId));
  await db.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspaceId));
  await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
  await db.delete(dataRetentionPolicies).where(eq(dataRetentionPolicies.workspaceId, workspaceId));
  await db.delete(remoteStateConsumers).where(or(eq(remoteStateConsumers.workspaceId, workspaceId), eq(remoteStateConsumers.consumerWorkspaceId, workspaceId)));
  await db.delete(workspaceRunTasks).where(eq(workspaceRunTasks.workspaceId, workspaceId));
}

/**
 * Safely delete a workspace — only succeeds if workspace has no managed resources.
 * Returns true if deleted, false if workspace has resources.
 */
export async function safeDeleteWorkspace(workspaceId: string): Promise<boolean> {
  // Check if workspace has state versions with actual resources
  const relevantStates = await db.query.stateVersions.findMany({
    where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")),
    columns: { statePayload: true },
    orderBy: [desc(stateVersions.serial)],
    limit: 1,
  });
  if (relevantStates.length > 0) {
    const latest = relevantStates[0];
    if (latest !== undefined && typeof latest.statePayload === "string" && latest.statePayload !== "") {
      try {
        const parsed = JSON.parse(decodeStatePayload(latest.statePayload)) as Record<string, unknown>;
        // Check if state contains any resources
        const resources = parsed.resources;
        if (resources !== undefined && Array.isArray(resources) && resources.length > 0) {
          return false; // Has managed resources
        }
      } catch {
        // If we can't parse, err on the side of allowing deletion
      }
    }
  }
  await deleteWorkspaceData(workspaceId);
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  return true;
}

/**
 * Apply data retention garbage collection for a workspace.
 * Two-phase lifecycle:
 *   1. Excess finalized state versions → backing_data_soft_deleted
 *   2. Previously soft-deleted versions → backing_data_permanently_deleted (DB row deletion)
 */
export async function applyDataRetentionGarbageCollection(workspaceId: string): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = { softDeleted: 0, permanentlyDeleted: 0, reason: "no-policy" };
  const policy = await db.query.dataRetentionPolicies.findFirst({
    where: eq(dataRetentionPolicies.workspaceId, workspaceId),
  });
  if (policy === undefined || typeof policy.stateVersionsCount !== "number" || policy.stateVersionsCount <= 0) {
    // Even without a policy, clean up previously soft-deleted records
    const stale = await db.query.stateVersions.findMany({
      where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "backing_data_soft_deleted")),
      columns: { id: true },
    });
    for (const sv of stale) {
      await db.delete(stateVersions).where(eq(stateVersions.id, sv.id));
    }
    if (stale.length > 0) return { ...summary, permanentlyDeleted: stale.length, reason: "cleanup" };
    return summary;
  }

  const count = policy.stateVersionsCount;

  // Phase 1: Soft-delete excess finalized state versions
  const finalizedVersions = await db.query.stateVersions.findMany({
    where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")),
    orderBy: [desc(stateVersions.serial)],
    columns: { id: true },
  });
  let softDeleted = 0;
  if (finalizedVersions.length > count) {
    const toSoftDelete = finalizedVersions.slice(count);
    for (const sv of toSoftDelete) {
      await db.update(stateVersions).set({ status: "backing_data_soft_deleted" }).where(eq(stateVersions.id, sv.id));
    }
    softDeleted = toSoftDelete.length;
  }

  // Phase 2: Permanently delete previously soft-deleted state versions
  const softDeletedVersions = await db.query.stateVersions.findMany({
    where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "backing_data_soft_deleted")),
    columns: { id: true },
  });
  for (const sv of softDeletedVersions) {
    await db.delete(stateVersions).where(eq(stateVersions.id, sv.id));
  }
  const permanentlyDeleted = softDeletedVersions.length;

  return { softDeleted, permanentlyDeleted, reason: "retention-applied", count: finalizedVersions.length, limit: count };
}
