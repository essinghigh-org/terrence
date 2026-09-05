import { createHash } from "node:crypto";
import { exists } from "node:fs/promises";
import { join } from "node:path";
import { Elysia } from "elysia";
import { db } from "../db";
import { storageDir } from "../db/driver";
import { agentPools, runs, workspaces, configurationVersions, logs, stateVersions, policyChecks, policyEvaluations, taskStages, runComments, auditLogs, users, organizations, notificationConfigurations, notificationConfigurationWorkspaceExclusions } from "../db/schema";
import { eq, and, desc, asc, count, inArray, ne, isNull, lt, or, gt, sql } from "drizzle-orm";
import { runResource, planResource, applyResource, userResource, taskStageResource, type RunRelationshipLinkage } from "../lib/response";
import { tfPolicyEvaluationResource, tfStageTypesForEvaluations } from "./policy-evaluations";
import { configurationVersionResource, configurationVersionIngressResource } from "./configuration-versions";
import { costEstimateResource } from "./misc";
import { validateVersion, checkOrgPermission, checkWorkspacePermission, findAuthorizedWorkspace, findAuthorizedRun, findLogCapability, pageRequest, pagination, cursorPagination, workspaceIdsForPermission, workspaceRunHistoryWhere, organizationRunHistoryWhere, apiURL, signedApiURL, CAPACITY_PENDING_STATUSES, CAPACITY_RUNNING_STATUSES, WORKSPACE_BLOCKING_RUN_STATUSES, DISCARDABLE_RUN_STATUSES, auditLog, type WorkspacePermission , type DeepReadonly, type RequestWithUrl } from "../lib/utils";
import { createConfigurationVersionFromVcs } from "../lib/webhooks";
import { deleteRunLogArchive, parseLogSliceParams, readRunLogSlice, readRunLogsPage } from "../lib/run-logs";
import { deletePlanJsonArtifact, readPlanJsonArtifact, readPlanJsonSideArtifact, sanitizePlanJson } from "../lib/plan-json";
import { readCostEstimateArtifact } from "../lib/cost-estimate";
import { costEstimationEnabledForOrganization } from "../lib/settings";
import { applyGateBlockReason } from "../lib/operations";
import { preflightBinaryAvailability } from "../binaryManager";
import { authPlugin } from "../auth";
import { queueRunNotification } from "../lib/notifications";
import { agentPoolAllowsWorkspace } from "../lib/agent-pool-scope";
import { cancelAgentJobsForRun, insertAgentApplyJobTx } from "../lib/agent-jobs";
import { revokeRunTokens } from "../lib/run-token";
import { publish } from "../lib/event-bus";
import { isPlanIncompleteRunStatus } from "../lib/run-status";
import { AvatarService } from "../lib/avatars";
import { cachedOrgByName } from "../lib/cached-lookups";
import { scheduleExplorerInventory } from "../lib/explorer-inventory";
import { runExecutionDurationMilliseconds } from "../lib/run-duration";
import { newRunId } from "../lib/run-id";
import { RUN_NOTIFICATION_TRIGGERS } from "../lib/constants";

type SetObj = { status?: number | string; headers: Record<string, string | number> };

// Statuses whose timestamps contain a terminal plan/apply marker that can be
// measured as "run duration". Speculative runs (plan_only) finish at
// planned_and_finished; applying runs finish at applied (or errored/failed).
const BASELINE_TERMINAL_STATUSES = [
  "applied", "planned_and_finished", "planned_and_saved", "errored", "failed", "canceled",
];

/**
 * Compare this run's duration against the median of the workspace's recent
 * completed runs of the same kind (destroy vs non-destroy). Returns null when
 * there is not enough history to be meaningful (fewer than 3 comparable runs
 * or this run has no measurable duration).
 */
export async function runDurationBaseline(
  run: DeepReadonly<typeof runs.$inferSelect>,
): Promise<Readonly<{
  "duration-seconds": number;
  "median-duration-seconds": number;
  "is-slow": boolean;
}> | null> {
  const durationMs = runExecutionDurationMilliseconds(run.statusTimestamps, run.planOnly === true);
  if (durationMs === null || durationMs <= 0) return null;

  const comparable = await db.query.runs.findMany({
    columns: { statusTimestamps: true },
    where: and(
      eq(runs.workspaceId, run.workspaceId),
      eq(runs.isDestroy, run.isDestroy === true),
      eq(runs.planOnly, run.planOnly === true),
      isNull(runs.softDeletedAt),
      inArray(runs.status, BASELINE_TERMINAL_STATUSES),
      ne(runs.id, run.id),
    ),
    orderBy: [desc(runs.createdAt)],
    limit: 20,
  });
  const durations: number[] = [];
  for (const other of comparable) {
    const ms = runExecutionDurationMilliseconds(other.statusTimestamps, run.planOnly === true);
    if (ms !== null && ms > 0) durations.push(ms);
  }
  if (durations.length < 3) return null;

  const sorted = [...durations].sort((a, b): number => a - b);
  const middle = (sorted.length - 1) / 2;
  const lower = sorted[Math.floor(middle)] ?? 0;
  const upper = sorted[Math.ceil(middle)] ?? 0;
  const median = (lower + upper) / 2;
  if (!Number.isFinite(median) || median <= 0) return null;

  return {
    "duration-seconds": Math.round(durationMs / 1000),
    "median-duration-seconds": Math.round(median / 1000),
    "is-slow": durationMs > median * 2,
  };
}

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: Readonly<typeof users.$inferSelect> | null;
  readonly orgId?: string | null;
  readonly teamId?: string | null;
  readonly run?: { runId: string; workspaceId: string; organizationId: string } | null;
  readonly request: Readonly<{ readonly url: string; readonly headers: Readonly<{ readonly get: (h: string) => string | null }> }>;
  readonly set: SetObj;
}>;




type RunItem = DeepReadonly<typeof runs.$inferSelect>;
type ConfigurationVersionItem = DeepReadonly<typeof configurationVersions.$inferSelect>;
const VCS_RUN_SOURCES = new Set(["bitbucket", "github", "gitlab"]);
type RunOrigin = Readonly<{ source: string; triggerReason: string; branch?: string; commitSha?: string; triggeredBy?: string; triggeredByAvatarUrl?: string; triggeredByProviderId?: string }>;
type LogItem = DeepReadonly<typeof logs.$inferSelect>;
type CommentItem = DeepReadonly<typeof runComments.$inferSelect>;
type AuditItem = DeepReadonly<typeof auditLogs.$inferSelect>;

function rawRunLogFilename(runId: string, phase: "plan" | "apply"): string {
  const safeRunId = runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  const base = safeRunId.startsWith("run-") ? safeRunId : `run-${safeRunId}`;
  return `${base}-${phase}.txt`;
}

/** Raw phase-log download (issue #585): SQL-level byte-window streaming so
 * offset polling costs O(window), with explicit truncation headers instead
 * of the old silent 10000-row cut.
 */
async function rawRunLogResponse(
  runId: string,
  phase: "plan" | "apply",
  request: Readonly<{ url: string }>,
  set: SetObj,
): Promise<Uint8Array> {
  const { offset, limit } = parseLogSliceParams(request);
  const slice = await readRunLogSlice(runId, phase, offset, limit);
  set.headers["Content-Type"] = "text/plain; charset=utf-8";
  set.headers["Content-Disposition"] = `attachment; filename="${rawRunLogFilename(runId, phase)}"`;
  set.headers["X-Terrence-Log-Total-Bytes"] = String(slice.totalBytes);
  set.headers["X-Terrence-Log-Truncated"] = slice.truncated ? "true" : "false";
  return slice.bytes;
}

function originForConfiguration(
  configuration: ConfigurationVersionItem | undefined,
): RunOrigin | undefined {
  if (configuration === undefined) return undefined;
  const source = configuration.source ?? "tfe-api";
  const ingress = configuration.ingressAttributes;
  const triggerReason = !VCS_RUN_SOURCES.has(source)
    ? "manual"
    : (ingress as Record<string, unknown> | null)?.["manualTrigger"] === true
      ? "manual"
      : typeof ingress?.pullRequestNumber === "number"
        ? "pull_request"
        : typeof ingress?.tag === "string" && ingress.tag !== ""
          ? "tag"
          : "push";
  const origin: RunOrigin = {
    source,
    triggerReason,
    ...(typeof ingress?.branch === "string" ? { branch: ingress.branch } : {}),
    ...(typeof ingress?.commitSha === "string" ? { commitSha: ingress.commitSha } : {}),
    ...(typeof ingress?.commitUrl === "string" ? { commitUrl: ingress.commitUrl } : {}),
    ...(typeof ingress?.senderUsername === "string" ? { triggeredBy: ingress.senderUsername } : {}),
    ...(typeof ingress?.senderAvatarUrl === "string" ? { triggeredByAvatarUrl: ingress.senderAvatarUrl } : {}),
    ...(typeof ingress?.senderProviderId === "string" ? { triggeredByProviderId: ingress.senderProviderId } : {}),
  };
  return origin;
}

const SUPPORTED_RUN_INCLUDES = new Set([
  "plan",
  "apply",
  "created_by",
  "cost_estimate",
  "configuration_version",
  "configuration_version.ingress_attributes",
  "workspace",
  "task_stages",
  "tf_policy_evaluations",
]);

function requestedRunIncludes(request: ParamCtx["request"]): ReadonlySet<string> {
  const values = new URL(request.url).searchParams.getAll("include");
  if (values.length === 0) return new Set(["created_by"]);
  return new Set(values
    .flatMap((value: string): string[] => value.split(","))
    .map((item: string): string => item.trim())
    .filter((item: string): boolean => SUPPORTED_RUN_INCLUDES.has(item)));
}

function includedWorkspaceResource(workspace: Readonly<typeof workspaces.$inferSelect>): Record<string, unknown> {
  // Terraform's cloud backend only needs these fields while decoding a run
  // for `terraform show`: the workspace name for the header and its lock state
  // for the footer. Do not invent permission values or expose unrelated data
  // merely because the client requested the standard workspace relation.
  // Audit finding 8: structured-run-output-enabled must match the full
  // resource (always true) or the CLI never renders structured plan output.
  return {
    id: workspace.id,
    type: "workspaces",
    attributes: {
      name: workspace.name,
      locked: workspace.locked === true,
      "structured-run-output-enabled": true,
    },
    links: { self: `/api/v2/workspaces/${workspace.id}` },
  };
}

async function originsForRuns(runList: readonly RunItem[]): Promise<ReadonlyMap<string, RunOrigin>> {
  const configurationIds = [...new Set(runList.flatMap((run): string[] =>
    run.configurationVersionId === null ? [] : [run.configurationVersionId]))];
  if (configurationIds.length === 0) return new Map();
  const configurations = await db.query.configurationVersions.findMany({
    where: inArray(configurationVersions.id, configurationIds),
  });
  const byId = new Map(configurations.map((configuration): [string, ConfigurationVersionItem] =>
    [configuration.id, configuration]));
  return new Map(runList.flatMap((run): [string, RunOrigin][] => {
    const configuration = run.configurationVersionId === null
      ? undefined
      : byId.get(run.configurationVersionId);
    const origin = originForConfiguration(configuration);
    return origin === undefined ? [] : [[run.id, origin]];
  }));
}

