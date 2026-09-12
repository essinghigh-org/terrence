import { Elysia } from "elysia";
import { and, asc, count, desc, eq, inArray, or } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import {
  auditLogs,
  configurationVersions,
  durableJobs,
  githubWebhookDeliveries,
  organizationMemberships,
  organizations,
  policySetWorkspaces,
  policySets,
  projects,
  runs,
  teamMemberships,
  teamWorkspaces,
  teams,
  variableSetWorkspaces,
  variableSets,
  workspaceVariables,
  workspaces,
} from "../db/schema";
import {
  apiError,
  auditLog,
  checkOrganizationPermission,
  checkWorkspacePermission,
  findAuthorizedRun,
  findAuthorizedWorkspace,
  notFound,
  pageRequest,
  pagination,
} from "../lib/utils";
import { getSettings } from "../lib/settings";
import { maintenanceSchedule } from "../lib/operations";
import {
  OPINIONATED_POLICY_PACKS,
  WORKSPACE_BLUEPRINTS,
  normalizedSearchText,
  redactedWebhookPayload,
  renderWorkspaceAdoptionHcl,
  stableConfigName,
  webhookRepository,
  type BlueprintDefinition,
  type PolicyPackDefinition,
} from "../lib/operations-catalog";
import { documentationMatches } from "./docs";
import { authorizedConfiguration } from "./notifications";
import {
  MAX_NOTIFICATION_SNOOZE_MS,
  notificationSnooze,
  setNotificationSnooze,
} from "../lib/notification-state";
import { retryFailedVcsWebhookDelivery } from "../lib/webhook-jobs";

type SetObject = Readonly<{ status?: number | string; headers?: Readonly<Record<string, string | number>> }>;
type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  request: Request;
  user?: Readonly<{ id: string; isSiteAdmin?: boolean | null }> | null;
  orgId?: string | null;
  teamId?: string | null;
  set: SetObject;
}>;

type SafeWorkspace = typeof workspaces.$inferSelect;

const MAX_CANDIDATES = 500;
const MAX_TIMELINE_EVENTS = 200;
const DEFAULT_SNOOZE_MS = 60 * 60 * 1_000;

function unauthorized(set: SetObject): ReturnType<typeof apiError> {
  return apiError(set, 401, "Unauthorized");
}

function hidden(set: SetObject): ReturnType<typeof notFound> {
  return notFound(set);
}

function hasPrincipal(user: ParamCtx["user"], orgId: string | null | undefined, teamId: string | null | undefined): boolean {
  return user !== null && user !== undefined || (orgId !== null && orgId !== undefined) || (teamId !== null && teamId !== undefined);
}

function attributesFrom(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const data = record["data"];
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>)["attributes"];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return record;
}

function queryValue(request: Request, name: string): string {
  return new URL(request.url).searchParams.get(name)?.trim() ?? "";
}

function safeIso(value: unknown): string | null {
  const date = typeof value === "number" ? new Date(value) : typeof value === "string" ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function resource(id: string, type: string, attributes: Readonly<Record<string, unknown>>, links?: Readonly<Record<string, string>>): Record<string, unknown> {
  return { id, type, attributes, ...(links === undefined ? {} : { links }) };
}

function parseLimit(value: string, fallback = 20): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

function blueprintResource(blueprint: BlueprintDefinition): Record<string, unknown> {
  return resource(blueprint.id, "workspace-blueprints", {
    version: blueprint.version,
    name: blueprint.name,
    description: blueprint.description,
    parameters: blueprint.parameters,
    "resulting-objects": blueprint.resultingObjects,
  }, { self: `/api/v2/workspace-blueprints/${encodeURIComponent(blueprint.id)}` });
}

function policyPackResource(pack: PolicyPackDefinition): Record<string, unknown> {
  return resource(pack.id, "policy-packs", {
    version: pack.version,
    name: pack.name,
    mode: pack.mode,
    description: pack.description,
    rules: pack.rules,
  }, { self: `/api/v2/policy-packs/${encodeURIComponent(pack.id)}` });
}

function webhookPayloadFromJob(job: Readonly<typeof durableJobs.$inferSelect>): Readonly<Record<string, unknown>> {
  const payload = job.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
}

function webhookResource(
  job: Readonly<typeof durableJobs.$inferSelect>,
  delivery: Readonly<typeof githubWebhookDeliveries.$inferSelect> | undefined,
  includePayload: boolean,
): Record<string, unknown> {
  const body = webhookPayloadFromJob(job);
  const provider = typeof body["provider"] === "string" ? body["provider"] : "unknown";
  const eventName = typeof body["eventName"] === "string" ? body["eventName"] : "unknown";
  const payload = body["payload"];
  const redacted = redactedWebhookPayload(payload);
  const deliveryId = typeof body["deliveryId"] === "string" ? body["deliveryId"] : null;
  return resource(job.id, "webhook-deliveries", {
    provider,
    "event-name": eventName,
    "delivery-id": deliveryId,
    status: delivery?.status ?? job.status,
    attempts: job.attempts,
    "run-after": safeIso(job.runAfter),
    "created-at": safeIso(job.createdAt),
    "updated-at": safeIso(job.updatedAt),
    "processed-at": delivery === undefined ? null : safeIso(delivery.processedAt),
    repository: webhookRepository(redacted),
    "signature-validation": "accepted-before-queue",
    "dedupe-key": job.dedupeKey,
    "last-error": job.lastError === null ? null : "Delivery failed; inspect the bounded retry state.",
    ...(includePayload ? { "redacted-payload": redacted } : {}),
  }, { self: `/api/v2/admin/webhook-deliveries/${encodeURIComponent(job.id)}` });
}

async function adminRequired(user: ParamCtx["user"], set: SetObject): Promise<true | ReturnType<typeof apiError>> {
  if (user === null || user === undefined) {
    return unauthorized(set);
  }
  if (user.isSiteAdmin !== true) {
    return hidden(set);
  }
  return true;
}

async function visibleWorkspaces(
  user: ParamCtx["user"],
  tokenOrgId: string | null | undefined,
  tokenTeamId: string | null | undefined,
): Promise<readonly SafeWorkspace[]> {
  const candidates = await db.query.workspaces.findMany({
    orderBy: [asc(workspaces.name), asc(workspaces.id)],
    limit: MAX_CANDIDATES,
  });
  const checks = await Promise.all(candidates.map(async (workspace): Promise<SafeWorkspace | null> =>
    await checkWorkspacePermission(workspace, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "read") ? workspace : null));
  return checks.filter((workspace): workspace is SafeWorkspace => workspace !== null);
}

function searchMatch(value: unknown, needle: string): boolean {
  return typeof value === "string" && value.toLocaleLowerCase().includes(needle);
}

function freshness(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : safeIso(value);
}

function matchWorkspaceResults(workspacesForUser: readonly SafeWorkspace[], needle: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const workspace of workspacesForUser) {
    const repository = workspace.vcsRepo?.identifier ?? null;
    const fields = [workspace.id, workspace.name, workspace.description, workspace.sourceName, repository];
    const reasons = fields.flatMap((field, index): string[] => searchMatch(field, needle) ? [["id", "name", "description", "source", "repository"][index] ?? "metadata"] : []);
    if (reasons.length > 0) {
      results.push(resource(workspace.id, "workspaces", {
        name: workspace.name,
        description: workspace.description,
        "match-reasons": reasons,
        freshness: freshness(workspace.updatedAt ?? workspace.createdAt),
      }, { self: `/api/v2/workspaces/${encodeURIComponent(workspace.id)}` }));
    }
  }
  return results;
}

