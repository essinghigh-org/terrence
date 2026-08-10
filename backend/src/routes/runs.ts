import { createHash } from "node:crypto";
import { Elysia } from "elysia";
import { db } from "../db";
import { agentPools, runs, workspaces, configurationVersions, organizations, logs, stateVersions, policyChecks, runComments, auditLogs, users } from "../db/schema";
import { eq, and, desc, asc, count, inArray, ne, notInArray, isNull } from "drizzle-orm";
import { runResource, planResource, applyResource, userResource } from "../lib/response";
import { validateVersion, checkOrgPermission, checkWorkspacePermission, findAuthorizedWorkspace, findAuthorizedRun, findLogCapability, pageRequest, pagination, logChunk, workspaceIdsForPermission, workspaceRunHistoryWhere, apiURL, CAPACITY_PENDING_STATUSES, CAPACITY_RUNNING_STATUSES, auditLog, type WorkspacePermission , type DeepReadonly } from "../lib/utils";
import { createConfigurationVersionFromVcs } from "../lib/webhooks";
import { deleteRunLogArchive, readRunLogs } from "../lib/run-logs";
import { deletePlanJsonArtifact, readPlanJsonArtifact } from "../lib/plan-json";
import { authPlugin } from "../auth";
import { queueRunNotification } from "../lib/notifications";
import { agentPoolAllowsWorkspace } from "../lib/agent-pool-scope";
import { enqueueAgentApplyJob } from "../lib/agent-jobs";
import { AvatarService } from "../lib/avatars";

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
  run: Readonly<typeof runs.$inferSelect>,
): Promise<Readonly<{
  "duration-seconds": number;
  "median-duration-seconds": number;
  "is-slow": boolean;
}> | null> {
  const timestamps = (run.statusTimestamps ?? {}) as Readonly<Record<string, string | undefined>>;
  const start = timestamps["planned-at"] ?? timestamps["pending-at"];
  const end = timestamps["applied-at"] ?? timestamps["planned-finished-at"] ?? timestamps["applied-finished-at"] ?? timestamps["errored-at"];
  if (typeof start !== "string" || typeof end !== "string") return null;
  const durationMs = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;

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
    const ts = (other.statusTimestamps ?? {}) as Readonly<Record<string, string | undefined>>;
    const otherStart = ts["planned-at"] ?? ts["pending-at"];
    const otherEnd = ts["applied-at"] ?? ts["planned-finished-at"] ?? ts["applied-finished-at"] ?? ts["errored-at"];
    if (typeof otherStart === "string" && typeof otherEnd === "string") {
      const ms = Date.parse(otherEnd) - Date.parse(otherStart);
      if (Number.isFinite(ms) && ms > 0) durations.push(ms);
    }
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

function originForConfiguration(
  configuration: ConfigurationVersionItem | undefined,
): RunOrigin | undefined {
  if (configuration === undefined) return undefined;
  const source = configuration.source ?? "tfe-api";
  const ingress = configuration.ingressAttributes;
  const triggerReason = !VCS_RUN_SOURCES.has(source)
    ? "manual"
    : (ingress as Record<string, unknown>).manualTrigger === true
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
    const key = variable.key;
    const value = variable.value;
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

function actionComment(body: unknown): string {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const data = payload.data as Record<string, unknown> | undefined;
  const attributes = typeof data?.attributes === "object" && data.attributes !== null
    ? data.attributes as Record<string, unknown>
    : {};
  const value = payload.comment ?? attributes.comment;
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
  const message = typeof attributes.message === "string" ? attributes.message : "";
  const isDestroy = typeof attributes["is-destroy"] === "boolean" ? attributes["is-destroy"] : false;
  const requestedAutoApply = typeof attributes["auto-apply"] === "boolean" ? attributes["auto-apply"] : undefined;
  const requestedPlanOnly = typeof attributes["plan-only"] === "boolean" ? attributes["plan-only"] : undefined;
  const refresh = typeof attributes.refresh === "boolean" ? attributes.refresh : true;
  const refreshOnly = typeof attributes["refresh-only"] === "boolean" ? attributes["refresh-only"] : false;
  const targetAddrs = Array.isArray(attributes["target-addrs"]) ? (attributes["target-addrs"] as string[]) : null;
  const replaceAddrs = Array.isArray(attributes["replace-addrs"]) ? (attributes["replace-addrs"] as string[]) : null;
  const runVariables = Array.isArray(attributes.variables) ? attributes.variables : null;
  const terraformVersion = typeof attributes["terraform-version"] === "string" ? attributes["terraform-version"] : undefined;
  const debuggingMode = typeof attributes["debugging-mode"] === "boolean" ? attributes["debugging-mode"] : false;
  const allowEmptyApply = typeof attributes["allow-empty-apply"] === "boolean" ? attributes["allow-empty-apply"] : false;
  const savePlan = typeof attributes["save-plan"] === "boolean" ? attributes["save-plan"] : false;
  const allowConfigGeneration = typeof attributes["allow-config-generation"] === "boolean" ? attributes["allow-config-generation"] : false;
  if (workspaceId === "") { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Workspace ID is required" }] }; }
  if (terraformVersion !== undefined && !validateVersion(terraformVersion)) {
    (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid run attributes" }] };
  }
  const invalidInputs = validateRunInputs(
    attributes.variables,
    attributes["target-addrs"],
    attributes["replace-addrs"],
    set,
  );
  if (invalidInputs !== null) return invalidInputs;
  const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null);
  if (workspace === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
  if (!(await checkWorkspacePermission(workspace, user?.id, null, teamId ?? null, "plan"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
  if (isDestroy && workspace.allowDestroyPlan === false) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Destroy plans are disabled for this workspace" }] };
  }
  const canApply = await checkWorkspacePermission(workspace, user?.id, null, teamId ?? null, "apply");
  if (!canApply && (requestedAutoApply === true || allowEmptyApply)) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
  const autoApply = canApply && (requestedAutoApply ?? workspace.autoApply === true);
  let configurationVersion: typeof configurationVersions.$inferSelect | undefined;
  if (cvId !== undefined) {
    configurationVersion = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (configurationVersion?.workspaceId !== workspaceId) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Configuration version does not belong to workspace" }] }; }
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
    // latest uploaded configuration version (matches TFE behaviour; tfe_workspace_run
    // creates runs without claiming a config version, and the worker only plans
    // runs that have one).
    const latest = await db.query.configurationVersions.findFirst({
      where: and(eq(configurationVersions.workspaceId, workspaceId), inArray(configurationVersions.status, ["uploaded", "pending"])),
      orderBy: [desc(configurationVersions.createdAt)],
    });
    if (latest !== undefined) {
      cvId = latest.id;
      configurationVersion = latest;
    }
  }
  if (workspace.iacBinary === null) { await db.update(workspaces).set({ iacBinary: "terraform" }).where(eq(workspaces.id, workspace.id)); }
  const id = `run-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const createdAt = Date.now();
  const logToken = crypto.randomUUID();
  const planOnly = requestedPlanOnly ?? configurationVersion?.speculative ?? false;
  const nowIso = new Date(createdAt).toISOString();
  const finalMsg = message !== "" ? message : "Triggered via UI";
  const origin = originForConfiguration(configurationVersion);
  await db.insert(runs).values({ id, workspaceId, configurationVersionId: cvId ?? null, message: finalMsg, status: "pending", isDestroy, autoApply, planOnly, refresh, refreshOnly, targetAddrs, replaceAddrs, variables: runVariables, logToken, terraformVersion: terraformVersion ?? null, debuggingMode, allowEmptyApply, savePlan, allowConfigGeneration, statusTimestamps: { "pending-at": nowIso }, createdBy: user?.id ?? null, appliedAt: null, createdAt });
  await auditLog("create", "runs", id, user?.id ?? null, workspace.orgId, {
    workspaceId,
    status: "pending",
    source: origin?.source ?? "tfe-api",
    triggerReason: origin?.triggerReason ?? "manual",
  });
  queueRunNotification(id, "run:created", "pending");
  (set as { status: number }).status = 201;
  return { data: runResource({ id, workspaceId, configurationVersionId: cvId ?? null, agentPoolId: null, agentId: null, message: finalMsg, status: "pending", isDestroy, autoApply, planOnly, refresh, refreshOnly, targetAddrs, replaceAddrs, variables: runVariables, logToken, terraformVersion: terraformVersion ?? null, debuggingMode, allowEmptyApply, savePlan, allowConfigGeneration, statusTimestamps: { "pending-at": nowIso }, planResourceAdditions: null, planResourceChanges: null, planResourceDestructions: null, planResourceImports: null, applyResourceAdditions: null, applyResourceChanges: null, applyResourceDestructions: null, applyResourceImports: null, createdBy: user?.id ?? null, appliedAt: null, softDeletedAt: null, createdAt }, canApply, false, origin) };
}

export const runRoutes = new Elysia({ name: "runs" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/runs", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, teamId ?? null);
    if (workspace === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const canApply = await checkWorkspacePermission(workspace, user?.id, orgId ?? null, teamId ?? null, "apply");
    const { number, size } = pageRequest(request);
    const where = workspaceRunHistoryWhere(request, workspaceId);
    const [workspaceRuns, countRows] = await Promise.all([
      db.query.runs.findMany({ where, orderBy: [desc(runs.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    const origins = await originsForRuns(workspaceRuns);
    const data = workspaceRuns.map((r: RunItem): Record<string, unknown> => runResource(r, canApply, false, origins.get(r.id)));
    const included = await includedUsersForRuns(workspaceRuns);
    return { data, ...(included.length > 0 ? { included } : {}), ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/organizations/:org_name/runs", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId ?? null, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [orgWorkspaces, applyIds] = await Promise.all([
      authorizedOrgWorkspaces(organization.id, user?.id, orgId ?? null, teamId ?? null),
      workspaceIdsForPermission(organization.id, user?.id, orgId ?? null, teamId ?? null, "apply"),
    ]);
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) { return { data: [], ...pagination(request, number, size, 0) }; }
    const where = inArray(runs.workspaceId, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id));
    const [orgRuns, countRows] = await Promise.all([
      db.query.runs.findMany({ where, orderBy: [desc(runs.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    const applySet = new Set(applyIds ?? []);
    const origins = await originsForRuns(orgRuns);
    const data = orgRuns.map((r: RunItem): Record<string, unknown> => runResource(r, applyIds === null || applySet.has(r.workspaceId), false, origins.get(r.id)));
    const included = await includedUsersForRuns(orgRuns);
    return { data, ...(included.length > 0 ? { included } : {}), ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/organizations/:org_name/runs/queue", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId ?? null, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [orgWorkspaces, applyIds] = await Promise.all([
      authorizedOrgWorkspaces(organization.id, user?.id, orgId ?? null, teamId ?? null),
      workspaceIdsForPermission(organization.id, user?.id, orgId ?? null, teamId ?? null, "apply"),
    ]);
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) { return { data: [], ...pagination(request, number, size, 0) }; }
    const queue = await db.query.runs.findMany({
      where: and(inArray(runs.workspaceId, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id)), inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES])),
      orderBy: [asc(runs.createdAt)],
    });
    let position = queue.filter((r: Readonly<{ readonly status: string }>): boolean => CAPACITY_RUNNING_STATUSES.some((s: string): boolean => s === r.status)).length;
    const applySet = new Set(applyIds ?? []);
    const origins = await originsForRuns(queue);
    const data = queue.map((r: RunItem): Record<string, unknown> => {
      const resource = runResource(r, applyIds === null || applySet.has(r.workspaceId), false, origins.get(r.id));
      const isPending = CAPACITY_PENDING_STATUSES.some((s: string): boolean => s === r.status);
      if (isPending) { position += 1; }
      const attrs = typeof resource.attributes === "object" && resource.attributes !== null ? (resource.attributes as Record<string, unknown>) : {};
      return { ...resource, attributes: { ...attrs, "position-in-queue": isPending ? position : 0 } };
    }).slice((number - 1) * size, number * size);
    const included = await includedUsersForRuns(queue);
    return { data, ...(included.length > 0 ? { included } : {}), ...pagination(request, number, size, queue.length) };
  })
  .get("/api/v2/organizations/:org_name/capacity", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId ?? null, teamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const orgWorkspaces = await authorizedOrgWorkspaces(organization.id, user?.id, orgId ?? null, teamId ?? null);
    const active = orgWorkspaces.length === 0 ? [] : await db.query.runs.findMany({
      columns: { status: true },
      where: and(inArray(runs.workspaceId, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id)), inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES])),
    });
    return { data: { id: organization.name, type: "organization-capacity", attributes: { pending: active.filter((r: Readonly<{ readonly status: string }>): boolean => CAPACITY_PENDING_STATUSES.some((s: string): boolean => s === r.status)).length, running: active.filter((r: Readonly<{ readonly status: string }>): boolean => CAPACITY_RUNNING_STATUSES.some((s: string): boolean => s === r.status)).length } } };
  })
  .post("/api/v2/workspaces/:workspace_id/runs", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const wsId = params.workspace_id ?? "";
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const cvRel = typeof rels["configuration-version"] === "object" && rels["configuration-version"] !== null ? (rels["configuration-version"] as Record<string, unknown>) : {};
    const cvData = typeof cvRel.data === "object" && cvRel.data !== null ? (cvRel.data as Record<string, unknown>) : {};
    const cvId = typeof cvData.id === "string" ? cvData.id : (typeof attributes["configuration-version-id"] === "string" ? attributes["configuration-version-id"] : undefined);
    return createRun(wsId, attributes, cvId, user, orgId, teamId, set);
  })
  .post("/api/v2/runs", async ({ body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const wsRel = typeof rels.workspace === "object" && rels.workspace !== null ? (rels.workspace as Record<string, unknown>) : {};
    const wsData = typeof wsRel.data === "object" && wsRel.data !== null ? (wsRel.data as Record<string, unknown>) : {};
    const cvRel = typeof rels["configuration-version"] === "object" && rels["configuration-version"] !== null ? (rels["configuration-version"] as Record<string, unknown>) : {};
    const cvData = typeof cvRel.data === "object" && cvRel.data !== null ? (cvRel.data as Record<string, unknown>) : {};
    const workspaceId = typeof wsData.id === "string" ? wsData.id : "";
    const cvId = typeof cvData.id === "string" ? cvData.id : (typeof attributes["configuration-version-id"] === "string" ? attributes["configuration-version-id"] : undefined);
    return createRun(workspaceId, attributes, cvId, user, orgId, teamId, set);
  })
  .get("/api/v2/runs/:run_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [canApply, canOverridePolicy, origins, baseline] = await Promise.all([
      checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "apply"),
      checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "policy-override"),
      originsForRuns([authorized.run]),
      runDurationBaseline(authorized.run),
    ]);
    const data = runResource(authorized.run, canApply, canOverridePolicy, origins.get(authorized.run.id), baseline);
    const included = await includedUsersForRuns([authorized.run]);
    return { data, ...(included.length > 0 ? { included } : {}) };
  })
  .delete("/api/v2/runs/:run_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "admin");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(logs).where(eq(logs.runId, runId));
    await Promise.all([deleteRunLogArchive(runId), deletePlanJsonArtifact(runId)]);
    await db.delete(runs).where(eq(runs.id, runId));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/runs/:run_id/plan", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: planResource(authorized.run, request) };
  })
  .get("/api/v2/plans/:plan_id", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const rawPlanId = params.plan_id ?? "";
    const runId = rawPlanId.replace(/^plan-/, "");
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: planResource(authorized.run, request) };
  })
  .get("/api/v2/applies/:apply_id", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const rawApplyId = params.apply_id ?? "";
    const runId = rawApplyId.replace(/^apply-/, "");
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: applyResource(authorized.run, request) };
  })
  .get("/api/v2/runs/:run_id/run-events", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const events = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.resourceType, "runs"), eq(auditLogs.resourceId, runId)),
      orderBy: [asc(auditLogs.createdAt), asc(auditLogs.id)],
    });
    const usernames = await usernamesById(events.map((event: AuditItem): string | null => event.userId));
    return {
      data: events.map((event: AuditItem): Record<string, unknown> => ({
        id: event.id,
        type: "run-events",
        attributes: {
          action: event.action,
          "created-at": new Date(event.createdAt).toISOString(),
          "actor-username": event.userId === null ? safeRunEventDetails(event).actorUsername ?? null : usernames.get(event.userId)?.username ?? null,
          "actor-avatar-url": event.userId === null
            ? AvatarService.resolveVcsUrl(safeRunEventDetails(event).actorProviderId, safeRunEventDetails(event).actorAvatarUrl ?? null)
            : gravatarUrl(usernames.get(event.userId)?.email ?? null),
          details: safeRunEventDetails(event),
        },
      })),
    };
  })
  .get("/api/v2/runs/:run_id/input-state-version", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const currentSV = await db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.workspaceId, authorized.run.workspaceId), ne(stateVersions.runId, runId)),
      orderBy: desc(stateVersions.serial),
    });
    if (currentSV === undefined) return { data: null };
    const { stateVersionResource } = await import("../lib/response");
    return { data: stateVersionResource(currentSV, request) };
  })
  .get("/api/v2/runs/:run_id/logs", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const runLogs = await readRunLogs(runId);
    return { data: runLogs.map((l: LogItem): Record<string, unknown> => ({ id: l.id, type: "logs", attributes: { phase: l.phase, "output-text": l.outputText, "created-at": l.createdAt } })) };
  })
  .get("/api/v2/runs/:run_id/plan/log/:log_token", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const logToken = params.log_token ?? "";
    if ((await findLogCapability(runId, logToken)) === undefined) { (set as { status: number }).status = 404; return "Not Found"; }
    const planLogs = await readRunLogs(runId, "plan");
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map((l: Readonly<{ readonly outputText: string }>): string => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/apply/log/:log_token", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const logToken = params.log_token ?? "";
    if ((await findLogCapability(runId, logToken)) === undefined) { (set as { status: number }).status = 404; return "Not Found"; }
    const applyLogs = await readRunLogs(runId, "apply");
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map((l: Readonly<{ readonly outputText: string }>): string => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/plan/log", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const planLogs = await readRunLogs(runId, "plan");
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map((l: Readonly<{ readonly outputText: string }>): string => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/apply/log", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const applyLogs = await readRunLogs(runId, "apply");
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map((l: Readonly<{ readonly outputText: string }>): string => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/apply", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: `apply-${runId}`, type: "applies", attributes: { "log-read-url": typeof authorized.run.logToken === "string" && authorized.run.logToken !== "" ? apiURL(request, `/api/v2/runs/${runId}/apply/log/${authorized.run.logToken}`) : null } } };
  })
  .post("/api/v2/runs/:run_id/actions/apply", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, null, teamId ?? null, "apply"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const before = await db.query.runs.findFirst({ where: and(eq(runs.id, runId), inArray(runs.status, ["planned", "planned_and_saved"])) });
    if (before === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must have a completed saved plan before apply" }] }; }
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
    const confirmed = await db.update(runs).set({
      status: "confirmed",
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
    if (commentStr !== "") await db.insert(runComments).values({ id: `rc-${crypto.randomUUID()}`, runId, userId: user?.id ?? null, body: commentStr, createdAt: Date.now() });
    if (agentPoolId !== null) {
      const job = await enqueueAgentApplyJob(authorized.run.id, agentPoolId);
      if (job === undefined) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Run apply is already queued" }] };
      }
      return { data: { id: authorized.run.id, type: "runs", attributes: { status: "apply_queued" } } };
    }
    const { executeApply } = await import("../worker");
    executeApply(authorized.run.id).catch((err: unknown): void => { if (err !== null && err !== undefined) { console.error(err); } });
    return { data: { id: authorized.run.id, type: "runs", attributes: { status: "applying" } } };
  })
  .post("/api/v2/runs/:run_id/actions/discard", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, null, teamId ?? null, "discard"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const updated = await db.update(runs).set({ status: "discarded" }).where(and(eq(runs.id, runId), eq(runs.status, authorized.run.status), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not discardable" }] }; }
    const commentStr = actionComment(body);
    if (commentStr !== "") await db.insert(runComments).values({ id: `rc-${crypto.randomUUID()}`, runId, userId: user?.id ?? null, body: commentStr, createdAt: Date.now() });
    await auditLog("discard", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: authorized.run.status,
      toStatus: "discarded",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    queueRunNotification(runId, "run:errored", "discarded");
    return { data: { id: runId, type: "runs", attributes: { status: "discarded" } } };
  })
  .post("/api/v2/runs/:run_id/actions/cancel", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, null, teamId ?? null, "cancel"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const updated = await db.update(runs).set({ status: "canceled" }).where(and(eq(runs.id, runId), eq(runs.status, authorized.run.status), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] }; }
    await auditLog("cancel", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: authorized.run.status,
      toStatus: "canceled",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    queueRunNotification(runId, "run:errored", "canceled");
    return { data: { id: runId, type: "runs", attributes: { status: "canceled" } } };
  })
  .post("/api/v2/runs/:run_id/actions/force-cancel", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const updated = await db.update(runs).set({ status: "force_canceled" }).where(and(eq(runs.id, runId), eq(runs.status, authorized.run.status), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] }; }
    await auditLog("force-cancel", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: authorized.run.status,
      toStatus: "force_canceled",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    queueRunNotification(runId, "run:errored", "force_canceled");
    return { data: { id: runId, type: "runs", attributes: { status: "force_canceled" } } };
  })
  .post("/api/v2/runs/:run_id/actions/override-policy", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "policy-override"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = authorized.run;
    if (run.status !== "policy_soft_failed") { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must be policy_soft_failed to override" }] }; }
    await db.update(policyChecks).set({ status: "overridden" }).where(and(eq(policyChecks.runId, runId), inArray(policyChecks.status, ["soft_failed", "failed"])));
    await db.update(runs).set({ status: "planned" }).where(eq(runs.id, runId));
    await auditLog("override-policy", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: "policy_soft_failed",
      toStatus: "planned",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    queueRunNotification(runId, "run:needs_attention", "planned");
    return { data: { id: runId, type: "runs", attributes: { status: "planned" } } };
  })
  .post("/api/v2/runs/:run_id/actions/force-execute", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    if (authorized.run.status !== "canceled") { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must be canceled to force-execute" }] }; }
    const updated = await db.update(runs).set({ status: "pending" }).where(and(eq(runs.id, runId), eq(runs.status, "canceled"))).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-executable" }] }; }
    await auditLog("force-execute", "runs", runId, user?.id ?? null, authorized.workspace.orgId, {
      workspaceId: authorized.workspace.id,
      fromStatus: "canceled",
      toStatus: "pending",
      ...(teamId !== null && teamId !== undefined ? { teamId } : {}),
    });
    queueRunNotification(runId, "run:needs_attention", "pending");
    return { data: { id: runId, type: "runs", attributes: { status: "pending" } } };
  })
  .post("/api/v2/runs/:run_id/actions/queue", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkWorkspacePermission(authorized.workspace, user?.id, orgId ?? null, teamId ?? null, "admin"))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
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
    return { data: { id: runId, type: "runs", attributes: { status: "pending" } } };
  })
  // --- Comments ---
  .get("/api/v2/runs/:run_id/comments", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const commentsList = await db.query.runComments.findMany({
      where: eq(runComments.runId, runId),
      orderBy: [asc(runComments.createdAt), asc(runComments.id)],
    });
    const usernames = await usernamesById(commentsList.map((comment: CommentItem): string | null => comment.userId));
    return {
      data: commentsList.map((comment: CommentItem): Record<string, unknown> => ({
        id: comment.id,
        type: "comments",
        attributes: {
          body: comment.body,
          "created-at": new Date(comment.createdAt).toISOString(),
          "actor-username": comment.userId === null ? null : usernames.get(comment.userId)?.username ?? null,
          "actor-avatar-url": comment.userId === null ? null : gravatarUrl(usernames.get(comment.userId)?.email ?? null),
        },
      })),
    };
  })
  .post("/api/v2/runs/:run_id/comments", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const textVal = attrs.body ?? payload.body;
    const text = typeof textVal === "string" ? textVal : "";
    if (text === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `rc-${crypto.randomUUID()}`;
    const createdAt = Date.now();
    await db.insert(runComments).values({ id, runId, userId: user?.id ?? null, body: text, createdAt });
    (set as { status: number }).status = 201;
    return {
      data: {
        id,
        type: "comments",
        attributes: {
          body: text,
          "created-at": new Date(createdAt).toISOString(),
          "actor-username": user?.username ?? null,
        },
      },
    };
  })
  .delete("/api/v2/comments/:comment_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const commentId = params.comment_id ?? "";
    const c = await db.query.runComments.findFirst({ where: eq(runComments.id, commentId) });
    if (c === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(c.runId, user?.id, orgId ?? null, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(runComments).where(eq(runComments.id, commentId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Plan JSON Output ---
  .get("/api/v2/plans/:plan_id/json-output", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const planId = params.plan_id ?? "";
    const runId = planId.replace(/^plan-/, "");
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId ?? null, teamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const planJson = await readPlanJsonArtifact(runId);
    if (planJson === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "Plan JSON output is unavailable" }] };
    }
    return planJson;
  });