async function usernamesById(userIds: readonly (string | null)[]): Promise<ReadonlyMap<string, { username: string; email: string | null }>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const actors = await db.query.users.findMany({
    where: inArray(users.id, ids),
    columns: { id: true, username: true, email: true },
  });
  return new Map(actors.map((actor): [string, { username: string; email: string | null }] => [actor.id, { username: actor.username, email: actor.email }]));
}

function gravatarUrl(email: string | null | undefined): string | null {
  const raw = typeof email === "string" && email !== ""
    ? `https://www.gravatar.com/avatar/${createHash('md5').update(email.toLowerCase().trim()).digest('hex')}?d=mp&s=80`
    : `https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&s=80&f=y`;
  return AvatarService.resolveUrl("user-gravatar", raw);
}

function commentResource(
  comment: CommentItem | Readonly<{ id: string; runId: string; body: string; userId: string | null; createdAt: number }> & Readonly<{ username?: string | null; avatarUrl?: string | null }>,
): Record<string, unknown> {
  const runEventId = `re-${comment.id}`;
  const username = (comment as Record<string, unknown>)["username"];
  const avatarUrl = (comment as Record<string, unknown>)["avatarUrl"];
  return {
    id: comment.id,
    type: "comments",
    attributes: {
      body: comment.body,
      // Expose actor for the UI's Comments section; fall back is "System" in the
      // frontend. Older clients ignore these extra fields.
      ...(typeof username === "string" && username !== "" ? { "actor-username": username } : {}),
      ...(typeof avatarUrl === "string" && avatarUrl !== "" ? { "actor-avatar-url": avatarUrl } : {}),
    },
    relationships: {
      "run-event": {
        data: { id: runEventId, type: "run-events" },
        links: { related: `/api/v2/run-events/${runEventId}` },
      },
    },
    links: { self: `/api/v2/comments/${comment.id}` },
  };
}

async function enrichCommentsWithActors(
  comments: readonly (CommentItem | Readonly<{ id: string; runId: string; body: string; userId: string | null; createdAt: number }>)[],
): Promise<ReadonlyArray<CommentItem & { username?: string | null; avatarUrl?: string | null }>> {
  const userIds = [...new Set(comments.map((c): string | null => c.userId).filter((v): v is string => v !== null && v !== ""))];
  if (userIds.length === 0) return comments as never;
  const userList = await db.query.users.findMany({
    where: inArray(users.id, userIds),
    columns: { id: true, username: true, email: true },
  });
  const byId = new Map(userList.map((u): [string, typeof u] => [u.id, u]));
  return comments.map((c): CommentItem & { username?: string | null; avatarUrl?: string | null } => {
    const u = c.userId !== null ? byId.get(c.userId) : undefined;
    return {
      ...(c as CommentItem),
      username: u?.username ?? null,
      avatarUrl: u !== undefined ? gravatarUrl(u.email) : null,
    };
  });
}

const RUN_VARIABLE_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const RUN_ADDRESS_PATTERN = /^[A-Za-z0-9_.,:\\[\]()"-]+$/;
const RUN_CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const MAX_RUN_VARIABLE_VALUE_BYTES = 1024 * 1024;

function invalidRunInput(set: SetObj, detail: string): { errors: { status: string; title: string; detail: string }[] } {
  (set as { status: number }).status = 422;
  return { errors: [{ status: "422", title: "Unprocessable Entity", detail }] };
}

/**
 * Validate the per-run Terraform inputs before they are stored and later
 * forwarded to the CLI as `-var=` / `-target=` / `-replace=` arguments. These
 * become single argv elements (no shell), so they cannot inject flags, but this
 * guards against malformed shapes (which would otherwise throw in the worker)
 * and rejects control characters so untrusted input never reaches the plan log,
 * the tfvars file, or the database.
 */
function validateRunInputs(
  variables: unknown,
  targetAddrs: unknown,
  replaceAddrs: unknown,
  set: SetObj,
): { errors: { status: string; title: string; detail: string }[] } | null {
  if (targetAddrs !== null && targetAddrs !== undefined && !Array.isArray(targetAddrs)) return invalidRunInput(set, "target-addrs must be an array");
  if (replaceAddrs !== null && replaceAddrs !== undefined && !Array.isArray(replaceAddrs)) return invalidRunInput(set, "replace-addrs must be an array");
  if (variables !== null && variables !== undefined && !Array.isArray(variables)) return invalidRunInput(set, "variables must be an array");

  for (const rawTarget of targetAddrs ?? []) {
    if (
      typeof rawTarget !== "string"
      || rawTarget === ""
      || rawTarget.length > 1024
      || rawTarget.startsWith("-")
      || RUN_CONTROL_CHARS.test(rawTarget)
      || /\s/.test(rawTarget)
      || !RUN_ADDRESS_PATTERN.test(rawTarget)
    ) return invalidRunInput(set, "target-addrs contains an invalid address");
  }
  for (const rawReplacement of replaceAddrs ?? []) {
    if (
      typeof rawReplacement !== "string"
      || rawReplacement === ""
      || rawReplacement.length > 1024
      || rawReplacement.startsWith("-")
      || RUN_CONTROL_CHARS.test(rawReplacement)
      || /\s/.test(rawReplacement)
      || !RUN_ADDRESS_PATTERN.test(rawReplacement)
    ) return invalidRunInput(set, "replace-addrs contains an invalid address");
  }
  for (const rawVariable of variables ?? []) {
    if (rawVariable === null || typeof rawVariable !== "object" || Array.isArray(rawVariable)) {
      return invalidRunInput(set, "variables must be an array of objects with a key and value");
    }
    const variable = rawVariable as Readonly<Record<string, unknown>>;
    const key = variable["key"];
    const value = variable["value"];
    if (
      typeof key !== "string"
      || key === ""
      || key.length > 256
      || key.startsWith("-")
      || RUN_CONTROL_CHARS.test(key)
      || !RUN_VARIABLE_KEY_PATTERN.test(key)
    ) return invalidRunInput(set, "variables contains an invalid variable key");
    if (
      typeof value !== "string"
      || Buffer.byteLength(value, "utf8") > MAX_RUN_VARIABLE_VALUE_BYTES
      || RUN_CONTROL_CHARS.test(value)
    ) return invalidRunInput(set, "variables contains an invalid variable value");
  }
  return null;
}

/**
 * Persist a run comment and publish `comment.created` so SSE clients can
 * refresh the comment list without refetching the whole run. All run comment
 * inserts route through here so the event can never be missed. Returns the
 * persisted id and timestamp (callers that echo them in a response).
 */
async function createRunComment(input: Readonly<{
  runId: string;
  userId: string | null;
  body: string;
  workspaceId: string;
  orgId: string;
}>): Promise<Readonly<{ id: string; createdAt: number }>> {
  const id = `rc-${crypto.randomUUID()}`;
  const createdAt = Date.now();
  await db.insert(runComments).values({ id, runId: input.runId, userId: input.userId, body: input.body, createdAt });
  publish("comment.created", {
    "run-id": input.runId,
    "workspace-id": input.workspaceId,
    "org-id": input.orgId,
    "comment-id": id,
  });
  return { id, createdAt };
}

function actionComment(body: unknown): string {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const data = payload["data"] as Record<string, unknown> | undefined;
  const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null
    ? data["attributes"] as Record<string, unknown>
    : {};
  const value = payload["comment"] ?? attributes["comment"];
  return typeof value === "string" ? value.trim() : "";
}

async function includedUsersForRuns(runList: readonly (RunItem)[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(runList.map((r: RunItem): string | null => r.createdBy).filter((id): id is string => id !== null))];
  if (ids.length === 0) return [];
  const userList = await db.query.users.findMany({
    where: inArray(users.id, ids),
    columns: { id: true, username: true, email: true, isSiteAdmin: true },
  });
  return userList.map((u): Record<string, unknown> => userResource(u as Parameters<typeof userResource>[0]));
}

async function workspacesForRuns(runList: readonly RunItem[]): Promise<(typeof workspaces.$inferSelect)[]> {
  const ids = [...new Set(runList.map((run: RunItem): string => run.workspaceId))];
  if (ids.length === 0) return [];
  return db.query.workspaces.findMany({ where: inArray(workspaces.id, ids) });
}

function configurationVersionHasIngressData(configuration: ConfigurationVersionItem): boolean {
  const ingress = (configuration.ingressAttributes ?? {}) as Record<string, unknown>;
  return Object.values(ingress).some(
    (value): boolean =>
      (typeof value === "string" && value !== "")
      || typeof value === "number"
      || typeof value === "boolean",
  );
}

async function includedConfigurationVersionsForRuns(
  runList: readonly RunItem[],
  request: ParamCtx["request"],
  includes: ReadonlySet<string>,
): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(runList
    .map((run: RunItem): string | null => run.configurationVersionId)
    .filter((id): id is string => id !== null))];
  if (ids.length === 0) return [];
  const configurations = await db.query.configurationVersions.findMany({
    where: inArray(configurationVersions.id, ids),
  });
  const byId = new Map(configurations.map((configuration): [string, ConfigurationVersionItem] => [configuration.id, configuration]));
  const resources: Record<string, unknown>[] = [];
  for (const run of runList) {
    if (run.configurationVersionId === null) continue;
    const configuration = byId.get(run.configurationVersionId);
    if (configuration === undefined) continue;
    resources.push(configurationVersionResource(configuration, request));
    if (includes.has("configuration_version.ingress_attributes") && configurationVersionHasIngressData(configuration)) {
      resources.push(configurationVersionIngressResource(configuration));
    }
  }
  return resources;
}

async function includedCostEstimatesForRuns(
  runList: readonly RunItem[],
  workspaceList: readonly (typeof workspaces.$inferSelect)[],
): Promise<Record<string, unknown>[]> {
  const workspacesById = new Map(workspaceList.map((workspace): [string, typeof workspace] => [workspace.id, workspace]));
  const organizationIds = [...new Set(workspaceList.map((workspace): string => workspace.orgId))];
  const enabledEntries = await Promise.all(organizationIds.map(async (organizationId): Promise<readonly [string, boolean]> => [
    organizationId,
    await costEstimationEnabledForOrganization(organizationId),
  ]));
  const enabledByOrganization = new Map(enabledEntries);
  const resources = await Promise.all(runList.map(async (run): Promise<Record<string, unknown> | undefined> => {
    const workspace = workspacesById.get(run.workspaceId);
    if (workspace === undefined) return undefined;
    return costEstimateResource(
      run,
      await readCostEstimateArtifact(run.id),
      enabledByOrganization.get(workspace.orgId) ?? false,
    );
  }));
  return resources.filter((resource): resource is Record<string, unknown> => resource !== undefined);
}