function matchProjectResults(projectRows: readonly (typeof projects.$inferSelect)[], needle: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const project of projectRows) {
    const reasons = [project.id, project.name, project.description].flatMap((field, index): string[] => searchMatch(field, needle) ? [["id", "name", "description"][index] ?? "metadata"] : []);
    if (reasons.length > 0) results.push(resource(project.id, "projects", { name: project.name, description: project.description, "match-reasons": reasons, freshness: freshness(project.createdAt) }, { self: `/api/v2/projects/${encodeURIComponent(project.id)}` }));
  }
  return results;
}

function matchRunResults(
  runRows: readonly (typeof runs.$inferSelect)[],
  cvById: ReadonlyMap<string, typeof configurationVersions.$inferSelect>,
  workspaceById: ReadonlyMap<string, SafeWorkspace>,
  needle: string,
): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const run of runRows) {
    const cv = run.configurationVersionId === null ? undefined : cvById.get(run.configurationVersionId);
    const ingress = cv?.ingressAttributes;
    const values: readonly unknown[] = [run.id, run.message, run.status, ingress?.commitSha, ingress?.branch, ingress?.commitMessage];
    const reasons = values.flatMap((field, index): string[] => searchMatch(field, needle) ? [["id", "message", "status", "commit-sha", "branch", "commit-message"][index] ?? "metadata"] : []);
    if (reasons.length === 0) continue;
    const workspace = workspaceById.get(run.workspaceId);
    results.push(resource(run.id, "runs", {
      status: run.status,
      message: run.message,
      workspace: workspace?.name ?? null,
      "match-reasons": reasons,
      freshness: freshness(run.createdAt),
    }, { self: `/api/v2/runs/${encodeURIComponent(run.id)}` }));
  }
  return results;
}

function matchDocumentationResults(needle: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const match of documentationMatches(needle, 20)) {
    results.push(resource(match.slug, "runbooks", {
      title: match.title,
      category: match.category,
      description: match.description,
      "match-reasons": ["documentation"],
      freshness: match.version,
    }, { self: `/api/v2/docs/${encodeURIComponent(match.slug)}` }));
  }
  return results;
}

async function searchResources(ctx: ParamCtx): Promise<unknown> {
  const { request, user, orgId: tokenOrgId, teamId: tokenTeamId, set } = ctx;
  if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
  const needle = normalizedSearchText(queryValue(request, "q")).slice(0, 120);
  if (needle === "") return apiError(set, 422, "Unprocessable Entity", "q is required");
  const workspacesForUser = await visibleWorkspaces(user, tokenOrgId, tokenTeamId);
  const workspaceIds = workspacesForUser.map((workspace): string => workspace.id);
  const workspaceById = new Map(workspacesForUser.map((workspace): [string, SafeWorkspace] => [workspace.id, workspace]));
  const projectIds = [...new Set(workspacesForUser.flatMap((workspace): string[] => workspace.projectId === null ? [] : [workspace.projectId]))];
  const [projectRows, runRows, cvRows] = await Promise.all([
    projectIds.length === 0 ? Promise.resolve([] as (typeof projects.$inferSelect)[]) : db.query.projects.findMany({ where: inArray(projects.id, projectIds), limit: MAX_CANDIDATES }),
    workspaceIds.length === 0 ? Promise.resolve([] as (typeof runs.$inferSelect)[]) : db.query.runs.findMany({ where: inArray(runs.workspaceId, workspaceIds), orderBy: [desc(runs.createdAt)], limit: MAX_CANDIDATES }),
    workspaceIds.length === 0 ? Promise.resolve([] as (typeof configurationVersions.$inferSelect)[]) : db.query.configurationVersions.findMany({ where: inArray(configurationVersions.workspaceId, workspaceIds), orderBy: [desc(configurationVersions.createdAt)], limit: MAX_CANDIDATES }),
  ]);

  const cvById = new Map(cvRows.map((cv): [string, typeof cv] => [cv.id, cv]));
  const results: Record<string, unknown>[] = [
    ...matchWorkspaceResults(workspacesForUser, needle),
    ...matchProjectResults(projectRows, needle),
    ...matchRunResults(runRows, cvById, workspaceById, needle),
    ...matchDocumentationResults(needle),
  ];
  results.sort((a, b): number => `${String((a["type"] ?? ""))}:${String((a["id"] ?? ""))}`.localeCompare(`${String((b["type"] ?? ""))}:${String((b["id"] ?? ""))}`));
  const { number, size } = pageRequest(request);
  return { data: results.slice((number - 1) * size, number * size), ...pagination(request, number, size, results.length) };
}

function timelineEvent(
  id: string,
  type: string,
  occurredAt: string,
  attributes: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return resource(id, "operational-events", { type, "occurred-at": occurredAt, authoritative: true, uncertainty: "persisted", ...attributes });
}

function runStatusEvents(
  statusTimestamps: typeof runs.$inferSelect["statusTimestamps"],
  runId: string,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const [status, timestamp] of Object.entries(statusTimestamps ?? {})) {
    const occurredAt = safeIso(timestamp);
    if (occurredAt !== null) events.push(timelineEvent(`run:${runId}:${status}`, "run-status", occurredAt, { status: status.replace(/-at$/, "") }));
  }
  return events;
}

function configurationIngressEvents(
  configurationVersion: typeof configurationVersions.$inferSelect | undefined,
): Record<string, unknown>[] {
  const ingress = configurationVersion?.ingressAttributes ?? undefined;
  const commitAt = safeIso(configurationVersion?.createdAt);
  if (commitAt === null || ingress === undefined || (ingress.commitSha === undefined && ingress.branch === undefined)) return [];
  return [timelineEvent(`configuration:${configurationVersion?.id ?? "unknown"}:ingress`, "configuration-ingress", commitAt, { "commit-sha": ingress.commitSha ?? null, branch: ingress.branch ?? null })];
}

function configurationStatusEvents(
  configurationVersion: typeof configurationVersions.$inferSelect | undefined,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const [status, timestamp] of Object.entries(configurationVersion?.statusTimestamps ?? {})) {
    const occurredAt = safeIso(timestamp);
    if (occurredAt !== null) events.push(timelineEvent(`configuration:${configurationVersion?.id ?? "unknown"}:${status}`, "configuration-status", occurredAt, { status: status.replace(/-at$/, ""), "configuration-version-id": configurationVersion?.id ?? null }));
  }
  return [...events, ...configurationIngressEvents(configurationVersion)];
}

function auditTimelineEvents(auditRows: readonly (typeof auditLogs.$inferSelect)[]): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const audit of auditRows) {
    const occurredAt = safeIso(audit.createdAt);
    if (occurredAt !== null) events.push(timelineEvent(`audit:${audit.id}`, "audit", occurredAt, { action: audit.action, "resource-type": audit.resourceType, "actor-id": audit.userId }));
  }
  return events;
}

function byOccurredAt(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const aAttributes = a["attributes"];
  const bAttributes = b["attributes"];
  const aTime = aAttributes !== null && typeof aAttributes === "object" ? (aAttributes as Record<string, unknown>)["occurred-at"] : "";
  const bTime = bAttributes !== null && typeof bAttributes === "object" ? (bAttributes as Record<string, unknown>)["occurred-at"] : "";
  return String(aTime ?? "").localeCompare(String(bTime ?? ""));
}

async function runTimeline({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, request, set }: ParamCtx): Promise<unknown> {
  if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
  const runId = params["run_id"] ?? "";
  const authorized = await findAuthorizedRun(runId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "run-read");
  if (authorized === undefined) return hidden(set);
  const [configurationVersion, auditRows] = await Promise.all([
    authorized.run.configurationVersionId === null ? Promise.resolve(undefined) : db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, authorized.run.configurationVersionId) }),
    db.query.auditLogs.findMany({
      where: and(or(eq(auditLogs.resourceType, "run"), eq(auditLogs.resourceType, "runs")), eq(auditLogs.resourceId, runId)),
      orderBy: [asc(auditLogs.createdAt), asc(auditLogs.id)],
      limit: MAX_TIMELINE_EVENTS,
    }),
  ]);
  const events: Record<string, unknown>[] = [
    ...runStatusEvents(authorized.run.statusTimestamps, runId),
    ...configurationStatusEvents(configurationVersion),
    ...auditTimelineEvents(auditRows),
  ];
  events.sort(byOccurredAt);
  const { number, size } = pageRequest(request);
  const page = events.slice((number - 1) * size, number * size);
  const pageInfo = pagination(request, number, size, events.length);
  return { data: page, ...pageInfo, meta: { ...pageInfo.meta, run: { id: runId, status: authorized.run.status, workspace: authorized.workspace.name }, "event-count": events.length } };
}

function missingBlueprintParameters(blueprint: BlueprintDefinition, parameters: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const parameter of blueprint.parameters) {
    const value = parameters[parameter.name];
    if (parameter.required && (value === undefined || value === null || (typeof value === "string" && value.trim() === ""))) errors.push(`Missing required parameter: ${parameter.name}`);
  }
  return errors;
}

function resolveBlueprintReferenceIds(parameters: Record<string, unknown>, errors: string[]): Record<string, unknown> {
  const referenceIds: Record<string, unknown> = {};
  for (const key of ["variable-set-ids", "policy-set-ids"] as const) {
    const value = parameters[key];
    if (value !== undefined) {
      if (!Array.isArray(value) || value.some((item): boolean => typeof item !== "string" || item.trim() === "")) errors.push(`${key} must be an array of IDs`);
      else referenceIds[key] = [...new Set(value.map((item): string => item.trim()))];
    }
  }
  return referenceIds;
}

function trimmedParameter(parameters: Record<string, unknown>, key: string): string | null {
  return typeof parameters[key] === "string" ? (parameters[key]).trim() : null;
}