function deduplicateIncludedResources(resources: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return resources.filter((resource): boolean => {
    const type = resource["type"];
    const id = resource["id"];
    if (typeof type !== "string" || typeof id !== "string") return true;
    const key = `${type}:${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function includedRunResources(
  runList: readonly RunItem[],
  request: ParamCtx["request"],
  includes: ReadonlySet<string>,
): Promise<Record<string, unknown>[]> {
  const needsWorkspaceRows = includes.has("workspace") || includes.has("cost_estimate");
  const includeConfiguration = includes.has("configuration_version") || includes.has("configuration_version.ingress_attributes");
  const [usersIncluded, workspaceList, configurationsIncluded, stagesIncluded, evaluationsIncluded] = await Promise.all([
    includes.has("created_by") ? includedUsersForRuns(runList) : Promise.resolve([] as Record<string, unknown>[]),
    needsWorkspaceRows ? workspacesForRuns(runList) : Promise.resolve([] as (typeof workspaces.$inferSelect)[]),
    includeConfiguration
      ? includedConfigurationVersionsForRuns(runList, request, includes)
      : Promise.resolve([] as Record<string, unknown>[]),
    includes.has("task_stages")
      ? includedTaskStagesForRuns(runList)
      : Promise.resolve([] as Record<string, unknown>[]),
    includes.has("tf_policy_evaluations")
      ? includedTFPolicyEvaluationsForRuns(runList)
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  const plans = includes.has("plan") ? runList.map((run): Record<string, unknown> => planResource(run, request)) : [];
  const applies = includes.has("apply") ? runList.map((run): Record<string, unknown> => applyResource(run, request)) : [];
  const workspacesIncluded = includes.has("workspace")
    ? runList.flatMap((run): Record<string, unknown>[] => {
      const workspace = workspaceList.find((candidate): boolean => candidate.id === run.workspaceId);
      return workspace === undefined ? [] : [includedWorkspaceResource(workspace)];
    })
    : [];
  const costEstimates = includes.has("cost_estimate")
    ? await includedCostEstimatesForRuns(runList, workspaceList)
    : [];
  return deduplicateIncludedResources([
    ...usersIncluded,
    ...plans,
    ...applies,
    ...configurationsIncluded,
    ...workspacesIncluded,
    ...stagesIncluded,
    ...evaluationsIncluded,
    ...costEstimates,
  ]);
}

/** Audit finding 6: batch-load relationship linkage IDs for a run page (one
 * query per relation, no N+1) so the CLI hydrates policy checks, cost
 * estimates, and task stages from run reads. */
async function notificationConfigurationIdsForRuns(runList: readonly RunItem[]): Promise<ReadonlyMap<string, readonly string[]>> {
  const workspaceIds = [...new Set(runList.map((run): string => run.workspaceId))];
  if (workspaceIds.length === 0) return new Map();

  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, workspaceIds),
    columns: { id: true, projectId: true },
  });
  const projectIds = [...new Set(workspaceRows.flatMap((workspace): string[] =>
    workspace.projectId === null ? [] : [workspace.projectId],
  ))];
  const configurationWhere = projectIds.length === 0
    ? inArray(notificationConfigurations.workspaceId, workspaceIds)
    : or(
        inArray(notificationConfigurations.workspaceId, workspaceIds),
        inArray(notificationConfigurations.projectId, projectIds),
      );
  const configurations = await db.query.notificationConfigurations.findMany({
    where: configurationWhere,
    orderBy: [asc(notificationConfigurations.createdAt), asc(notificationConfigurations.id)],
    columns: { id: true, workspaceId: true, projectId: true, enabled: true, triggers: true },
  });
  const projectConfigurationIds = configurations
    .filter((configuration): boolean => configuration.projectId !== null)
    .map((configuration): string => configuration.id);
  const exclusions = projectConfigurationIds.length === 0
    ? []
    : await db.query.notificationConfigurationWorkspaceExclusions.findMany({
        where: and(
          inArray(notificationConfigurationWorkspaceExclusions.notificationConfigurationId, projectConfigurationIds),
          inArray(notificationConfigurationWorkspaceExclusions.workspaceId, workspaceIds),
        ),
        columns: { notificationConfigurationId: true, workspaceId: true },
      });
  const excluded = new Set(exclusions.map((row): string => `${row.notificationConfigurationId}:${row.workspaceId}`));
  const workspaceById = new Map(workspaceRows.map((workspace): [string, typeof workspace] => [workspace.id, workspace]));
  const configurationIdsByRun = new Map<string, readonly string[]>();
  for (const run of runList) {
    const workspace = workspaceById.get(run.workspaceId);
    if (workspace === undefined) {
      configurationIdsByRun.set(run.id, []);
      continue;
    }
    const ids = configurations
      .filter((configuration): boolean => {
        if (configuration.enabled !== true
          || !configuration.triggers.some((trigger): boolean => (RUN_NOTIFICATION_TRIGGERS as readonly string[]).includes(trigger))) return false;
        if (configuration.workspaceId === workspace.id) return true;
        return configuration.projectId !== null
          && configuration.projectId === workspace.projectId
          && !excluded.has(`${configuration.id}:${workspace.id}`);
      })
      .map((configuration): string => configuration.id);
    configurationIdsByRun.set(run.id, ids);
  }
  return configurationIdsByRun;
}

export async function linkageForRuns(runList: readonly RunItem[]): Promise<ReadonlyMap<string, RunRelationshipLinkage>> {
  const ids = runList.map((r: RunItem): string => r.id);
  if (ids.length === 0) return new Map();
  const [checks, stages, evals, notificationConfigurationIdsByRun] = await Promise.all([
    db.query.policyChecks.findMany({ where: inArray(policyChecks.runId, [...ids]), columns: { id: true, runId: true } }),
    db.query.taskStages.findMany({ where: inArray(taskStages.runId, [...ids]), columns: { id: true, runId: true } }),
    db.query.policyEvaluations.findMany({ where: inArray(policyEvaluations.runId, [...ids]), columns: { id: true, runId: true } }),
    notificationConfigurationIdsForRuns(runList),
  ]);
  const linkage = new Map<string, { policyCheckIds: string[]; taskStageIds: string[]; tfPolicyEvaluationIds: string[]; notificationConfigurationIds: readonly string[] }>();
  for (const id of ids) linkage.set(id, {
    policyCheckIds: [],
    taskStageIds: [],
    tfPolicyEvaluationIds: [],
    notificationConfigurationIds: notificationConfigurationIdsByRun.get(id) ?? [],
  });
  for (const check of checks) linkage.get(check.runId)?.policyCheckIds.push(check.id);
  for (const stage of stages) linkage.get(stage.runId)?.taskStageIds.push(stage.id);
  for (const evalRecord of evals) {
    if (evalRecord.runId !== null) linkage.get(evalRecord.runId)?.tfPolicyEvaluationIds.push(evalRecord.id);
  }
  return linkage;
}

async function actionRunResource(
  run: RunItem,
  workspace: Readonly<typeof workspaces.$inferSelect>,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
): Promise<Record<string, unknown>> {
  const [canApply, canOverridePolicy, canAdmin, origins, baseline, linkage] = await Promise.all([
    checkWorkspacePermission(workspace, userId, orgId, teamId, "apply"),
    checkWorkspacePermission(workspace, userId, orgId, teamId, "policy-override"),
    checkWorkspacePermission(workspace, userId, orgId, teamId, "admin"),
    originsForRuns([run]),
    runDurationBaseline(run),
    linkageForRuns([run]),
  ]);
  return runResource(
    run,
    canApply,
    canOverridePolicy,
    origins.get(run.id),
    baseline,
    canAdmin,
    linkage.get(run.id),
  );
}

/** Audit finding 6: task-stage resources for include=task_stages sideloads
 * (the CLI reads stages from the run include, then polls each via Read). */
async function includedTaskStagesForRuns(runList: readonly RunItem[]): Promise<Record<string, unknown>[]> {
  const ids = runList.map((r: RunItem): string => r.id);
  if (ids.length === 0) return [];
  const rows = await db.query.taskStages.findMany({ where: inArray(taskStages.runId, [...ids]) });
  return rows.map((stage): Record<string, unknown> => taskStageResource(stage));
}

/** Audit finding 3: TF-policy evaluation resources for the
 * include=tf_policy_evaluations sideload the CLI renders per stage. */
async function includedTFPolicyEvaluationsForRuns(runList: readonly RunItem[]): Promise<Record<string, unknown>[]> {
  const ids = runList.map((r: RunItem): string => r.id);
  if (ids.length === 0) return [];
  const evals = await db.query.policyEvaluations.findMany({ where: inArray(policyEvaluations.runId, [...ids]) });
  const stageTypes = await tfStageTypesForEvaluations(evals);
  return evals.map((evalRecord): Record<string, unknown> =>
    tfPolicyEvaluationResource(evalRecord, stageTypes.get(evalRecord.id)));
}

function safeRunEventDetails(event: AuditItem): Readonly<Record<string, string>> {
  const { details } = event;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return {};
  const source = details as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    ["fromStatus", "toStatus", "workspaceId", "status", "source", "triggerReason", "actorUsername", "actorAvatarUrl", "actorProviderId"].flatMap((key): readonly [string, string][] =>
      typeof source[key] === "string" ? [[key, source[key]]] : [],
    ),
  );
}

function runHistoryPageOffset(page: Readonly<{ number: number; size: number }>, totalCount: number): number | null {
  const totalPages = Math.ceil(totalCount / page.size);
  return page.number <= totalPages ? (page.number - 1) * page.size : null;
}

async function authorizedOrgWorkspaces(
  organizationId: string,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
  required: WorkspacePermission = "run-read",
): Promise<(typeof workspaces.$inferSelect)[]> {
  const ids = await workspaceIdsForPermission(organizationId, userId, orgId, teamId, required);
  if (ids !== null && ids.length === 0) return [];
  return db.query.workspaces.findMany({
    where: ids === null
      ? eq(workspaces.orgId, organizationId)
      : and(eq(workspaces.orgId, organizationId), inArray(workspaces.id, [...ids])),
  });
}


export async function createRun(
  workspaceId: string,
  attributes: Readonly<Record<string, unknown>>,
  cvId: string | undefined,
  user: Readonly<typeof users.$inferSelect> | null | undefined,
  orgId: string | null | undefined,
  teamId: string | null | undefined,
  set: SetObj,
): Promise<Record<string, unknown> | { errors: { status: string; title: string; detail?: string }[] }> {
  const message = typeof attributes["message"] === "string" ? attributes["message"] : "";
  const requestedOperation = typeof attributes["operation"] === "string" ? attributes["operation"] : undefined;
  const allowedOperations = new Set(["plan", "plan_and_apply", "plan_only", "save_plan", "empty_apply", "action_only", "destroy", "refresh_only"]);
  if (requestedOperation !== undefined && !allowedOperations.has(requestedOperation)) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid operation" }] };
  }
  const isDestroy = requestedOperation === "destroy"
    || (typeof attributes["is-destroy"] === "boolean" ? attributes["is-destroy"] : false);
  const invokeActionAddrs = Array.isArray(attributes["invoke-action-addrs"])
    ? attributes["invoke-action-addrs"].filter((value: unknown): value is string => typeof value === "string" && value.trim() !== "").map((value: string): string => value.trim())
    : [];
  const targetAddrsInput = Array.isArray(attributes["target-addrs"]) ? attributes["target-addrs"] : [];
  if (invokeActionAddrs.length > 1 || (invokeActionAddrs.length > 0 && (isDestroy || targetAddrsInput.length > 0))) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "invoke-action-addrs accepts one address and cannot be combined with destroy or target addresses" }] };
  }
  const requestedAutoApply = typeof attributes["auto-apply"] === "boolean" ? attributes["auto-apply"] : undefined;
  const requestedPlanOnly = requestedOperation === "plan" || requestedOperation === "plan_only"
    ? true
    : typeof attributes["plan-only"] === "boolean" ? attributes["plan-only"] : undefined;
  const refresh = typeof attributes["refresh"] === "boolean" ? attributes["refresh"] : true;
  const refreshOnly = requestedOperation === "refresh_only" || requestedOperation === "action_only"
    || (typeof attributes["refresh-only"] === "boolean" ? attributes["refresh-only"] : false);
  const targetAddrs = Array.isArray(attributes["target-addrs"]) ? (attributes["target-addrs"] as string[]) : null;
  const replaceAddrs = Array.isArray(attributes["replace-addrs"]) ? (attributes["replace-addrs"] as string[]) : null;
  const runVariables = Array.isArray(attributes["variables"]) ? attributes["variables"] : null;
  const terraformVersion = typeof attributes["terraform-version"] === "string" ? attributes["terraform-version"] : undefined;
  const debuggingMode = typeof attributes["debugging-mode"] === "boolean" ? attributes["debugging-mode"] : false;
  const allowEmptyApply = requestedOperation === "empty_apply"
    ? true
    : typeof attributes["allow-empty-apply"] === "boolean" ? attributes["allow-empty-apply"] : false;
  const savePlan = requestedOperation === "save_plan"
    ? true
    : typeof attributes["save-plan"] === "boolean" ? attributes["save-plan"] : false;
  const allowConfigGeneration = typeof attributes["allow-config-generation"] === "boolean" ? attributes["allow-config-generation"] : false;
  const generatedConfiguration = typeof attributes["generated-configuration"] === "boolean" ? attributes["generated-configuration"] : false;
  const operation = requestedOperation
    ?? (invokeActionAddrs.length > 0
      ? "action_only"
      : isDestroy
        ? "destroy"
        : refreshOnly
          ? "refresh_only"
          : savePlan
            ? "save_plan"
            : allowEmptyApply
              ? "empty_apply"
              : "plan_and_apply");
  if (workspaceId === "") { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Workspace ID is required" }] }; }
  if (terraformVersion !== undefined && !validateVersion(terraformVersion)) {
    (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid run attributes" }] };
  }
  const invalidInputs = validateRunInputs(
    attributes["variables"],
    attributes["target-addrs"],
    attributes["replace-addrs"],
    set,
  );
  if (invalidInputs !== null) return invalidInputs;
  const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null);
  if (workspace === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Organization tokens cannot create runs. Use a team token or user token." }] }; }
  if (!(await checkWorkspacePermission(workspace, user?.id, null, teamId ?? null, "plan"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
  if (workspace.locked === true) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: lockedWorkspaceDetail(workspace.lockedReason) }] };
  }
  // Local-execution workspaces never run remotely (issue #567): the CLI
  // plans and applies on the operator machine and the server only stores
  // state. This matches the reference behavior for local workspaces.
  if (workspace.executionMode === "local") {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Remote runs cannot be created for workspaces with local execution mode" }] };
  }
  if (isDestroy && workspace.allowDestroyPlan === false) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Destroy plans are disabled for this workspace" }] };
  }
  const canApply = await checkWorkspacePermission(workspace, user?.id, null, teamId ?? null, "apply");
  if (!canApply && (requestedAutoApply === true || allowEmptyApply || operation === "action_only")) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
  const autoApply = operation === "action_only" ? canApply : canApply && (requestedAutoApply ?? workspace.autoApply === true);
  // Issue #601: inheriting the workspace default while lacking apply rights
  // silently drops auto-apply (explicit requests already 403 above). Flag it
  // on the created run so planners see why their run waits for confirmation.
  const autoApplySuppressed = !canApply && requestedAutoApply === undefined && workspace.autoApply === true && operation !== "action_only";
  let configurationVersion: typeof configurationVersions.$inferSelect | undefined;
  if (cvId !== undefined) {
    configurationVersion = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (configurationVersion === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Configuration version was not found" }] }; }
    if (configurationVersion?.workspaceId !== workspaceId) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Configuration version does not belong to workspace" }] }; }
    const pendingVcs = configurationVersion.status === "pending" && ["github", "gitlab", "bitbucket"].includes(configurationVersion.source ?? "");
    if (configurationVersion.status !== "uploaded" && !pendingVcs) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Configuration version is not ready for a run" }] }; }
  } else if (workspace.vcsRepo?.identifier !== undefined) {
    // Auto-create a configuration version from VCS for manual runs
    const result = await createConfigurationVersionFromVcs(workspace);
    if (typeof result === "object" && "error" in result) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: result.error }] };
    }
    cvId = result;
    configurationVersion = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
  } else {
    // Manual runs without an explicit configuration version use the workspace's
    // latest uploaded configuration version (matches the reference format behaviour; tfe_workspace_run
    // creates runs without claiming a config version, and the worker only plans
    // runs that have one).
    const latest = await db.query.configurationVersions.findFirst({
      where: and(eq(configurationVersions.workspaceId, workspaceId), eq(configurationVersions.status, "uploaded")),
      orderBy: [desc(configurationVersions.createdAt)],
    });
    if (latest !== undefined) {
      cvId = latest.id;
      configurationVersion = latest;
    }
  }
  // A run with no configuration to plan against only fails deep in the
  // worker log (issue #574). Reject it here with an actionable message,
  // except for VCS-backed workspaces (handled above) and local-path
  // workspaces whose source lives on disk.
  if (cvId === undefined && workspace.vcsRepo?.identifier === undefined && workspace.source !== "local") {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "No configuration version is available for this workspace. Upload a configuration version or connect a VCS repository first." }] };
  }
  // Issue #599: backfill an unset binary from the org default (matching
  // workspace creation), not a hardcoded terraform — otherwise a first run
  // permanently flips a tofu-default org's workspace to terraform.
  // Issue #602: the worker falls back to the org default version when the run
  // and workspace both leave it unset, so load it here too for the preflight.
  let effectiveTool = workspace.iacBinary;
  let orgDefaultVersion: string | null = null;
  if (effectiveTool === null || (terraformVersion === undefined && workspace.terraformVersion === null)) {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, workspace.orgId),
      columns: { defaultIacBinary: true, defaultTerraformVersion: true },
    });
    orgDefaultVersion = org?.defaultTerraformVersion ?? null;
    if (effectiveTool === null) {
      effectiveTool = org?.defaultIacBinary ?? "terraform";
      await db.update(workspaces).set({ iacBinary: effectiveTool }).where(eq(workspaces.id, workspace.id));
    }
  }
  // Issue #602: fail fast on an exact version that can never resolve (typo'd
  // or unpublished) instead of failing mid-run. The preflight is network-free
  // and only rejects on affirmative knowledge; cold caches and
  // constraints/"latest" defer to run-time resolution so on-demand download
  // keeps working.
  const effectiveVersion = terraformVersion ?? workspace.terraformVersion ?? orgDefaultVersion;
  if (typeof effectiveVersion === "string") {
    const preflight = await preflightBinaryAvailability(effectiveTool, effectiveVersion);
    if (!preflight.ok) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: preflight.detail }] };
    }
  }
  const id = newRunId();
  const createdAt = Date.now();
  const logToken = crypto.randomUUID();
  const planOnly = requestedPlanOnly ?? configurationVersion?.speculative ?? false;
  const nowIso = new Date(createdAt).toISOString();
  const finalMsg = message !== "" ? message : (configurationVersion?.source === "tfe-cli" ? "Triggered via CLI" : "Triggered via UI");
  const origin = originForConfiguration(configurationVersion);
  // The lock was validated above, but that check and the insert below are
  // separate statements; re-validate inside the insert transaction so a
  // concurrent workspace lock can never slip a queued run past the 422.
  const lockConflict = await db.transaction(async (tx): Promise<{ lockedReason: string | null } | null> => {
    const fresh = await tx.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { locked: true, lockedReason: true },
    });
    if (fresh?.locked === true) return { lockedReason: fresh.lockedReason ?? null };
    await tx.insert(runs).values({ id, workspaceId, configurationVersionId: cvId ?? null, message: finalMsg, status: "pending", operation, generatedConfiguration, executionMode: workspace.executionMode, isDestroy, autoApply, planOnly, refresh, refreshOnly, invokeActionAddrs, targetAddrs, replaceAddrs, variables: runVariables, logToken, terraformVersion: terraformVersion ?? null, debuggingMode, allowEmptyApply, savePlan, allowConfigGeneration, statusTimestamps: { "pending-at": nowIso }, createdBy: user?.id ?? null, appliedAt: null, createdAt });
    return null;
  });
  if (lockConflict !== null) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: lockedWorkspaceDetail(lockConflict.lockedReason) }] };
  }
  await auditLog("create", "runs", id, user?.id ?? null, workspace.orgId, {
    workspaceId,
    status: "pending",
    source: origin?.source ?? "tfe-api",
    triggerReason: origin?.triggerReason ?? "manual",
  });
  queueRunNotification(id, "run:created", "pending");
  (set as { status: number }).status = 201;
  publish("run.status", {
    "run-id": id,
    "workspace-id": workspaceId,
    "org-id": workspace.orgId,
    status: "pending",
    at: nowIso,
  });
  scheduleExplorerInventory(workspaceId);
  const createdRun = { id, workspaceId, configurationVersionId: cvId ?? null, agentPoolId: null, agentId: null, message: finalMsg, status: "pending", operation, generatedConfiguration, executionMode: workspace.executionMode, isDestroy, autoApply, planOnly, refresh, refreshOnly, invokeActionAddrs, targetAddrs, replaceAddrs, variables: runVariables, logToken, terraformVersion: terraformVersion ?? null, debuggingMode, allowEmptyApply, savePlan, allowConfigGeneration, statusTimestamps: { "pending-at": nowIso }, planResourceAdditions: null, planResourceChanges: null, planResourceDestructions: null, planResourceImports: null, applyResourceAdditions: null, applyResourceChanges: null, applyResourceDestructions: null, applyResourceImports: null, createdBy: user?.id ?? null, appliedAt: null, scheduledAt: null, softDeletedAt: null, createdAt };
  const createdLinkage = await linkageForRuns([createdRun]);
  const createdResource = runResource(createdRun, canApply, false, origin, undefined, undefined, createdLinkage.get(id));
  if (autoApplySuppressed) {
    (createdResource["attributes"] as Record<string, unknown>)["auto-apply-warning"] =
      "Auto-apply is enabled on this workspace, but you do not have apply permission, so this run was created with auto-apply off and will wait for confirmation.";
  }
  return { data: createdResource };
}

/**
 * reference-format-compatible run list sorting (kanban 14.8). Accepts `?sort=created-at`,
 * `?sort=-created-at`, `?sort=status`, `?sort=-status`; a `-` prefix means
 * descending. Unknown keys fall back to newest-first so the parameter stays
 * additive and never breaks existing clients. Status sorts lexicographically
 * with created-at descending as the tiebreaker, and every ordering ends with
 * the run id descending so equal timestamps still return a stable page order.
 */
function parseRunSort(request: RequestWithUrl): ReturnType<typeof desc>[] {
  const raw = new URL(request.url).searchParams.get("sort") ?? "-created-at";
  const descending = raw.startsWith("-");
  const key = descending ? raw.slice(1) : raw;
  if (key === "status") {
    return descending
      ? [desc(runs.status), desc(runs.createdAt), desc(runs.id)]
      : [asc(runs.status), desc(runs.createdAt), desc(runs.id)];
  }
  if (key === "created-at") {
    return [descending ? desc(runs.createdAt) : asc(runs.createdAt), desc(runs.id)];
  }
  return [desc(runs.createdAt), desc(runs.id)];
}

/**
 * Human-readable detail for the workspace-locked rejection used by run
 * creation and apply. Mirrors the single-run detail payload's
 * workspace-locked-reason attribute (unit tests assert both places agree).
 */
function lockedWorkspaceDetail(reason: string | null | undefined): string {
  return reason !== undefined && reason !== null && reason !== ""
    ? `Workspace is locked: ${reason}`
    : "Workspace is locked";
}

type RunCursor = Readonly<{ createdAt: number; id: string }>;

function decodeRunCursor(value: string): RunCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof decoded["createdAt"] === "number" && Number.isSafeInteger(decoded["createdAt"]) && typeof decoded["id"] === "string" && decoded["id"] !== ""
      ? { createdAt: decoded["createdAt"], id: decoded["id"] }
      : null;
  } catch {
    return null;
  }
}

function encodeRunCursor(run: Readonly<{ createdAt: number; id: string }>): string {
  return Buffer.from(JSON.stringify({ createdAt: run.createdAt, id: run.id })).toString("base64url");
}

async function authorizedPlanWorkspace(
  runId: string,
  run: Readonly<typeof runs.$inferSelect>,
  runContext: ParamCtx["run"],
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
): Promise<typeof workspaces.$inferSelect | undefined> {
  if (runContext !== undefined && runContext !== null) {
    if (runContext.runId !== runId || runContext.workspaceId !== run.workspaceId) return undefined;
    return db.query.workspaces.findFirst({
      where: and(eq(workspaces.id, run.workspaceId), eq(workspaces.orgId, runContext.organizationId)),
    });
  }
  return findAuthorizedWorkspace(run.workspaceId, userId, tokenOrgId, tokenTeamId);
}

/**
 * Raw (unsanitized) plan JSON carries secrets in cleartext, so it requires
 * the state-read class or admin (issue #577). The run-token path is
 * unchanged: run tokens are already workspace-scoped secrets. Callers 404
 * on failure, matching the surrounding convention. Redacted endpoints stay
 * at read.
 */
async function authorizedRawPlanWorkspace(
  runId: string,
  run: Readonly<typeof runs.$inferSelect>,
  runContext: ParamCtx["run"],
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
): Promise<typeof workspaces.$inferSelect | undefined> {
  if (runContext !== undefined && runContext !== null) {
    if (runContext.runId !== runId || runContext.workspaceId !== run.workspaceId) return undefined;
    return db.query.workspaces.findFirst({
      where: and(eq(workspaces.id, run.workspaceId), eq(workspaces.orgId, runContext.organizationId)),
    });
  }
  return (await findAuthorizedWorkspace(run.workspaceId, userId, tokenOrgId, tokenTeamId, "state-read"))
    ?? (await findAuthorizedWorkspace(run.workspaceId, userId, tokenOrgId, tokenTeamId, "admin"));
}

/**
 * Shared sanitized plan-artifact responder for the redacted/sanitized plan
 * endpoints. Serves the artifact as soon as it exists: the worker persists
 * plan JSON before the run leaves its planning statuses, and Terraform
 * treats any 2xx as success, so an empty 204 here would fail clients
 * decoding JSON. Returns 204 only when no artifact exists yet and 404 when
 * it never will.
 */
async function sanitizedPlanArtifactResponse(
  runId: string,
  run: Readonly<typeof runs.$inferSelect>,
  set: SetObj,
): Promise<unknown> {
  const planJson = await readPlanJsonSideArtifact(runId, "sanitized") ?? await readPlanJsonArtifact(runId);
  if (planJson !== undefined) return sanitizePlanJson(planJson);
  if (isPlanIncompleteRunStatus(run.status)) { (set as { status: number }).status = 204; return null; }
  (set as { status: number }).status = 404;
  return { errors: [{ status: "404", title: "Not Found" }] };
}

export const runRoutes = new Elysia({ name: "runs" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/runs", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null);
    if (workspace === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const canApply = await checkWorkspacePermission(workspace, user?.id, orgId ?? null, teamId ?? null, "apply");
    const { number, size } = pageRequest(request);
    const where = workspaceRunHistoryWhere(request, workspaceId);
    const [workspaceRuns, countRows] = await Promise.all([
      db.query.runs.findMany({ where, orderBy: parseRunSort(request), limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    const [origins, linkage] = await Promise.all([originsForRuns(workspaceRuns), linkageForRuns(workspaceRuns)]);
    const data = workspaceRuns.map((r: RunItem): Record<string, unknown> => runResource(r, canApply, false, origins.get(r.id), undefined, undefined, linkage.get(r.id)));
    const included = await includedRunResources(workspaceRuns, request, requestedRunIncludes(request));
    return { data, ...(included.length > 0 ? { included } : {}), ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/organizations/:org_name/runs", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const organization = await cachedOrgByName(orgName);
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId ?? null, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [orgWorkspaces, applyIds] = await Promise.all([
      authorizedOrgWorkspaces(organization.id, user?.id, orgId ?? null, teamId ?? null),
      workspaceIdsForPermission(organization.id, user?.id, orgId ?? null, teamId ?? null, "apply"),
    ]);
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) { return { data: [], ...pagination(request, number, size, 0) }; }
    const where = organizationRunHistoryWhere(request, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id));
    const [orgRuns, countRows] = await Promise.all([
      db.query.runs.findMany({ where, orderBy: parseRunSort(request), limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    const applySet = new Set(applyIds ?? []);
    const [origins, linkage] = await Promise.all([originsForRuns(orgRuns), linkageForRuns(orgRuns)]);
    const data = orgRuns.map((r: RunItem): Record<string, unknown> => runResource(r, applyIds === null || applySet.has(r.workspaceId), false, origins.get(r.id), undefined, undefined, linkage.get(r.id)));
    const included = await includedRunResources(orgRuns, request, requestedRunIncludes(request));
    return { data, ...(included.length > 0 ? { included } : {}), ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/organizations/:org_name/runs/queue", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const organization = await cachedOrgByName(orgName);
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId ?? null, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [orgWorkspaces, applyIds] = await Promise.all([
      authorizedOrgWorkspaces(organization.id, user?.id, orgId ?? null, teamId ?? null),
      workspaceIdsForPermission(organization.id, user?.id, orgId ?? null, teamId ?? null, "apply"),
    ]);
    const { number, size } = pageRequest(request);
    const rawCursor = new URL(request.url).searchParams.get("page[cursor]");
    const cursorMode = rawCursor !== null;
    const cursor = rawCursor === null ? null : decodeRunCursor(rawCursor);
    if (cursorMode && cursor === null) {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "page[cursor] is invalid" }] };
    }
    if (orgWorkspaces.length === 0) {
      return {
        data: [],
        ...(cursorMode ? cursorPagination(request, null, size, false) : pagination(request, number, size, 0)),
      };
    }
    const baseQueueWhere = and(
      inArray(runs.workspaceId, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id)),
      inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES]),
    );
    const queueWhere = and(
      baseQueueWhere,
      cursor === null ? undefined : or(
        gt(runs.createdAt, cursor.createdAt),
        and(eq(runs.createdAt, cursor.createdAt), gt(runs.id, cursor.id)),
      ),
    );
    const [queueWithCursor, countRows, runningRows] = await Promise.all([
      db.query.runs.findMany({
        where: queueWhere,
        orderBy: [asc(runs.createdAt), asc(runs.id)],
        limit: cursorMode ? size + 1 : size,
        offset: cursorMode ? undefined : (number - 1) * size,
      }),
      cursorMode ? Promise.resolve([{ total: 0 }]) : db.select({ total: count() }).from(runs).where(baseQueueWhere),
      db.select({ total: count() }).from(runs).where(and(
        baseQueueWhere,
        inArray(runs.status, [...CAPACITY_RUNNING_STATUSES]),
      )),
    ]);
    const hasMore = cursorMode && queueWithCursor.length > size;
    const queue = hasMore ? queueWithCursor.slice(0, size) : queueWithCursor;
    const first = queue[0];
    let pendingBefore = 0;
    if (first !== undefined) {
      const rowsBefore = await db.select({ total: count() }).from(runs).where(and(
        inArray(runs.workspaceId, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id)),
        inArray(runs.status, [...CAPACITY_PENDING_STATUSES]),
        or(
          lt(runs.createdAt, first.createdAt),
          and(eq(runs.createdAt, first.createdAt), lt(runs.id, first.id)),
        ),
      ));
      pendingBefore = rowsBefore[0]?.total ?? 0;
    }
    let position = (runningRows[0]?.total ?? 0) + pendingBefore;
    const applySet = new Set(applyIds ?? []);
    const origins = await originsForRuns(queue);
    const linkage = await linkageForRuns(queue);
    const data = queue.map((r: RunItem): Record<string, unknown> => {
      const resource = runResource(r, applyIds === null || applySet.has(r.workspaceId), false, origins.get(r.id), undefined, undefined, linkage.get(r.id));
      const isPending = CAPACITY_PENDING_STATUSES.some((s: string): boolean => s === r.status);
      if (isPending) { position += 1; }
      const attrs = typeof resource["attributes"] === "object" && resource["attributes"] !== null ? (resource["attributes"] as Record<string, unknown>) : {};
      return { ...resource, attributes: { ...attrs, "position-in-queue": isPending ? position : 0 } };
    });
    const included = await includedRunResources(queue, request, requestedRunIncludes(request));
    const last = queue.at(-1);
    const pageMeta = cursorMode
      ? cursorPagination(request, hasMore && last !== undefined ? encodeRunCursor(last) : null, size, hasMore)
      : pagination(request, number, size, countRows[0]?.total ?? 0);
    return { data, ...(included.length > 0 ? { included } : {}), ...pageMeta };
  })
  .get("/api/v2/organizations/:org_name/capacity", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const organization = await cachedOrgByName(orgName);
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId ?? null, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const orgWorkspaces = await authorizedOrgWorkspaces(organization.id, user?.id, orgId ?? null, teamId ?? null);
    const counts = orgWorkspaces.length === 0 ? [] : await db.select({ status: runs.status, total: count() }).from(runs).where(and(
      inArray(runs.workspaceId, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id)),
      inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES]),
    )).groupBy(runs.status);
    const totalFor = (statuses: readonly string[]): number => counts
      .filter((row): boolean => statuses.includes(row.status))
      .reduce((sum, row): number => sum + row.total, 0);
    return { data: { id: organization.name, type: "organization-capacity", attributes: { pending: totalFor(CAPACITY_PENDING_STATUSES), running: totalFor(CAPACITY_RUNNING_STATUSES) } } };
  })
  .post("/api/v2/workspaces/:workspace_id/runs", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const wsId = params["workspace_id"] ?? "";
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const rels = typeof data?.["relationships"] === "object" && data["relationships"] !== null ? (data["relationships"] as Record<string, unknown>) : {};
    const cvRel = typeof rels["configuration-version"] === "object" && rels["configuration-version"] !== null ? (rels["configuration-version"] as Record<string, unknown>) : {};
    const cvData = typeof cvRel["data"] === "object" && cvRel["data"] !== null ? (cvRel["data"] as Record<string, unknown>) : {};
    const cvId = typeof cvData["id"] === "string" ? cvData["id"] : (typeof attributes["configuration-version-id"] === "string" ? attributes["configuration-version-id"] : undefined);
    return createRun(wsId, attributes, cvId, user, orgId, teamId, set);
  })
  .post("/api/v2/runs", async ({ body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const rels = typeof data?.["relationships"] === "object" && data["relationships"] !== null ? (data["relationships"] as Record<string, unknown>) : {};
    const wsRel = typeof rels["workspace"] === "object" && rels["workspace"] !== null ? (rels["workspace"] as Record<string, unknown>) : {};
    const wsData = typeof wsRel["data"] === "object" && wsRel["data"] !== null ? (wsRel["data"] as Record<string, unknown>) : {};
    const cvRel = typeof rels["configuration-version"] === "object" && rels["configuration-version"] !== null ? (rels["configuration-version"] as Record<string, unknown>) : {};
    const cvData = typeof cvRel["data"] === "object" && cvRel["data"] !== null ? (cvRel["data"] as Record<string, unknown>) : {};
    const workspaceId = typeof wsData["id"] === "string" ? wsData["id"] : "";
    const cvId = typeof cvData["id"] === "string" ? cvData["id"] : (typeof attributes["configuration-version-id"] === "string" ? attributes["configuration-version-id"] : undefined);
    return createRun(workspaceId, attributes, cvId, user, orgId, teamId, set);
  })
  .get("/api/v2/runs/:run_id", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [canApply, canOverridePolicy, canAdmin, origins, baseline] = await Promise.all([
      checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "apply"),
      checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "policy-override"),
      checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "admin"),
      originsForRuns([authorized.run]),
      runDurationBaseline(authorized.run),
    ]);
    const linkage = await linkageForRuns([authorized.run]);
    const data = runResource(authorized.run, canApply, canOverridePolicy, origins.get(authorized.run.id), baseline, canAdmin, linkage.get(authorized.run.id));
    const detailAttributes = data["attributes"] as Record<string, unknown>;
    const lockedReason = authorized.workspace.lockedReason;
    detailAttributes["workspace-locked"] = authorized.workspace.locked === true;
    // Mirror lockedWorkspaceDetail: an absent or empty reason reads as
    // manually locked rather than leaking a bare empty string.
    detailAttributes["workspace-locked-reason"] = authorized.workspace.locked !== true
      ? null
      : lockedReason !== undefined && lockedReason !== null && lockedReason !== ""
        ? lockedReason
        : "Locked manually";
    // Issue #580: run-page Recover action signal. A verified recovery copy
    // (capture completion marker present) may be the only record of the
    // infrastructure state after an interrupted apply.
    detailAttributes["has-recovery-state"] = await exists(join(storageDir, "recovery", runId, ".recovered"));
    const includes = requestedRunIncludes(request);
    const included = await includedRunResources([authorized.run], request, includes);
    return { data, ...(included.length > 0 ? { included } : {}) };
  })
  .delete("/api/v2/runs/:run_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "admin");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(logs).where(eq(logs.runId, runId));
    await Promise.all([deleteRunLogArchive(runId), deletePlanJsonArtifact(runId)]);
    await db.delete(runs).where(eq(runs.id, runId));
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .post("/api/v2/runs/:run_id/modules", async ({ params, run, set }: ParamCtx): Promise<unknown> => {
    // Module artifacts callback from the terraform CLI (cloud protocol). The
    // run's own token may post module metadata; the payload is informational
    // only, so Terrence acknowledges and discards it. tfc-agent 1.30.1 fails
    // the run unless the response status is 201 (verified in traffic capture).
    const runId = params["run_id"] ?? "";
    if ((run === undefined || run === null || run.runId !== runId)) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    (set as { status: number }).status = 201;
    return { data: { modules: [] } };
  })
  .get("/api/v2/runs/:run_id/plan", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: planResource(authorized.run, request) };
  })
  .get("/api/v2/plans/:plan_id", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const rawPlanId = params["plan_id"] ?? "";
    const runId = rawPlanId.replace(/^plan-/, "");
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: planResource(authorized.run, request) };
  })
  .get("/api/v2/applies/:apply_id", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const rawApplyId = params["apply_id"] ?? "";
    const runId = rawApplyId.replace(/^apply-/, "");
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: applyResource(authorized.run, request) };
  })
  .get("/api/v2/applies/:apply_id/errored-state", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = (params["apply_id"] ?? "").replace(/^apply-/, "");
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined || authorized.run.status !== "errored") {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const state = await db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.runId, runId), eq(stateVersions.workspaceId, authorized.run.workspaceId)),
      orderBy: [desc(stateVersions.createdAt)],
    });
    if (state === undefined || typeof state.statePayload !== "string" || state.statePayload === "") {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const location = signedApiURL(request, `/api/v2/state-versions/${state.id}/download`, "GET");
    return new Response(null, { status: 307, headers: { Location: location } });
  })
  .get("/api/v2/runs/:run_id/run-events", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const page = pageRequest(request);
    const eventWhere = and(eq(auditLogs.resourceType, "runs"), eq(auditLogs.resourceId, runId));
    const commentWhere = eq(runComments.runId, runId);
    const [[eventCountRow], [commentCountRow]] = await Promise.all([
      db.select({ total: count() }).from(auditLogs).where(eventWhere),
      db.select({ total: count() }).from(runComments).where(commentWhere),
    ]);
    const totalCount = (eventCountRow?.total ?? 0) + (commentCountRow?.total ?? 0);
    const offset = runHistoryPageOffset(page, totalCount);
    const historyRows: readonly { id: string; kind: string; createdAt: number }[] = offset === null
      ? []
      : await (async (): Promise<readonly { id: string; kind: string; createdAt: number }[]> => {
        const eventIndex = db.select({
          id: auditLogs.id,
          kind: sql<string>`'event'`.as("kind"),
          createdAt: auditLogs.createdAt,
        }).from(auditLogs).where(eventWhere);
        const commentIndex = db.select({
          id: runComments.id,
          kind: sql<string>`'comment'`.as("kind"),
          createdAt: runComments.createdAt,
        }).from(runComments).where(commentWhere);
        const history = eventIndex.unionAll(commentIndex).as("run_history");
        return db.select({ id: history.id, kind: history.kind, createdAt: history.createdAt })
          .from(history)
          .orderBy(asc(history.createdAt), asc(history.id))
          .limit(page.size)
          .offset(offset);
      })();
    const eventIds = historyRows.filter((row): boolean => row.kind === "event").map((row): string => row.id);
    const commentIds = historyRows.filter((row): boolean => row.kind === "comment").map((row): string => row.id);
    const [events, comments] = await Promise.all([
      eventIds.length === 0
        ? Promise.resolve([] as AuditItem[])
        : db.query.auditLogs.findMany({ where: and(eventWhere, inArray(auditLogs.id, eventIds)) }),
      commentIds.length === 0
        ? Promise.resolve([] as CommentItem[])
        : db.query.runComments.findMany({ where: and(commentWhere, inArray(runComments.id, commentIds)) }),
    ]);
    const usernames = await usernamesById([
      ...events.map((event: AuditItem): string | null => event.userId),
      ...comments.map((comment: CommentItem): string | null => comment.userId),
    ]);
    const eventById = new Map(events.map((event): [string, AuditItem] => [event.id, event]));
    const commentById = new Map(comments.map((comment): [string, CommentItem] => [comment.id, comment]));
    const eventResources = historyRows.flatMap((row): Record<string, unknown>[] => {
      if (row.kind === "event") {
        const event = eventById.get(row.id);
        if (event === undefined) return [];
        const details = safeRunEventDetails(event);
        return [{
          id: event.id,
          type: "run-events",
          createdAt: event.createdAt,
          attributes: {
            action: event.action,
            "created-at": new Date(event.createdAt).toISOString(),
            "actor-username": event.userId === null ? details["actorUsername"] ?? null : usernames.get(event.userId)?.username ?? null,
            "actor-avatar-url": event.userId === null
              ? AvatarService.resolveVcsUrl(details["actorProviderId"], details["actorAvatarUrl"] ?? null)
              : gravatarUrl(usernames.get(event.userId)?.email ?? null),
            details,
          },
        }];
      }
      if (row.kind !== "comment") return [];
      const comment = commentById.get(row.id);
      if (comment === undefined) return [];
      return [{
        id: `re-${comment.id}`,
        type: "run-events",
        createdAt: comment.createdAt,
        attributes: {
          action: "comment",
          "created-at": new Date(comment.createdAt).toISOString(),
          "actor-username": comment.userId === null ? null : usernames.get(comment.userId)?.username ?? null,
          "actor-avatar-url": comment.userId === null ? null : gravatarUrl(usernames.get(comment.userId)?.email ?? null),
          details: { "comment-id": comment.id },
        },
        relationships: { comment: { data: { id: comment.id, type: "comments" } } },
      }];
    }).map((resource): Record<string, unknown> => Object.fromEntries(
      Object.entries(resource).filter(([key]): boolean => key !== "createdAt"),
    ));
    return {
      data: eventResources,
      ...pagination(request, page.number, page.size, totalCount),
    };
  })
  .get("/api/v2/runs/:run_id/input-state-version", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const inputStateId = authorized.run.statusTimestamps?.["input-state-version-id"];
    if (typeof inputStateId !== "string" || inputStateId === "") return { data: null };
    const currentSV = await db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.id, inputStateId), eq(stateVersions.workspaceId, authorized.run.workspaceId)),
    });
    if (currentSV === undefined) return { data: null };
    const { stateVersionResource } = await import("../lib/response");
    return { data: stateVersionResource(currentSV, request) };
  })
  .get("/api/v2/runs/:run_id/logs", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const page = pageRequest(request);
    const { logs: runLogs, totalCount, truncated } = await readRunLogsPage(runId, page);
    const paging = pagination(request, page.number, page.size, totalCount);
    return {
      data: runLogs.map((l: LogItem): Record<string, unknown> => ({ id: l.id, type: "logs", attributes: { phase: l.phase, "output-text": l.outputText, "created-at": l.createdAt } })),
      links: paging.links,
      meta: { ...paging.meta, truncated },
    };
  })
  .get("/api/v2/runs/:run_id/plan/log/:log_token", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const logToken = params["log_token"] ?? "";
    if ((await findLogCapability(runId, logToken)) === undefined) { (set as { status: number }).status = 404; return "Not Found"; }
    return rawRunLogResponse(runId, "plan", request, set);
  })
  .get("/api/v2/runs/:run_id/apply/log/:log_token", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const logToken = params["log_token"] ?? "";
    if ((await findLogCapability(runId, logToken)) === undefined) { (set as { status: number }).status = 404; return "Not Found"; }
    return rawRunLogResponse(runId, "apply", request, set);
  })
  .get("/api/v2/runs/:run_id/plan/log", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return rawRunLogResponse(runId, "plan", request, set);
  })
  .get("/api/v2/runs/:run_id/apply/log", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return rawRunLogResponse(runId, "apply", request, set);
  })
  .get("/api/v2/runs/:run_id/apply", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: `apply-${runId}`, type: "applies", attributes: { "log-read-url": typeof authorized.run.logToken === "string" && authorized.run.logToken !== "" ? apiURL(request, `/api/v2/runs/${runId}/apply/log/${authorized.run.logToken}`) : null } } };
  })
  .post("/api/v2/runs/:run_id/actions/apply", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, null, teamId ?? null, "apply"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (authorized.workspace.locked === true) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: lockedWorkspaceDetail(authorized.workspace.lockedReason) }] };
    }
    const before = await db.query.runs.findFirst({ where: and(eq(runs.id, runId), inArray(runs.status, ["planned", "planned_and_saved"])) });
    if (before === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must have a completed saved plan before apply" }] }; }
    const gateBlockReason = await applyGateBlockReason(new Date());
    if (gateBlockReason !== null) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: gateBlockReason }] };
    }
    let agentPoolId: string | null = null;
    if (authorized.workspace.executionMode === "agent") {
      const pool = authorized.workspace.agentPoolId === null
        ? undefined
        : await db.query.agentPools.findFirst({ where: eq(agentPools.id, authorized.workspace.agentPoolId) });
      if (
        pool?.orgId !== authorized.workspace.orgId
        || !(await agentPoolAllowsWorkspace(
          pool,
          authorized.workspace.id,
          authorized.workspace.projectId,
        ))
      ) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "The workspace does not have an allowed agent pool" }] };
      }
      agentPoolId = pool.id;
    }
    if (agentPoolId !== null) {
      const confirmedTimestamps = {
        ...(before.statusTimestamps ?? {}),
        "confirmed-at": new Date().toISOString(),
      };
      const job = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as typeof db;
        const confirmed = await tx.update(runs).set({
          status: "confirmed",
          scheduledAt: null,
          statusTimestamps: confirmedTimestamps,
        }).where(and(eq(runs.id, runId), eq(runs.status, before.status))).returning({ id: runs.id });
        if (confirmed.length === 0) return undefined;
        return insertAgentApplyJobTx(tx, runId, agentPoolId, confirmedTimestamps);
      });
      if (job === undefined) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Run apply is already queued" }] };
      }
      await auditLog("apply", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
        workspaceId: authorized.workspace.id,
        fromStatus: before.status,
        toStatus: "apply_queued",
        ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
      });
      const commentStr = actionComment(body);
      if (commentStr !== "") await createRunComment({ runId, userId: user?.id ?? null, body: commentStr, workspaceId: authorized.workspace.id, orgId: authorized.workspace.orgId });
      (set as { status: number }).status = 202;
      return new Response(null, { status: 202 });
    }
    const confirmed = await db.update(runs).set({
      status: "confirmed",
      scheduledAt: null,
      statusTimestamps: {
        ...(before.statusTimestamps ?? {}),
        "confirmed-at": new Date().toISOString(),
      },
    }).where(and(eq(runs.id, runId), eq(runs.status, before.status))).returning({ id: runs.id });
    if (confirmed.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run apply is already queued" }] }; }
    await auditLog("apply", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: before.status,
      toStatus: "confirmed",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    const commentStr = actionComment(body);
    if (commentStr !== "") await createRunComment({ runId, userId: user?.id ?? null, body: commentStr, workspaceId: authorized.workspace.id, orgId: authorized.workspace.orgId });
    const { executeApply } = await import("../worker");
    executeApply(authorized.run.id).catch((err: unknown): void => { if (err !== null && err !== undefined) { console.error(err); } });
    (set as { status: number }).status = 202;
    return new Response(null, { status: 202 });
  })
  .post("/api/v2/runs/:run_id/actions/schedule-apply", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    // Schedule a confirmed apply for a future time.
    // The worker applies the run when scheduled-at arrives; the manual apply
    // action clears the schedule and applies immediately.
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, null, teamId ?? null, "apply"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (authorized.workspace.locked === true) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: lockedWorkspaceDetail(authorized.workspace.lockedReason) }] };
    }
    const before = await db.query.runs.findFirst({
      where: and(
        eq(runs.id, runId),
        inArray(runs.status, ["planned", "planned_and_saved"]),
        // A saved plan is specifically intended to be scheduled later. Only
        // speculative/plan-only runs are excluded from apply scheduling.
        eq(runs.planOnly, false),
      ),
    });
    if (before === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must have a completed saved plan before apply" }] }; }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const attributes = payload["data"] !== null && typeof payload["data"] === "object"
      && (payload["data"] as Record<string, unknown>)["attributes"] !== null
      && typeof (payload["data"] as Record<string, unknown>)["attributes"] === "object"
      ? (payload["data"] as Record<string, unknown>)["attributes"] as Record<string, unknown>
      : {};
    const applyAtRaw = attributes["apply-at"];
    if (typeof applyAtRaw !== "string" || applyAtRaw === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "apply-at is required" }] };
    }
    const applyAtMs = Date.parse(applyAtRaw);
    if (!Number.isFinite(applyAtMs)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "apply-at must be a valid date" }] };
    }
    if (applyAtMs <= Date.now()) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "apply-at must be in the future" }] };
    }
    const confirmed = await db.update(runs).set({
      status: "confirmed",
      scheduledAt: applyAtMs,
      statusTimestamps: {
        ...(before.statusTimestamps ?? {}),
        "confirmed-at": new Date().toISOString(),
        "scheduled-at": new Date(applyAtMs).toISOString(),
      },
    }).where(and(eq(runs.id, runId), eq(runs.status, before.status))).returning({ id: runs.id });
    if (confirmed.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run apply is already queued" }] }; }
    await auditLog("schedule-apply", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: before.status,
      toStatus: "confirmed",
      "scheduled-at": new Date(applyAtMs).toISOString(),
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    // Match the manual apply action: an optional comment is persisted with
    // the confirmation.
    const commentStr = actionComment(body);
    if (commentStr !== "") await createRunComment({ runId, userId: user?.id ?? null, body: commentStr, workspaceId: authorized.workspace.id, orgId: authorized.workspace.orgId });
    publish("run.status", {
      "run-id": runId,
      "workspace-id": authorized.workspace.id,
      "org-id": authorized.workspace.orgId,
      status: "confirmed",
      at: new Date(applyAtMs).toISOString(),
    });
    scheduleExplorerInventory(authorized.workspace.id);
    return { data: { id: runId, type: "runs", attributes: { status: "confirmed", "scheduled-at": new Date(applyAtMs).toISOString() } } };
  })
  .post("/api/v2/runs/:run_id/actions/discard", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, null, teamId ?? null, "discard"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const updated = await db.update(runs).set({ status: "discarded" }).where(and(
      eq(runs.id, runId),
      eq(runs.status, authorized.run.status),
      inArray(runs.status, DISCARDABLE_RUN_STATUSES),
    )).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not discardable" }] }; }
    await revokeRunTokens(runId);
    const { cleanupRunWorkDir, cleanupSavedPlan } = await import("../worker");
    await cleanupSavedPlan(runId);
    await cleanupRunWorkDir(runId);
    const commentStr = actionComment(body);
    if (commentStr !== "") await createRunComment({ runId, userId: user?.id ?? null, body: commentStr, workspaceId: authorized.workspace.id, orgId: authorized.workspace.orgId });
    await auditLog("discard", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: authorized.run.status,
      toStatus: "discarded",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    queueRunNotification(runId, "run:errored", "discarded");
    (set as { status: number }).status = 202;
    return new Response(null, { status: 202 });
  })
  .post("/api/v2/runs/:run_id/actions/cancel", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, null, teamId ?? null, "cancel"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const canceledAt = new Date().toISOString();
    const updated = await db.update(runs).set({
      status: "canceled",
      statusTimestamps: {
        ...(authorized.run.statusTimestamps ?? {}),
        "cancel-requested-at": canceledAt,
        "canceled-at": canceledAt,
      },
    }).where(and(
      eq(runs.id, runId),
      eq(runs.status, authorized.run.status),
      inArray(runs.status, [
        "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
        "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated",
        "policy_checking", "policy_override", "policy_checked", "post_plan_running",
        "post_plan_completed", "confirmed", "apply_queued", "applying",
      ]),
    )).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] }; }
    await revokeRunTokens(runId);
    const { cancelRunExecution, cleanupSavedPlan, scheduleRunWorkDirCleanup } = await import("../worker");
    cancelRunExecution(runId);
    scheduleRunWorkDirCleanup(runId);
    await cleanupSavedPlan(runId);
    await cancelAgentJobsForRun(runId);
    await auditLog("cancel", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: authorized.run.status,
      toStatus: "canceled",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    queueRunNotification(runId, "run:errored", "canceled");
    (set as { status: number }).status = 202;
    return new Response(null, { status: 202 });
  })
  .post("/api/v2/runs/:run_id/actions/force-cancel", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const cancelRequestedAt = authorized.run.statusTimestamps?.["cancel-requested-at"];
    if (cancelRequestedAt === undefined || !["pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed", "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated", "policy_checking", "policy_override", "policy_checked", "post_plan_running", "post_plan_completed", "confirmed", "apply_queued", "applying", "canceled"].includes(authorized.run.status)) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Cancel the run before force-canceling it" }] };
    }
    const updated = await db.update(runs).set({ status: "force_canceled" }).where(and(
      eq(runs.id, runId),
      eq(runs.status, authorized.run.status),
      inArray(runs.status, ["pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed", "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated", "policy_checking", "policy_override", "policy_checked", "post_plan_running", "post_plan_completed", "confirmed", "apply_queued", "applying", "canceled"]),
    )).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] }; }
    await revokeRunTokens(runId);
    const { cancelRunExecution, cleanupSavedPlan, scheduleRunWorkDirCleanup } = await import("../worker");
    cancelRunExecution(runId, true);
    scheduleRunWorkDirCleanup(runId);
    await cleanupSavedPlan(runId);
    await cancelAgentJobsForRun(runId);
    await auditLog("force-cancel", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: authorized.run.status,
      toStatus: "force_canceled",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    queueRunNotification(runId, "run:errored", "force_canceled");
    (set as { status: number }).status = 202;
    return new Response(null, { status: 202 });
  })
  .post("/api/v2/runs/:run_id/actions/override-policy", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "policy-override"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = authorized.run;
    if (run.status !== "policy_soft_failed") { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must be policy_soft_failed to override" }] }; }
    // An override is an audited exception: the justification comment is
    // required and persisted, so the audit trail states the reason at the
    // moment it matters (CodeRabbit review).
    const justification = actionComment(body);
    if (justification === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Overriding a policy check requires a justification comment" }] }; }
    // One transaction for the whole override (CodeRabbit review): committing
    // the status change before the justification comment, the policy-check
    // update, and the audit record would leave a planned run without its
    // required justification on a mid-flight failure, and a retry would find
    // nothing left to override. Events publish only after commit.
    const commentId = `rc-${crypto.randomUUID()}`;
    const actorId = user?.id ?? null;
    const workspace = authorized.workspace;
    const now = Date.now();
    const updated = await db.transaction(async (tx: unknown) => {
      const t = tx as typeof db;
      const rows = await t.update(runs).set({ status: "planned" }).where(and(eq(runs.id, runId), eq(runs.status, "policy_soft_failed"))).returning();
      if (rows.length === 0) return rows;
      await t.insert(runComments).values({ id: commentId, runId, userId: actorId, body: justification, createdAt: now });
      await t.update(policyChecks).set({ status: "overridden" }).where(and(eq(policyChecks.runId, runId), inArray(policyChecks.status, ["soft_failed", "failed"])));
      await t.insert(auditLogs).values({
        id: crypto.randomUUID(),
        orgId: workspace.orgId,
        userId: actorId,
        action: "override-policy",
        resourceType: "runs",
        resourceId: runId,
        details: {
          workspaceId: workspace.id,
          fromStatus: "policy_soft_failed",
          toStatus: "planned",
          justification,
          ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
        },
        createdAt: now,
      });
      return rows;
    });
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is no longer awaiting policy override" }] }; }
    publish("comment.created", {
      "run-id": runId,
      "workspace-id": workspace.id,
      "org-id": workspace.orgId,
      "comment-id": commentId,
    });
    queueRunNotification(runId, "run:needs_attention", "planned");
    const updatedRun = updated[0];
    if (updatedRun === undefined) {
      (set as { status: number }).status = 500;
      return { errors: [{ status: "500", title: "Internal Server Error" }] };
    }
    return { data: await actionRunResource(updatedRun, authorized.workspace, user?.id, orgId ?? null, teamId ?? null) };
  })
  .post("/api/v2/runs/:run_id/actions/force-execute", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (authorized.run.status !== "pending") { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must be pending to force-execute" }] }; }
    // Issue #583: derive the stoppable list from the workspace blocking set
    // minus the resting states a user can discard themselves (planned,
    // policy_soft_failed). The old four-status list reported nothing blocking
    // while fetching/confirmed/policy runs held the queue.
    const forceExecuteBlockingStatuses = WORKSPACE_BLOCKING_RUN_STATUSES.filter(
      (status): boolean => !(DISCARDABLE_RUN_STATUSES as readonly string[]).includes(status),
    );
    const restingBlockingStatuses = WORKSPACE_BLOCKING_RUN_STATUSES.filter(
      (status): boolean => (DISCARDABLE_RUN_STATUSES as readonly string[]).includes(status),
    );
    // A blocker in a discardable resting state (planned, policy_soft_failed)
    // still holds the queue but must be discarded, not force-executed — and a
    // force-execute that only clears active blockers would 202 while the
    // target stays queued behind it. Surface the discard hint before touching
    // anything. Speculative and save-plan runs never hold the queue, so they
    // are excluded here exactly as for active blockers below.
    const restingBlockers = await db.query.runs.findMany({
      where: and(
        eq(runs.workspaceId, authorized.workspace.id),
        inArray(runs.status, [...restingBlockingStatuses]),
        ne(runs.id, runId),
      ),
      columns: { id: true, status: true, planOnly: true, savePlan: true },
      orderBy: [asc(runs.createdAt), asc(runs.id)],
    });
    const resting = restingBlockers.find((run): boolean => run.planOnly !== true && run.savePlan !== true);
    if (resting !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: `Run ${resting.id} is ${resting.status}; discard it before force-executing this run` }] };
    }
    const blockers = await db.query.runs.findMany({
      where: and(eq(runs.workspaceId, authorized.workspace.id), inArray(runs.status, [...forceExecuteBlockingStatuses]), ne(runs.id, runId)),
      orderBy: [asc(runs.createdAt), asc(runs.id)],
    });
    const blockingRuns = blockers.filter((run): boolean => run.planOnly !== true && run.savePlan !== true);
    if (blockingRuns.length === 0) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "No blocking run is available to force-execute" }] };
    }
    const blockerCanceled = await db.update(runs).set({ status: "force_canceled" }).where(and(
      inArray(runs.id, blockingRuns.map((run): string => run.id)),
      inArray(runs.status, [...forceExecuteBlockingStatuses]),
    )).returning({ id: runs.id });
    if (blockerCanceled.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "The blocking run changed before it could be stopped" }] }; }
    const { cancelRunExecution, cleanupSavedPlan } = await import("../worker");
    await Promise.all(blockerCanceled.map(async ({ id }): Promise<void> => {
      await revokeRunTokens(id);
      cancelRunExecution(id, true);
      await cleanupSavedPlan(id);
      await cancelAgentJobsForRun(id);
    }));
    const updated = await db.update(runs).set({ status: "pending" }).where(and(eq(runs.id, runId), eq(runs.status, authorized.run.status))).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-executable" }] }; }
    await auditLog("force-execute", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: authorized.run.status,
      toStatus: "pending",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    queueRunNotification(runId, "run:needs_attention", "pending");
    (set as { status: number }).status = 202;
    return new Response(null, { status: 202 });
  })
  .post("/api/v2/runs/:run_id/actions/queue", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (authorized.run.status === "plan_queued" || authorized.run.status === "apply_queued") {
      const { cancelRunExecution, cleanupSavedPlan } = await import("../worker");
      cancelRunExecution(runId, true);
      await cleanupSavedPlan(runId);
      await cancelAgentJobsForRun(runId);
    }
    const updated = await db.update(runs).set({ status: "pending" }).where(and(
      eq(runs.id, runId),
      eq(runs.status, authorized.run.status),
      inArray(runs.status, ["pending", "plan_queued", "apply_queued"]),
    )).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not queued" }] }; }
    await auditLog("queue", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: authorized.run.status,
      toStatus: "pending",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    const updatedRun = updated[0];
    if (updatedRun === undefined) {
      (set as { status: number }).status = 500;
      return { errors: [{ status: "500", title: "Internal Server Error" }] };
    }
    return { data: await actionRunResource(updatedRun, authorized.workspace, user?.id, orgId ?? null, teamId ?? null) };
  })
  // --- Comments ---
  .get("/api/v2/runs/:run_id/comments", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const page = pageRequest(request);
    const commentWhere = eq(runComments.runId, runId);
    const [countRow] = await db.select({ total: count() }).from(runComments).where(commentWhere);
    const totalCount = countRow?.total ?? 0;
    const offset = runHistoryPageOffset(page, totalCount);
    const commentsList = offset === null
      ? []
      : await db.query.runComments.findMany({
        where: commentWhere,
        orderBy: [asc(runComments.createdAt), asc(runComments.id)],
        limit: page.size,
        offset,
      });
    const enriched = await enrichCommentsWithActors(commentsList);
    return {
      data: enriched.map((comment): Record<string, unknown> => commentResource(comment)),
      ...pagination(request, page.number, page.size, totalCount),
    };
  })
  .post("/api/v2/runs/:run_id/comments", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    if (data?.["type"] !== "comments") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be comments" }] }; }
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const textVal = attrs["body"] ?? payload["body"];
    const text = typeof textVal === "string" ? textVal : "";
    if (text === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const { id, createdAt } = await createRunComment({ runId, userId: user?.id ?? null, body: text, workspaceId: authorized.workspace.id, orgId: authorized.workspace.orgId });
    (set as { status: number }).status = 201;
    let actor: { username?: string | null; avatarUrl?: string | null } = {};
    if (user !== undefined && user !== null) {
      actor = { username: user.username, avatarUrl: gravatarUrl(user.email) };
    }
    return { data: commentResource({ id, runId, body: text, userId: user?.id ?? null, createdAt, ...actor }) };
  })
  .delete("/api/v2/comments/:comment_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const commentId = params["comment_id"] ?? "";
    const c = await db.query.runComments.findFirst({ where: eq(runComments.id, commentId) });
    if (c === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(c.runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(runComments).where(eq(runComments.id, commentId));
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .get("/api/v2/comments/:comment_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const commentId = params["comment_id"] ?? "";
    const comment = await db.query.runComments.findFirst({ where: eq(runComments.id, commentId) });
    if (comment === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(comment.runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [enrichedSingle] = await enrichCommentsWithActors([comment]);
    return { data: commentResource(enrichedSingle ?? comment) };
  })
  // --- Plan JSON Output ---
  .get("/api/v2/plans/:plan_id/json-output", async ({ params, user, orgId, teamId, run: runContext, set }: ParamCtx): Promise<unknown> => {
    const planId = params["plan_id"] ?? "";
    const runId = planId.replace(/^plan-/, "");
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await authorizedRawPlanWorkspace(runId, run, runContext, user?.id, orgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const planJson = await readPlanJsonArtifact(runId);
    if (planJson === undefined) {
      if (isPlanIncompleteRunStatus(run.status)) {
        // the reference format contract: 204 means "plan JSON supported, but the plan has not
        // completed yet". The artifact will arrive when planning finishes.
        (set as { status: number }).status = 204;
        return null;
      }
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "Plan JSON output is unavailable" }] };
    }
    return planJson;
  })
  .get("/api/v2/runs/:run_id/plan/json-output", async ({ params, user, orgId, teamId, run: runContext, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined || await authorizedRawPlanWorkspace(runId, run, runContext, user?.id, orgId ?? null, teamId ?? null) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const planJson = await readPlanJsonArtifact(runId);
    if (planJson === undefined) {
      if (isPlanIncompleteRunStatus(run.status)) { (set as { status: number }).status = 204; return null; }
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "Plan JSON output is unavailable" }] };
    }
    return planJson;
  })
  .get("/api/v2/plans/:plan_id/json-output-redacted", async ({ params, user, orgId, teamId, run: runContext, set }: ParamCtx): Promise<unknown> => {
    const planId = params["plan_id"] ?? "";
    const runId = planId.replace(/^plan-/, "");
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (await authorizedPlanWorkspace(runId, run, runContext, user?.id, orgId ?? null, teamId ?? null) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return sanitizedPlanArtifactResponse(runId, run, set);
  })
  .get("/api/v2/plans/:plan_id/sanitized-plan", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const planId = params["plan_id"] ?? "";
    const runId = planId.replace(/^plan-/, "");
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined || await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId ?? null, teamId ?? null) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return sanitizedPlanArtifactResponse(runId, run, set);
  })
  .get("/api/v2/runs/:run_id/plan/sanitized-plan", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined || await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId ?? null, teamId ?? null) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return sanitizedPlanArtifactResponse(runId, run, set);
  });