function blueprintPreview(blueprint: BlueprintDefinition, attributes: Readonly<Record<string, unknown>>): Readonly<{ valid: boolean; errors: readonly string[]; configuration: Record<string, unknown> }> {
  const parameters = attributes["parameters"] !== null && typeof attributes["parameters"] === "object" && !Array.isArray(attributes["parameters"])
    ? attributes["parameters"] as Record<string, unknown>
    : attributes as Record<string, unknown>;
  const errors = missingBlueprintParameters(blueprint, parameters);
  const referenceIds = resolveBlueprintReferenceIds(parameters, errors);
  const configuration: Record<string, unknown> = {
    name: trimmedParameter(parameters, "name"),
    project: trimmedParameter(parameters, "project"),
    repository: trimmedParameter(parameters, "repository"),
    branch: trimmedParameter(parameters, "branch"),
    enforcement: trimmedParameter(parameters, "enforcement"),
    "assessment-interval": trimmedParameter(parameters, "assessment-interval"),
    ...referenceIds,
    "blueprint-id": blueprint.id,
    "blueprint-version": blueprint.version,
    "permissions-required": ["workspace:read", "workspace:write", "varset:read", "policy:read"],
  };
  return { valid: errors.length === 0, errors, configuration };
}

async function workspaceAdoptionExport(workspace: SafeWorkspace): Promise<Readonly<{ organizationName: string; workspace: Readonly<{ id: string; name: string; projectName: string | null; executionMode: string; terraformVersion: string | null; repository: string | null }>; variableSets: readonly Readonly<{ id: string; name: string }>[]; policySets: readonly Readonly<{ id: string; name: string }>[] }>> {
  const [organization, project, variableLinks, policyLinks] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId), columns: { name: true } }),
    workspace.projectId === null ? Promise.resolve(undefined) : db.query.projects.findFirst({ where: eq(projects.id, workspace.projectId), columns: { name: true } }),
    db.query.variableSetWorkspaces.findMany({ where: eq(variableSetWorkspaces.workspaceId, workspace.id), columns: { variableSetId: true } }),
    db.query.policySetWorkspaces.findMany({ where: eq(policySetWorkspaces.workspaceId, workspace.id), columns: { policySetId: true } }),
  ]);
  const [variableSetRows, policySetRows] = await Promise.all([
    variableLinks.length === 0 ? Promise.resolve([] as (typeof variableSets.$inferSelect)[]) : db.query.variableSets.findMany({ where: inArray(variableSets.id, variableLinks.map((link): string => link.variableSetId)), columns: { id: true, name: true } }),
    policyLinks.length === 0 ? Promise.resolve([] as (typeof policySets.$inferSelect)[]) : db.query.policySets.findMany({ where: inArray(policySets.id, policyLinks.map((link): string => link.policySetId)), columns: { id: true, name: true } }),
  ]);
  return {
    organizationName: organization?.name ?? workspace.orgId,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      projectName: project?.name ?? null,
      executionMode: workspace.executionMode,
      terraformVersion: workspace.terraformVersion ?? null,
      repository: workspace.vcsRepo?.identifier ?? null,
    },
    variableSets: variableSetRows.map((row): { id: string; name: string } => ({ id: row.id, name: row.name })),
    policySets: policySetRows.map((row): { id: string; name: string } => ({ id: row.id, name: row.name })),
  };
}

async function accessReviewForWorkspace(
  workspace: SafeWorkspace,
  subjectId: string | null,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
): Promise<Record<string, unknown>> {
  const permissions = ["read", "run-read", "plan", "apply", "cancel", "discard", "lock", "admin", "variables-read", "variables-write", "state-read", "state-write"] as const;
  const permissionValues = Object.fromEntries(await Promise.all(permissions.map(async (permission): Promise<[string, boolean]> => [permission, subjectId === null ? false : await checkWorkspacePermission(workspace, subjectId, tokenOrgId, tokenTeamId, permission)])));
  const [membership, teamMembershipRows] = subjectId === null
    ? [undefined, [] as (typeof teamMemberships.$inferSelect)[]]
    : await Promise.all([
      db.query.organizationMemberships.findFirst({ where: and(eq(organizationMemberships.orgId, workspace.orgId), eq(organizationMemberships.userId, subjectId)) }),
      db.query.teamMemberships.findMany({ where: eq(teamMemberships.userId, subjectId) }),
    ]);
  const teamIds = teamMembershipRows.map((row): string => row.teamId);
  const [teamRows, workspaceGrants] = await Promise.all([
    teamIds.length === 0 ? Promise.resolve([] as (typeof teams.$inferSelect)[]) : db.query.teams.findMany({ where: and(eq(teams.orgId, workspace.orgId), inArray(teams.id, teamIds)) }),
    teamIds.length === 0 ? Promise.resolve([] as (typeof teamWorkspaces.$inferSelect)[]) : db.query.teamWorkspaces.findMany({ where: and(eq(teamWorkspaces.workspaceId, workspace.id), inArray(teamWorkspaces.teamId, teamIds)) }),
  ]);
  return {
    workspace: { id: workspace.id, name: workspace.name },
    subject: subjectId === null ? null : { id: subjectId },
    permissions: permissionValues,
    grants: [
      ...(membership === undefined ? [] : [{ source: "organization-membership", id: membership.id, role: membership.role, status: membership.status }]),
      ...teamRows.map((team): Record<string, unknown> => ({ source: "team", id: team.id, name: team.name, "organization-access": Object.keys(team.organizationAccess).filter((key): boolean => team.organizationAccess[key] === true) })),
      ...workspaceGrants.map((grant): Record<string, unknown> => ({ source: "team-workspace", id: grant.id, "team-id": grant.teamId, access: grant.access, permissions: grant.permissions ?? {} })),
    ],
    "credential-types": ["interactive-session-or-token"],
    "pre-issued-capability-note": "Fresh authorization is checked on every request; existing signed capabilities expire according to their endpoint TTL.",
  };
}

async function notificationOrgId(configuration: Readonly<{ workspaceId: string | null; projectId: string | null; teamId: string | null }>): Promise<string | null> {
  if (configuration.workspaceId !== null) return (await db.query.workspaces.findFirst({ where: eq(workspaces.id, configuration.workspaceId), columns: { orgId: true } }))?.orgId ?? null;
  if (configuration.projectId !== null) return (await db.query.projects.findFirst({ where: eq(projects.id, configuration.projectId), columns: { orgId: true } }))?.orgId ?? null;
  if (configuration.teamId !== null) return (await db.query.teams.findFirst({ where: eq(teams.id, configuration.teamId), columns: { orgId: true } }))?.orgId ?? null;
  return null;
}

function durationFromBody(body: unknown): number {
  const attributes = attributesFrom(body);
  const rawMs = attributes["duration-ms"] ?? attributes["durationMs"];
  const rawSeconds = attributes["duration-seconds"] ?? attributes["durationSeconds"];
  const rawUntil = attributes["until"];
  if (typeof rawMs === "number" && Number.isFinite(rawMs)) return rawMs;
  if (typeof rawMs === "string" && rawMs.trim() !== "" && Number.isFinite(Number(rawMs))) return Number(rawMs);
  if (typeof rawSeconds === "number" && Number.isFinite(rawSeconds)) return rawSeconds * 1_000;
  if (typeof rawSeconds === "string" && rawSeconds.trim() !== "" && Number.isFinite(Number(rawSeconds))) return Number(rawSeconds) * 1_000;
  if (typeof rawUntil === "string") {
    const until = Date.parse(rawUntil);
    if (Number.isFinite(until)) return until - Date.now();
  }
  return DEFAULT_SNOOZE_MS;
}

async function applySnoozeDuration(
  id: string,
  configuration: Parameters<typeof notificationOrgId>[0],
  body: unknown,
  user: ParamCtx["user"],
  set: SetObject,
): Promise<{ ok: true } | { failure: unknown }> {
  const duration = durationFromBody(body);
  if (!Number.isFinite(duration)) return { failure: apiError(set, 422, "Unprocessable Entity", "duration must be finite") };
  const next = duration <= 0 ? null : await setNotificationSnooze(id, Math.min(duration, MAX_NOTIFICATION_SNOOZE_MS));
  const orgId = await notificationOrgId(configuration);
  const reason = attributesFrom(body)["reason"];
  await auditLog(duration <= 0 ? "unsnooze" : "snooze", "notification-configurations", id, user?.id ?? null, orgId, {
    durationMs: duration <= 0 ? 0 : Math.min(duration, MAX_NOTIFICATION_SNOOZE_MS),
    reason: typeof reason === "string" ? reason : null,
    expiresAt: next?.until ?? null,
  });
  return { ok: true };
}

async function notificationSnoozeResponse(
  id: string,
  user: ParamCtx["user"],
  tokenOrgId: string | null | undefined,
  tokenTeamId: string | null | undefined,
  set: SetObject,
  mode: "read" | "manage",
  body?: unknown,
): Promise<unknown> {
  if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
  const configuration = await authorizedConfiguration(id, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, mode);
  if (configuration === undefined) return hidden(set);
  const before = await notificationSnooze(id);
  if (body !== undefined) {
    const applied = await applySnoozeDuration(id, configuration, body, user, set);
    if ("failure" in applied) return applied.failure;
  }
  const current = body === undefined ? before : await notificationSnooze(id);
  return { data: resource(id, "notification-snoozes", { active: current !== null, until: current === null ? null : safeIso(current.until), reason: current?.reason ?? null, "max-duration-ms": MAX_NOTIFICATION_SNOOZE_MS }) };
}

function affectedReviewGrants(
  grants: readonly Record<string, unknown>[],
  removeMembershipId: string | null,
  removeTeamId: string | null,
): Record<string, unknown>[] {
  return grants.filter((grant): boolean =>
    removeMembershipId !== null && grant["source"] === "organization-membership" && grant["id"] === removeMembershipId
    || removeTeamId !== null && (grant["source"] === "team" && grant["id"] === removeTeamId || grant["source"] === "team-workspace" && grant["team-id"] === removeTeamId));
}

function reviewRemovalPreview(
  current: Record<string, unknown>,
  removeMembershipId: string | null,
  removeTeamId: string | null,
): { currentPermissions: Record<string, boolean>; afterPermissions: Record<string, boolean>; affected: Record<string, unknown>[] } {
  const grants = Array.isArray(current["grants"]) ? current["grants"] as readonly Record<string, unknown>[] : [];
  const affected = affectedReviewGrants(grants, removeMembershipId, removeTeamId);
  const currentPermissions = current["permissions"] as Record<string, boolean>;
  const afterPermissions = { ...currentPermissions };
  if (affected.length > 0) for (const permission of Object.keys(afterPermissions)) afterPermissions[permission] = false;
  return { currentPermissions, afterPermissions, affected };
}

export const operationsIntelligenceRoutes = new Elysia({ name: "operations-intelligence" })
  .use(authPlugin)
  // --- Webhook delivery console ------------------------------------------
  .get("/api/v2/admin/webhook-deliveries", async (ctx: ParamCtx): Promise<unknown> => {
    const authorization = await adminRequired(ctx.user, ctx.set);
    if (authorization !== true) return authorization;
    const { number, size } = pageRequest(ctx.request);
    const where = eq(durableJobs.kind, "vcs-webhook");
    const [jobs, totals] = await Promise.all([
      db.query.durableJobs.findMany({ where, orderBy: [desc(durableJobs.updatedAt), desc(durableJobs.id)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(durableJobs).where(where),
    ]);
    const deliveryIds = jobs.map((job): string | null => {
      const value = webhookPayloadFromJob(job)["deliveryId"];
      return typeof value === "string" ? value : null;
    }).filter((id): id is string => id !== null);
    const deliveries = deliveryIds.length === 0 ? [] : await db.query.githubWebhookDeliveries.findMany({ where: inArray(githubWebhookDeliveries.id, deliveryIds) });
    const byId = new Map(deliveries.map((delivery): [string, typeof delivery] => [delivery.id, delivery]));
    return { data: jobs.map((job): Record<string, unknown> => {
      const id = webhookPayloadFromJob(job)["deliveryId"];
      return webhookResource(job, typeof id === "string" ? byId.get(id) : undefined, false);
    }), ...pagination(ctx.request, number, size, totals[0]?.total ?? 0) };
  })
  .get("/api/v2/admin/webhook-deliveries/:delivery_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const authorization = await adminRequired(user, set);
    if (authorization !== true) return authorization;
    const id = params["delivery_id"] ?? "";
    const job = await db.query.durableJobs.findFirst({ where: and(eq(durableJobs.kind, "vcs-webhook"), or(eq(durableJobs.id, id), eq(durableJobs.dedupeKey, id))) });
    if (job === undefined) return hidden(set);
    const body = webhookPayloadFromJob(job);
    const deliveryId = typeof body["deliveryId"] === "string" ? body["deliveryId"] : null;
    const delivery = deliveryId === null ? undefined : await db.query.githubWebhookDeliveries.findFirst({ where: eq(githubWebhookDeliveries.id, deliveryId) });
    return { data: webhookResource(job, delivery, true) };
  })
  .post("/api/v2/admin/webhook-deliveries/:delivery_id/actions/replay", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const authorization = await adminRequired(user, set);
    if (authorization !== true) return authorization;
    const requestedId = params["delivery_id"] ?? "";
    const job = await db.query.durableJobs.findFirst({ where: and(eq(durableJobs.kind, "vcs-webhook"), or(eq(durableJobs.id, requestedId), eq(durableJobs.dedupeKey, requestedId))) });
    if (job === undefined) return hidden(set);
    const body = webhookPayloadFromJob(job);
    const deliveryId = typeof body["deliveryId"] === "string" ? body["deliveryId"] : null;
    if (deliveryId === null) return apiError(set, 409, "Conflict", "This delivery has no durable provider identity and cannot be replayed safely");
    const retried = await retryFailedVcsWebhookDelivery(deliveryId);
    if (!retried) return apiError(set, 409, "Conflict", "Only failed deliveries can be replayed; the original identity remains idempotent");
    await auditLog("retry", "webhook-deliveries", deliveryId, user?.id ?? null, null, { jobId: job.id, replay: "same-logical-event" });
    const updated = await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, job.id) });
    if (updated === undefined) return hidden(set);
    const delivery = await db.query.githubWebhookDeliveries.findFirst({ where: eq(githubWebhookDeliveries.id, deliveryId) });
    return { data: webhookResource(updated, delivery, false) };
  })
  // Alias uses the word retry for clients that already consume the durable
  // queue terminology; both paths have the exact same guarded behavior.
  .post("/api/v2/admin/webhook-deliveries/:delivery_id/actions/retry", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const authorization = await adminRequired(user, set);
    if (authorization !== true) return authorization;
    const requestedId = params["delivery_id"] ?? "";
    const job = await db.query.durableJobs.findFirst({ where: and(eq(durableJobs.kind, "vcs-webhook"), or(eq(durableJobs.id, requestedId), eq(durableJobs.dedupeKey, requestedId))) });
    if (job === undefined) return hidden(set);
    const body = webhookPayloadFromJob(job);
    const deliveryId = typeof body["deliveryId"] === "string" ? body["deliveryId"] : null;
    if (deliveryId === null || !(await retryFailedVcsWebhookDelivery(deliveryId))) return apiError(set, 409, "Conflict", "Only failed deliveries can be retried");
    await auditLog("retry", "webhook-deliveries", deliveryId, user?.id ?? null, null, { jobId: job.id, replay: "same-logical-event" });
    const updated = await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, job.id) });
    if (updated === undefined) return hidden(set);
    const delivery = await db.query.githubWebhookDeliveries.findFirst({ where: eq(githubWebhookDeliveries.id, deliveryId) });
    return { data: webhookResource(updated, delivery, false) };
  })
  // --- Unified, authorization-filtered search ----------------------------
  .get("/api/v2/search", searchResources)
  .get("/api/v2/operations/search", searchResources)
  // --- Correlated run timeline -------------------------------------------
  .get("/api/v2/runs/:run_id/timeline", runTimeline)
  // --- Blueprint catalog and preview -------------------------------------
  .get("/api/v2/workspace-blueprints", async ({ user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    return { data: WORKSPACE_BLUEPRINTS.map(blueprintResource) };
  })
  .get("/api/v2/workspace-blueprints/:blueprint_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const blueprint = WORKSPACE_BLUEPRINTS.find((item): boolean => item.id === (params["blueprint_id"] ?? ""));
    return blueprint === undefined ? hidden(set) : { data: blueprintResource(blueprint) };
  })
  .post("/api/v2/workspace-blueprints/:blueprint_id/actions/preview", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const blueprint = WORKSPACE_BLUEPRINTS.find((item): boolean => item.id === (params["blueprint_id"] ?? ""));
    if (blueprint === undefined) return hidden(set);
    const attributes = attributesFrom(body);
    const workspaceId = typeof attributes["workspace-id"] === "string" ? attributes["workspace-id"] : typeof attributes["workspaceId"] === "string" ? attributes["workspaceId"] : null;
    if (workspaceId !== null && await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "admin") === undefined) return hidden(set);
    const preview = blueprintPreview(blueprint, attributes);
    return { data: resource(blueprint.id, "workspace-blueprint-previews", { ...preview, "will-mutate": false, "secret-values-included": false }) };
  })
  // --- Configuration adoption export ------------------------------------
  .get("/api/v2/workspaces/:workspace_id/adoption-export", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, request, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const workspace = await findAuthorizedWorkspace(params["workspace_id"] ?? "", user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "read");
    if (workspace === undefined) return hidden(set);
    const input = await workspaceAdoptionExport(workspace);
    const content = renderWorkspaceAdoptionHcl(input);
    await auditLog("export", "workspace-configuration", workspace.id, user?.id ?? null, workspace.orgId, { format: "hcl", secretValues: false });
    return { data: resource(workspace.id, "configuration-exports", { format: "hcl", content, "generated-at": new Date().toISOString(), "stable-resource-name": stableConfigName(workspace.name), "secret-values-included": false }, { self: request.url }) };
  })
  // --- Effective access review ------------------------------------------
  .get("/api/v2/workspaces/:workspace_id/access-review", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const workspace = await findAuthorizedWorkspace(params["workspace_id"] ?? "", user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "read");
    if (workspace === undefined) return hidden(set);
    return { data: resource(workspace.id, "workspace-access-reviews", await accessReviewForWorkspace(workspace, user?.id ?? null, tokenOrgId ?? null, tokenTeamId ?? null)) };
  })
  .post("/api/v2/workspaces/:workspace_id/access-review/preview", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const workspace = await findAuthorizedWorkspace(params["workspace_id"] ?? "", user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "admin");
    if (workspace === undefined) return hidden(set);
    const attributes = attributesFrom(body);
    const targetUserId = typeof attributes["user-id"] === "string" ? attributes["user-id"] : user?.id ?? null;
    const current = await accessReviewForWorkspace(workspace, targetUserId, null, null);
    const removeMembershipId = typeof attributes["remove-membership-id"] === "string" ? attributes["remove-membership-id"] : null;
    const removeTeamId = typeof attributes["remove-team-id"] === "string" ? attributes["remove-team-id"] : null;
    const preview = reviewRemovalPreview(current, removeMembershipId, removeTeamId);
    await auditLog("access-review", "workspaces", workspace.id, user?.id ?? null, workspace.orgId, { targetUserId, removeMembershipId, removeTeamId, affectedGrantCount: preview.affected.length });
    return { data: resource(workspace.id, "workspace-access-review-previews", { target: targetUserId, "current-permissions": preview.currentPermissions, "after-removal-permissions": preview.afterPermissions, "affected-grants": preview.affected, "automatic-revocation": false, "fresh-capabilities-rechecked": true, "pre-issued-capability-note": current["pre-issued-capability-note"] }) };
  })
  // --- Opinionated policy packs -----------------------------------------
  .get("/api/v2/policy-packs", async ({ user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    return { data: OPINIONATED_POLICY_PACKS.map(policyPackResource) };
  })
  .get("/api/v2/policy-packs/:pack_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const pack = OPINIONATED_POLICY_PACKS.find((item): boolean => item.id === (params["pack_id"] ?? ""));
    return pack === undefined ? hidden(set) : { data: policyPackResource(pack) };
  })
  .post("/api/v2/policy-packs/:pack_id/actions/preview", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const pack = OPINIONATED_POLICY_PACKS.find((item): boolean => item.id === (params["pack_id"] ?? ""));
    if (pack === undefined) return hidden(set);
    const attributes = attributesFrom(body);
    const workspaceId = typeof attributes["workspace-id"] === "string" ? attributes["workspace-id"] : null;
    const runId = typeof attributes["run-id"] === "string" ? attributes["run-id"] : null;
    if (runId !== null) {
      if (await findAuthorizedRun(runId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "run-read") === undefined) return hidden(set);
    } else if (workspaceId !== null && await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "read") === undefined) return hidden(set);
    return { data: resource(pack.id, "policy-pack-previews", { pack: policyPackResource(pack), mode: "advisory", scope: { workspaceId, runId }, outcomes: pack.rules.map((rule): Record<string, unknown> => ({ rule: rule.id, result: "unknown", explanation: "A plan artifact is required for a deterministic evaluation." })), "will-enforce": false }) };
  })
  // --- Contextual runbooks ----------------------------------------------
  .get("/api/v2/runbooks", async ({ request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const workspaceId = queryValue(request, "workspace-id");
    const runId = queryValue(request, "run-id");
    if (runId !== "" && await findAuthorizedRun(runId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "run-read") === undefined) return hidden(set);
    if (runId === "" && workspaceId !== "" && await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "read") === undefined) return hidden(set);
    const query = queryValue(request, "q") || "troubleshooting";
    const limit = parseLimit(queryValue(request, "limit"), 8);
    const matches = documentationMatches(query, limit).map((match): Record<string, unknown> => resource(match.slug, "runbooks", { title: match.title, category: match.category, description: match.description, tags: [match.category.toLocaleLowerCase(), "reference"], status: "reference", "matched-on": query, version: match.version, "stale-after": null }, { self: `/api/v2/docs/${encodeURIComponent(match.slug)}` }));
    return { data: matches };
  })
  .get("/api/v2/runs/:run_id/runbooks", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, request, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const runId = params["run_id"] ?? "";
    if (await findAuthorizedRun(runId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "run-read") === undefined) return hidden(set);
    const query = queryValue(request, "q") || "troubleshooting";
    return { data: documentationMatches(query, parseLimit(queryValue(request, "limit"), 8)).map((match): Record<string, unknown> => resource(match.slug, "runbooks", { title: match.title, category: match.category, description: match.description, tags: [match.category.toLocaleLowerCase(), "reference"], status: "reference", "matched-on": query, version: match.version, "stale-after": null }, { self: `/api/v2/docs/${encodeURIComponent(match.slug)}` })) };
  })
  // --- Maintenance preview ----------------------------------------------
  .get("/api/v2/admin/maintenance-windows/preview", async ({ user, set }: ParamCtx): Promise<unknown> => {
    const authorization = await adminRequired(user, set);
    if (authorization !== true) return authorization;
    const settings = await getSettings("maintenance-windows");
    const schedule = maintenanceSchedule(settings);
    const windows = Array.isArray(settings["windows"]) ? settings["windows"].map((window): unknown => {
      if (window === null || typeof window !== "object" || Array.isArray(window)) return {};
      const value = window as Record<string, unknown>;
      return { days: Array.isArray(value["days"]) ? value["days"].filter((day): boolean => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6) : [], "start-time": value["start-time"], "end-time": value["end-time"], timezone: value["timezone"] };
    }) : [];
    return { data: resource("maintenance-windows", "maintenance-schedules", { enabled: settings["enabled"] === true, policy: "applies-only", ...schedule, windows }) };
  })
  // --- Notification snooze ----------------------------------------------
  .get("/api/v2/notification-configurations/:nc_id/snooze", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => notificationSnoozeResponse(params["nc_id"] ?? "", user, tokenOrgId, tokenTeamId, set, "read"))
  .get("/api/v2/notification-configurations/:nc_id/actions/snooze", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => notificationSnoozeResponse(params["nc_id"] ?? "", user, tokenOrgId, tokenTeamId, set, "read"))
  .post("/api/v2/notification-configurations/:nc_id/snooze", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => notificationSnoozeResponse(params["nc_id"] ?? "", user, tokenOrgId, tokenTeamId, set, "manage", body))
  .post("/api/v2/notification-configurations/:nc_id/actions/snooze", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => notificationSnoozeResponse(params["nc_id"] ?? "", user, tokenOrgId, tokenTeamId, set, "manage", body))
  .delete("/api/v2/notification-configurations/:nc_id/snooze", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => notificationSnoozeResponse(params["nc_id"] ?? "", user, tokenOrgId, tokenTeamId, set, "manage", { "duration-ms": 0 }))
  .delete("/api/v2/notification-configurations/:nc_id/actions/snooze", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => notificationSnoozeResponse(params["nc_id"] ?? "", user, tokenOrgId, tokenTeamId, set, "manage", { "duration-ms": 0 }))
  // --- Secret/variable impact metadata ----------------------------------
  .get("/api/v2/variable-sets/:variable_set_id/impact", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, request, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const variableSetId = params["variable_set_id"] ?? "";
    const variableSet = await db.query.variableSets.findFirst({ where: eq(variableSets.id, variableSetId) });
    if (variableSet === undefined || !(await checkOrganizationPermission(variableSet.orgId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "read-varsets"))) return hidden(set);
    const links = await db.query.variableSetWorkspaces.findMany({ where: eq(variableSetWorkspaces.variableSetId, variableSetId), limit: MAX_CANDIDATES });
    const consumers: Record<string, unknown>[] = [];
    for (const link of links) {
      const workspace = await findAuthorizedWorkspace(link.workspaceId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "read");
      if (workspace === undefined) continue;
      const planned = await db.query.runs.findMany({ where: and(eq(runs.workspaceId, workspace.id), inArray(runs.status, ["pending", "planning", "planned", "planned_and_saved", "apply_queued", "confirmed"])), orderBy: [desc(runs.createdAt)], limit: 20, columns: { id: true, status: true, createdAt: true } });
      consumers.push({ workspace: { id: workspace.id, name: workspace.name }, "last-observed-use": planned[0] === undefined ? null : safeIso(planned[0].createdAt), "planned-runs": planned.map((run): Record<string, unknown> => ({ id: run.id, status: run.status, createdAt: safeIso(run.createdAt), "input-policy": "run input remains bound to its captured version" })) });
    }
    return { data: resource(variableSet.id, "variable-set-impact-reports", { name: variableSet.name, consumers, "value-matching-used": false, "source-version-tracked": false, "future-runs-only": true, "external-credential-revocation-claimed": false, "controlled-overlap-supported": false }, { self: request.url }) };
  })
  .get("/api/v2/workspaces/:workspace_id/secret-impact", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, request, set }: ParamCtx): Promise<unknown> => {
    if (!hasPrincipal(user, tokenOrgId, tokenTeamId)) return unauthorized(set);
    const workspace = await findAuthorizedWorkspace(params["workspace_id"] ?? "", user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "variables-read");
    if (workspace === undefined) return hidden(set);
    const variables = await db.query.workspaceVariables.findMany({ where: eq(workspaceVariables.workspaceId, workspace.id), columns: { id: true, key: true, sensitive: true, description: true, category: true } });
    const runsForWorkspace = await db.query.runs.findMany({ where: and(eq(runs.workspaceId, workspace.id), inArray(runs.status, ["pending", "planning", "planned", "planned_and_saved", "apply_queued", "confirmed"])), orderBy: [desc(runs.createdAt)], limit: 20, columns: { id: true, status: true, createdAt: true } });
    return { data: resource(workspace.id, "workspace-secret-impact-reports", { workspace: { id: workspace.id, name: workspace.name }, sources: variables.filter((variable): boolean => variable.sensitive === true).map((variable): Record<string, unknown> => ({ id: variable.id, key: variable.key, category: variable.category, description: variable.description })), "planned-runs": runsForWorkspace.map((run): Record<string, unknown> => ({ id: run.id, status: run.status, createdAt: safeIso(run.createdAt), "input-policy": "captured input is not rewritten by source changes" })), "value-matching-used": false, "external-revocation-claimed": false }, { self: request.url }) };
  });
