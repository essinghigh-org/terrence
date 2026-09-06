import { Elysia } from "elysia";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import {
  assessmentCheckResults,
  assessmentResults,
  configurationVersions,
  durableJobs,
  organizations,
  runs,
  stateVersions,
  type users,
  workspaces,
} from "../db/schema";
import { cachedOrgByName } from "../lib/cached-lookups";
import {
  artifactPayload,
  artifactResource,
  createPlatformArtifact,
  getPlatformArtifact,
  listPlatformArtifacts,
  platformArtifactDigest,
  updatePlatformArtifact,
  type PlatformArtifact,
} from "../lib/platform-artifacts";
import {
  comparePlanJson,
  compareStateVersions,
  dependencyImpact,
  driftFingerprint,
  importConfiguration,
  inputDigest,
  policyPlaygroundResult,
  stateInventoryObservations,
  upgradeRehearsalResult,
  validateImportMappings,
  type InventoryObservation,
  type StateVersionComparisonInput,
} from "../lib/platform-comparison";
import { readPlanJsonArtifact } from "../lib/plan-json";
import { newResourceId } from "../lib/resource-id";
import { parseTerraformStatePayload } from "../lib/validation";
import { checkOrganizationPermission, findAuthorizedRun, findAuthorizedWorkspace, notFound } from "../lib/utils";

type ParamContext = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  teamId?: string | null;
  request: Request;
  set: { status?: number | string; headers: Record<string, string | number> };
}>;

type WorkspaceRow = typeof workspaces.$inferSelect;

function attributesFrom(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object") return {};
  const root = body as Record<string, unknown>;
  const data = root["data"];
  if (data !== null && typeof data === "object") {
    const attrs = (data as Record<string, unknown>)["attributes"];
    if (attrs !== null && typeof attrs === "object") return attrs as Record<string, unknown>;
  }
  const attrs = root["attributes"];
  return attrs !== null && typeof attrs === "object" ? attrs as Record<string, unknown> : root;
}

function stringAttribute(attrs: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof attrs[key] === "string" && attrs[key].trim() !== "") return (attrs[key] as string).trim();
  }
  return null;
}

function stringArrayAttribute(attrs: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    if (Array.isArray(attrs[key])) return attrs[key].filter((value): value is string => typeof value === "string" && value.trim() !== "");
  }
  return [];
}

function errorDocument(set: ParamContext["set"], status: number, detail: string, title = "Unprocessable Entity"): Record<string, unknown> {
  set.status = status;
  return { errors: [{ status: String(status), title, detail }] };
}

function resourceList(rows: readonly PlatformArtifact[], type: string): Record<string, unknown> {
  return { data: rows.map((row): Record<string, unknown> => artifactResource(row, type)) };
}

async function workspaceByPermission(
  workspaceId: string,
  context: ParamContext,
  permission: "read" | "plan" | "run-read" | "run-tasks" | "admin" | "state-read",
): Promise<WorkspaceRow | undefined> {
  return findAuthorizedWorkspace(workspaceId, context.user?.id, context.orgId ?? null, context.teamId ?? null, permission);
}

async function organizationForName(name: string): Promise<typeof organizations.$inferSelect | undefined> {
  return cachedOrgByName(name);
}

function comparisonStateInput(state: typeof stateVersions.$inferSelect): StateVersionComparisonInput {
  return {
    id: state.id,
    workspaceId: state.workspaceId,
    serial: state.serial,
    statePayload: state.statePayload,
    stateSummary: state.stateSummary,
    uploadSha256: state.uploadSha256,
    runId: state.runId,
    createdAt: state.createdAt,
  };
}

function stateVersionResourceId(attrs: Record<string, unknown>, ...keys: string[]): string | null {
  return stringAttribute(attrs, ...keys);
}

async function authorizedStatePair(
  workspaceId: string,
  attrs: Record<string, unknown>,
  context: ParamContext,
): Promise<Readonly<{ workspace: WorkspaceRow; before: typeof stateVersions.$inferSelect; after: typeof stateVersions.$inferSelect }> | { error: Record<string, unknown> }> {
  const workspace = await workspaceByPermission(workspaceId, context, "state-read");
  if (workspace === undefined) return { error: notFound(context.set) };
  const beforeId = stateVersionResourceId(attrs, "before-state-version-id", "beforeStateVersionId", "before");
  const afterId = stateVersionResourceId(attrs, "after-state-version-id", "afterStateVersionId", "after");
  if (beforeId === null || afterId === null || beforeId === afterId) {
    return { error: errorDocument(context.set, 422, "before and after state-version IDs must identify two different versions") };
  }
  const versions = await db.query.stateVersions.findMany({
    where: and(eq(stateVersions.workspaceId, workspaceId), inArray(stateVersions.id, [beforeId, afterId])),
  });
  const before = versions.find((version): boolean => version.id === beforeId);
  const after = versions.find((version): boolean => version.id === afterId);
  if (before === undefined || after === undefined) {
    return { error: errorDocument(context.set, 410, "One or both state versions are unavailable under the retention policy", "State Version Unavailable") };
  }
  return { workspace, before, after };
}

async function createStateComparison(context: ParamContext, workspaceId: string, attrs: Record<string, unknown>): Promise<unknown> {
  const pair = await authorizedStatePair(workspaceId, attrs, context);
  if ("error" in pair) return pair.error;
  const comparison = compareStateVersions(comparisonStateInput(pair.before), comparisonStateInput(pair.after));
  const digest = platformArtifactDigest({ before: pair.before.id, after: pair.after.id, comparison });
  const artifact = await createPlatformArtifact({
    kind: "state-comparison",
    organizationId: pair.workspace.orgId,
    workspaceId,
    actorId: context.user?.id ?? null,
    dedupeKey: `state:${pair.before.id}:${pair.after.id}:${digest}`,
    payload: {
      "before-state-version-id": pair.before.id,
      "after-state-version-id": pair.after.id,
      "before-digest": pair.before.uploadSha256 ?? null,
      "after-digest": pair.after.uploadSha256 ?? null,
      comparison,
      "raw-state-access": false,
      "live-cloud-change-proven": false,
    },
  });
  return { data: artifactResource(artifact, "state-comparisons") };
}

async function createPlanComparison(context: ParamContext, runId: string, attrs: Record<string, unknown>): Promise<unknown> {
  const current = await findAuthorizedRun(runId, context.user?.id, context.orgId ?? null, context.teamId ?? null, "run-read");
  if (current === undefined) return notFound(context.set);
  const beforeId = stringAttribute(attrs, "before-run-id", "beforeRunId");
  if (beforeId === null || beforeId === runId) return errorDocument(context.set, 422, "before-run-id must identify a different run");
  const before = await findAuthorizedRun(beforeId, context.user?.id, context.orgId ?? null, context.teamId ?? null, "run-read");
  if (before === undefined || before.workspace.id !== current.workspace.id) return notFound(context.set);
  const [beforePlan, afterPlan] = await Promise.all([readPlanJsonArtifact(beforeId), readPlanJsonArtifact(runId)]);
  if (beforePlan === undefined || afterPlan === undefined) return errorDocument(context.set, 409, "Both runs need a retained public plan artifact before they can be compared", "Plan Artifact Unavailable");
  const comparison = comparePlanJson(beforePlan, afterPlan);
  const artifact = await createPlatformArtifact({
    kind: "plan-comparison",
    organizationId: current.workspace.orgId,
    workspaceId: current.workspace.id,
    actorId: context.user?.id ?? null,
    dedupeKey: `plan:${beforeId}:${runId}`,
    payload: {
      "before-run-id": beforeId,
      "after-run-id": runId,
      "before-configuration-version-id": before.run.configurationVersionId,
      "after-configuration-version-id": current.run.configurationVersionId,
      comparison,
      "sensitive-values-compared": false,
    },
  });
  return { data: artifactResource(artifact, "plan-comparisons") };
}

async function inventoryForWorkspace(workspace: WorkspaceRow, query: string | null): Promise<readonly InventoryObservation[]> {
  const versions = await db.query.stateVersions.findMany({
    where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized")),
    orderBy: [asc(stateVersions.serial), asc(stateVersions.createdAt)],
    limit: 100,
  });
  const observations = versions.flatMap((version): readonly InventoryObservation[] => stateInventoryObservations(comparisonStateInput(version)));
  if (query === null || query === "") return observations;
  const lower = query.toLocaleLowerCase();
  return observations.filter((observation): boolean =>
    [observation.identity, observation.address, observation.provider, observation.type].some((value): boolean => value.toLocaleLowerCase().includes(lower)),
  );
}

function inventoryResource(observation: InventoryObservation): Record<string, unknown> {
  return {
    id: `${observation.stateVersionId}:${observation.identity}`,
    type: "resource-inventory-observations",
    attributes: {
      identity: observation.identity,
      "identity-source": observation.identitySource,
      address: observation.address,
      mode: observation.mode,
      type: observation.type,
      provider: observation.provider,
      "state-version-id": observation.stateVersionId,
      serial: observation.serial,
      "run-id": observation.runId,
      "observed-at": observation.observedAt,
      age: Math.max(0, Date.now() - Date.parse(observation.observedAt)),
    },
  };
}

async function organizationCanManage(
  organization: typeof organizations.$inferSelect,
  context: ParamContext,
  permission: "manage-workspaces" | "manage-policies",
): Promise<boolean> {
  return checkOrganizationPermission(organization.id, context.user?.id, context.orgId ?? null, context.teamId ?? null, permission);
}

function jsonArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

async function latestConfigurationVersion(workspaceId: string): Promise<typeof configurationVersions.$inferSelect | undefined> {
  return db.query.configurationVersions.findFirst({
    where: and(eq(configurationVersions.workspaceId, workspaceId), isNull(configurationVersions.softDeletedAt)),
    orderBy: [desc(configurationVersions.createdAt)],
  });
}

function promotionResource(row: PlatformArtifact): Record<string, unknown> {
  return artifactResource(row, "promotions");
}

function fleetResource(row: PlatformArtifact): Record<string, unknown> {
  return artifactResource(row, "fleet-operations");
}

export const platformRoutes = new Elysia({ name: "platform" })
  .use(authPlugin)
  .post("/api/v2/workspaces/:workspace_id/state-comparisons", async (context: ParamContext): Promise<unknown> =>
    createStateComparison(context, context.params["workspace_id"] ?? "", attributesFrom(context.body)))
  .get("/api/v2/state-comparisons/:comparison_id", async (context: ParamContext): Promise<unknown> => {
    const id = context.params["comparison_id"] ?? "";
    const row = await db.query.durableJobs.findFirst({ where: and(eq(durableJobs.id, id), eq(durableJobs.kind, "state-comparison")) });
    if (row === undefined || typeof row.payload["organizationId"] !== "string") return notFound(context.set);
    const workspaceId = typeof row.payload["workspaceId"] === "string" ? row.payload["workspaceId"] : "";
    if (await workspaceByPermission(workspaceId, context, "state-read") === undefined) return notFound(context.set);
    return { data: artifactResource(row as PlatformArtifact, "state-comparisons") };
  })
  .post("/api/v2/runs/:run_id/plan-comparisons", async (context: ParamContext): Promise<unknown> =>
    createPlanComparison(context, context.params["run_id"] ?? "", attributesFrom(context.body)))
  .get("/api/v2/plan-comparisons/:comparison_id", async (context: ParamContext): Promise<unknown> => {
    const row = await getPlatformArtifact(context.params["comparison_id"] ?? "", "plan-comparison", context.orgId ?? "");
    if (row === undefined) return notFound(context.set);
    const workspaceId = typeof row.payload["workspaceId"] === "string" ? row.payload["workspaceId"] : "";
    if (await workspaceByPermission(workspaceId, context, "run-read") === undefined) return notFound(context.set);
    return { data: artifactResource(row, "plan-comparisons") };
  })
  .get("/api/v2/workspaces/:workspace_id/inventory-history", async (context: ParamContext): Promise<unknown> => {
    const workspace = await workspaceByPermission(context.params["workspace_id"] ?? "", context, "state-read");
    if (workspace === undefined) return notFound(context.set);
    const query = new URL(context.request.url).searchParams.get("q") ?? new URL(context.request.url).searchParams.get("address");
    const observations = await inventoryForWorkspace(workspace, query);
    return { data: observations.map(inventoryResource), meta: { "source": "state-history", "live-cloud-current": false } };
  })
  .post("/api/v2/workspaces/:workspace_id/import-workbench", async (context: ParamContext): Promise<unknown> => {
    const workspace = await workspaceByPermission(context.params["workspace_id"] ?? "", context, "plan");
    if (workspace === undefined) return notFound(context.set);
    const attrs = attributesFrom(context.body);
    const engine = stringAttribute(attrs, "engine", "iac-binary") ?? "terraform";
    if (engine !== "terraform" && engine !== "tofu") return errorDocument(context.set, 422, "engine must be terraform or tofu");
    const mappings = validateImportMappings(attrs["mappings"] ?? attrs["resources"]);
    if (mappings.errors.length > 0) return errorDocument(context.set, 422, mappings.errors.join("; "));
    const latest = await db.query.stateVersions.findFirst({ where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized")), orderBy: [desc(stateVersions.serial)] });
    const existingIds = new Set<string>();
    const existingState = latest === undefined ? null : parseTerraformStatePayload(latest.statePayload);
    if (existingState !== null && Array.isArray(existingState["resources"])) {
      for (const resource of existingState["resources"]) {
        if (resource === null || typeof resource !== "object" || Array.isArray(resource)) continue;
        const instances = (resource as Record<string, unknown>)["instances"];
        if (!Array.isArray(instances)) continue;
        for (const instance of instances) {
          if (instance === null || typeof instance !== "object" || Array.isArray(instance)) continue;
          const instanceAttrs = (instance as Record<string, unknown>)["attributes"];
          if (instanceAttrs !== null && typeof instanceAttrs === "object" && !Array.isArray(instanceAttrs) && typeof (instanceAttrs as Record<string, unknown>)["id"] === "string") existingIds.add((instanceAttrs as Record<string, unknown>)["id"] as string);
        }
      }
    }
    const conflicts = mappings.mappings.filter((mapping): boolean => existingIds.has(mapping.providerId)).map((mapping): string => mapping.address);
    const generated = mappings.mappings.map(importConfiguration);
    const artifact = await createPlatformArtifact({
      kind: "import-workbench",
      organizationId: workspace.orgId,
      workspaceId: workspace.id,
      actorId: context.user?.id ?? null,
      payload: {
        engine,
        mappings: mappings.mappings,
        "generated-configuration": generated,
        "unresolved-required-arguments": Array.isArray(attrs["required-arguments"]) ? attrs["required-arguments"] : [],
        conflicts,
        source: stringAttribute(attrs, "source", "original-source") ?? "operator-mapping",
        "source-digest": inputDigest(attrs["source"] ?? mappings.mappings),
        "decisions-preserved": true,
        "apply-authority": false,
      },
      status: conflicts.length === 0 ? "review" : "blocked",
    });
    context.set.status = 201;
    return { data: artifactResource(artifact, "import-workbenches") };
  })
  .get("/api/v2/workspaces/:workspace_id/import-workbenches", async (context: ParamContext): Promise<unknown> => {
    const workspace = await workspaceByPermission(context.params["workspace_id"] ?? "", context, "plan");
    if (workspace === undefined) return notFound(context.set);
    const rows = await listPlatformArtifacts({ kind: "import-workbench", organizationId: workspace.orgId, workspaceId: workspace.id });
    return resourceList(rows, "import-workbenches");
  })
  .get("/api/v2/import-workbenches/:workbench_id", async (context: ParamContext): Promise<unknown> => {
    const row = await getPlatformArtifact(context.params["workbench_id"] ?? "", "import-workbench", context.orgId ?? "");
    if (row === undefined) return notFound(context.set);
    const workspaceId = typeof row.payload["workspaceId"] === "string" ? row.payload["workspaceId"] : "";
    if (await workspaceByPermission(workspaceId, context, "plan") === undefined) return notFound(context.set);
    return { data: artifactResource(row, "import-workbenches") };
  })
  .post("/api/v2/import-workbenches/:workbench_id/export", async (context: ParamContext): Promise<unknown> => {
    const row = await getPlatformArtifact(context.params["workbench_id"] ?? "", "import-workbench", context.orgId ?? "");
    if (row === undefined) return notFound(context.set);
    const workspaceId = typeof row.payload["workspaceId"] === "string" ? row.payload["workspaceId"] : "";
    if (await workspaceByPermission(workspaceId, context, "plan") === undefined) return notFound(context.set);
    const generated = Array.isArray(row.payload["generated-configuration"]) ? row.payload["generated-configuration"] : [];
    const text = generated.filter((line): line is string => typeof line === "string").join("\n\n");
    context.set.headers["Content-Type"] = "text/plain; charset=utf-8";
    context.set.headers["Content-Disposition"] = `attachment; filename=terrence-import-${row.id}.tf`;
    return new Response(`${text}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  })
  .get("/api/v2/workspaces/:workspace_id/drift-incidents", async (context: ParamContext): Promise<unknown> => {
    const workspace = await workspaceByPermission(context.params["workspace_id"] ?? "", context, "run-read");
    if (workspace === undefined) return notFound(context.set);
    const rows = await listPlatformArtifacts({ kind: "drift-incident", organizationId: workspace.orgId, workspaceId: workspace.id });
    return resourceList(rows, "drift-incidents");
  })
  .post("/api/v2/assessment-results/:assessment_result_id/drift-incident", async (context: ParamContext): Promise<unknown> => {
    const assessmentId = context.params["assessment_result_id"] ?? "";
    const assessment = await db.query.assessmentResults.findFirst({ where: eq(assessmentResults.id, assessmentId) });
    if (assessment === undefined) return notFound(context.set);
    const workspace = await workspaceByPermission(assessment.workspaceId, context, "run-tasks");
    if (workspace === undefined) return notFound(context.set);
    const checks = await db.query.assessmentCheckResults.findMany({ where: eq(assessmentCheckResults.assessmentResultId, assessmentId), columns: { address: true, kind: true, status: true } });
    const fingerprint = driftFingerprint({
      workspaceId: workspace.id,
      assessmentId,
      drifted: assessment.drifted,
      checks: checks.map((check): Record<string, unknown> => ({ address: check.address, kind: check.kind, status: check.status })),
    });
    const incidents = await listPlatformArtifacts({ kind: "drift-incident", organizationId: workspace.orgId, workspaceId: workspace.id });
    const existing = incidents.find((row): boolean => row.payload["fingerprint"] === fingerprint && row.status !== "resolved");
    const now = Date.now();
    const historyEntry = { assessmentId, fingerprint, observedAt: new Date(now).toISOString(), drifted: assessment.drifted };
    const payload = existing === undefined
      ? {
          fingerprint,
          "first-assessment-id": assessmentId,
          "latest-assessment-id": assessmentId,
          "observed-at": new Date(now).toISOString(),
          assignee: stringAttribute(attributesFrom(context.body), "assignee", "assigned-to"),
          comments: [],
          history: [historyEntry],
          "snooze-until": null,
          "resolution-classification": null,
          "remediation-run-id": null,
          "assessment-age-ms": 0,
        }
      : {
          ...artifactPayload(existing),
          "latest-assessment-id": assessmentId,
          "assessment-age-ms": Math.max(0, now - assessment.createdAt),
          history: [...(Array.isArray(existing.payload["history"]) ? existing.payload["history"] : []), historyEntry].slice(-100),
        };
    const artifact = existing === undefined
      ? await createPlatformArtifact({ kind: "drift-incident", organizationId: workspace.orgId, workspaceId: workspace.id, actorId: context.user?.id ?? null, dedupeKey: `drift:${workspace.id}:${fingerprint}`, payload, status: "open" })
      : await updatePlatformArtifact(existing.id, "drift-incident", workspace.orgId, { status: existing.status === "snoozed" && typeof existing.payload["snooze-until"] === "number" && existing.payload["snooze-until"] > now ? "snoozed" : "open", payload });
    if (artifact === undefined) return notFound(context.set);
    context.set.status = existing === undefined ? 201 : 200;
    return { data: artifactResource(artifact, "drift-incidents") };
  })
  .patch("/api/v2/drift-incidents/:incident_id", async (context: ParamContext): Promise<unknown> => {
    const attrs = attributesFrom(context.body);
    const row = await db.query.durableJobs.findFirst({ where: and(eq(durableJobs.id, context.params["incident_id"] ?? ""), eq(durableJobs.kind, "drift-incident")) });
    if (row === undefined || typeof row.payload["organizationId"] !== "string") return notFound(context.set);
    const organizationId = row.payload["organizationId"] as string;
    const artifact = row as PlatformArtifact;
    const workspaceId = typeof row.payload["workspaceId"] === "string" ? row.payload["workspaceId"] : "";
    if (await workspaceByPermission(workspaceId, context, "run-tasks") === undefined) return notFound(context.set);
    const status = stringAttribute(attrs, "status") ?? artifact.status;
    if (!["open", "snoozed", "resolved"].includes(status)) return errorDocument(context.set, 422, "status must be open, snoozed, or resolved");
    const classification = stringAttribute(attrs, "resolution-classification", "resolutionClassification");
    if (status === "resolved" && classification === null) return errorDocument(context.set, 422, "resolved incidents require an explicit resolution classification");
    if (status === "resolved" && stringAttribute(attrs, "evidence-assessment-id", "evidenceAssessmentId") === null && attrs["acknowledged-exception"] !== true) {
      return errorDocument(context.set, 422, "resolved incidents require a subsequent assessment or acknowledged exception");
    }
    const until = attrs["snooze-until"] ?? attrs["snoozeUntil"];
    const snoozeUntil = status === "snoozed" ? typeof until === "string" ? Date.parse(until) : typeof until === "number" ? until : Number.NaN : null;
    if (status === "snoozed" && (!Number.isFinite(snoozeUntil) || (snoozeUntil as number) <= Date.now() || (snoozeUntil as number) > Date.now() + 30 * 86_400_000)) {
      return errorDocument(context.set, 422, "snooze-until must be between now and 30 days from now");
    }
    const comment = stringAttribute(attrs, "comment");
    const comments = Array.isArray(artifact.payload["comments"]) ? [...artifact.payload["comments"]] : [];
    if (comment !== null) comments.push({ body: comment, actorId: context.user?.id ?? null, createdAt: new Date().toISOString() });
    const assignee = stringAttribute(attrs, "assignee", "assigned-to");
    const evidence = stringAttribute(attrs, "evidence-assessment-id", "evidenceAssessmentId");
    const payload = {
      ...artifactPayload(artifact),
      ...(assignee === null ? {} : { assignee }),
      comments: comments.slice(-100),
      "snooze-until": snoozeUntil,
      ...(classification === null ? {} : { "resolution-classification": classification }),
      ...(evidence === null ? {} : { "evidence-assessment-id": evidence }),
    };
    const updated = await updatePlatformArtifact(artifact.id, "drift-incident", organizationId, { status, payload });
    if (updated === undefined) return notFound(context.set);
    return { data: artifactResource(updated, "drift-incidents") };
  })
  .post("/api/v2/drift-incidents/:incident_id/remediation", async (context: ParamContext): Promise<unknown> => {
    const row = await db.query.durableJobs.findFirst({ where: and(eq(durableJobs.id, context.params["incident_id"] ?? ""), eq(durableJobs.kind, "drift-incident")) });
    if (row === undefined || typeof row.payload["organizationId"] !== "string") return notFound(context.set);
    const workspaceId = typeof row.payload["workspaceId"] === "string" ? row.payload["workspaceId"] : "";
    const workspace = await workspaceByPermission(workspaceId, context, "run-tasks");
    if (workspace === undefined) return notFound(context.set);
    const configuration = await latestConfigurationVersion(workspace.id);
    const runId = newResourceId("run");
    await db.insert(runs).values({
      id: runId,
      workspaceId: workspace.id,
      configurationVersionId: configuration?.id ?? null,
      status: "pending",
      operation: "plan_and_apply",
      autoApply: false,
      message: `Drift remediation review for incident ${row.id}`,
      createdBy: context.user?.id ?? null,
      createdAt: Date.now(),
    });
    const updated = await updatePlatformArtifact(row.id, "drift-incident", workspace.orgId, {
      status: "open",
      payload: { ...artifactPayload(row as PlatformArtifact), "remediation-run-id": runId },
    });
    return { data: { id: runId, type: "runs", attributes: { status: "pending", "auto-apply": false, "review-required": true, "incident-id": updated?.id ?? row.id } } };
  })
  .post("/api/v2/workspaces/:workspace_id/dependency-impact-previews", async (context: ParamContext): Promise<unknown> => {
    const workspace = await workspaceByPermission(context.params["workspace_id"] ?? "", context, "read");
    if (workspace === undefined) return notFound(context.set);
    const attrs = attributesFrom(context.body);
    const sourceRunId = stringAttribute(attrs, "source-run-id", "sourceRunId");
    if (sourceRunId !== null) {
      const source = await findAuthorizedRun(sourceRunId, context.user?.id, context.orgId ?? null, context.teamId ?? null, "run-read");
      if (source === undefined || source.workspace.id !== workspace.id) return notFound(context.set);
    }
    const rawEdges = jsonArray(attrs["edges"] ?? attrs["dependencies"]);
    const authorizedEdges: { from: string; to: string; source: "explicit" | "observed-output" | "inferred"; sourceRunId?: string | null }[] = [];
    for (const edge of rawEdges) {
      const from = typeof edge["from"] === "string" ? edge["from"] : workspace.id;
      const to = typeof edge["to"] === "string" ? edge["to"] : "";
      if (to === "") continue;
      const target = await workspaceByPermission(to, context, "read");
      if (target === undefined || target.orgId !== workspace.orgId) continue;
      const source = edge["source"] === "observed-output" || edge["source"] === "inferred" ? edge["source"] : "explicit";
      authorizedEdges.push({ from, to, source, sourceRunId });
    }
    const graph = dependencyImpact({ rootWorkspaceId: workspace.id, edges: authorizedEdges, maxFanout: typeof attrs["max-fanout"] === "number" ? attrs["max-fanout"] : 100 });
    const artifact = await createPlatformArtifact({
      kind: "dependency-impact",
      organizationId: workspace.orgId,
      workspaceId: workspace.id,
      actorId: context.user?.id ?? null,
      payload: { "source-run-id": sourceRunId, edges: graph.edges, cycles: graph.cycles, truncated: graph.truncated, "queued-plans": [] },
      status: graph.cycles.length === 0 ? "preview" : "cycle-detected",
    });
    context.set.status = 201;
    return { data: artifactResource(artifact, "dependency-impact-previews") };
  })
  .post("/api/v2/dependency-impact-previews/:preview_id/queue", async (context: ParamContext): Promise<unknown> => {
    const row = await db.query.durableJobs.findFirst({ where: and(eq(durableJobs.id, context.params["preview_id"] ?? ""), eq(durableJobs.kind, "dependency-impact")) });
    if (row === undefined || typeof row.payload["organizationId"] !== "string") return notFound(context.set);
    const organizationId = row.payload["organizationId"] as string;
    const workspaceId = typeof row.payload["workspaceId"] === "string" ? row.payload["workspaceId"] : "";
    const root = await workspaceByPermission(workspaceId, context, "plan");
    if (root === undefined) return notFound(context.set);
    const payload = artifactPayload(row as PlatformArtifact);
    const cycles = Array.isArray(payload["cycles"]) ? payload["cycles"] : [];
    if (cycles.length > 0) return errorDocument(context.set, 409, "The dependency graph contains a cycle; downstream planning was not queued", "Dependency Cycle");
    const requested = stringArrayAttribute(attributesFrom(context.body), "workspace-ids", "workspaceIds");
    const edges = jsonArray(payload["edges"]);
    const targets = [...new Set((requested.length > 0 ? requested : edges.map((edge): string => typeof edge["to"] === "string" ? edge["to"] : "").filter(Boolean)))];
    const queuedPlans: Record<string, unknown>[] = [];
    for (const targetId of targets.slice(0, 100)) {
      const target = await workspaceByPermission(targetId, context, "plan");
      if (target === undefined || target.orgId !== root.orgId) continue;
      const configuration = await latestConfigurationVersion(target.id);
      const runId = newResourceId("run");
      await db.insert(runs).values({ id: runId, workspaceId: target.id, configurationVersionId: configuration?.id ?? null, status: "pending", operation: "plan_only", planOnly: true, autoApply: false, message: `Dependency preview ${row.id} from ${workspaceId}`, createdBy: context.user?.id ?? null, createdAt: Date.now() });
      queuedPlans.push({ workspaceId: target.id, runId, sourceRunId: payload["source-run-id"] ?? null, status: "queued" });
    }
    const updated = await updatePlatformArtifact(row.id, "dependency-impact", organizationId, { status: "plans-queued", payload: { ...payload, "queued-plans": queuedPlans } });
    if (updated === undefined) return notFound(context.set);
    return { data: artifactResource(updated, "dependency-impact-previews") };
  })
  .post("/api/v2/organizations/:org_name/fleet-operations/previews", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-workspaces"))) return notFound(context.set);
    const attrs = attributesFrom(context.body);
    const action = stringAttribute(attrs, "action", "requested-action");
    const allowedActions = new Set(["assess", "queue-plan", "change-safe-setting", "attach-set", "export-metadata"]);
    if (action === null || !allowedActions.has(action)) return errorDocument(context.set, 422, "action must be a bounded, reviewable fleet operation");
    if (["apply", "destroy", "bulk-apply", "bulk-destroy"].includes(action)) return errorDocument(context.set, 422, "apply and destroy are not fleet operations");
    const targetIds = [...new Set(stringArrayAttribute(attrs, "target-ids", "workspace-ids"))];
    if (targetIds.length === 0 || targetIds.length > 500) return errorDocument(context.set, 422, "target-ids must contain between 1 and 500 workspaces");
    const workspacesInOrg = await db.query.workspaces.findMany({ where: and(eq(workspaces.orgId, organization.id), inArray(workspaces.id, targetIds)), columns: { id: true, name: true } });
    const visible = new Map(workspacesInOrg.map((workspace): [string, typeof workspace] => [workspace.id, workspace]));
    const permissionFailures = targetIds.filter((id): boolean => !visible.has(id)).map((id): Record<string, unknown> => ({ workspaceId: id, reason: "not-found-or-not-in-organization" }));
    const manifest = {
      action,
      "target-ids": targetIds,
      "selection-digest": platformArtifactDigest({ action, targetIds }),
      "selected-at": new Date().toISOString(),
      "selected-by": context.user?.id ?? null,
      "selection-source": attrs["query"] === undefined ? "explicit-ids" : "query-preview-materialized",
    };
    const artifact = await createPlatformArtifact({
      kind: "fleet-operation",
      organizationId: organization.id,
      actorId: context.user?.id ?? null,
      payload: {
        phase: "preview",
        action,
        manifest,
        "target-workspaces": targetIds.map((id): Record<string, unknown> => ({ id, name: visible.get(id)?.name ?? null })),
        "permission-failures": permissionFailures,
        "per-target": [],
        "canceled-remaining": false,
      },
      status: "preview",
    });
    context.set.status = 201;
    return { data: fleetResource(artifact) };
  })
  .post("/api/v2/organizations/:org_name/fleet-operations", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-workspaces"))) return notFound(context.set);
    const attrs = attributesFrom(context.body);
    const previewId = stringAttribute(attrs, "preview-id", "previewId");
    if (previewId === null) return errorDocument(context.set, 422, "preview-id is required; commit an immutable preview manifest");
    const preview = await getPlatformArtifact(previewId, "fleet-operation", organization.id);
    if (preview === undefined || preview.status !== "preview") return errorDocument(context.set, 409, "The fleet preview is unavailable or already committed", "Fleet Preview Unavailable");
    const payload = artifactPayload(preview);
    const manifest = payload["manifest"];
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return errorDocument(context.set, 409, "The preview has no immutable selection manifest");
    const manifestRecord = manifest as Record<string, unknown>;
    const expectedDigest = typeof manifestRecord["selection-digest"] === "string" ? manifestRecord["selection-digest"] as string : "";
    const suppliedDigest = stringAttribute(attrs, "selection-digest", "selectionDigest");
    if (suppliedDigest !== null && suppliedDigest !== expectedDigest) return errorDocument(context.set, 409, "The selection manifest digest does not match the preview", "Selection Changed");
    const targetIdsRaw = manifestRecord["target-ids"];
    const targetIds = Array.isArray(targetIdsRaw) ? targetIdsRaw.filter((id: unknown): id is string => typeof id === "string") : [];
    const action = typeof manifestRecord["action"] === "string" ? manifestRecord["action"] as string : "assess";
    const perTarget: Record<string, unknown>[] = [];
    for (const targetId of targetIds) {
      const target = await workspaceByPermission(targetId, context, action === "export-metadata" || action === "assess" ? "read" : "admin");
      perTarget.push(target === undefined
        ? { workspaceId: targetId, status: "failed", reason: "permission-revoked-before-execution" }
        : { workspaceId: targetId, status: action === "export-metadata" || action === "assess" ? "succeeded" : "queued", action });
    }
    const idempotency = context.request.headers.get("Idempotency-Key");
    const artifact = await createPlatformArtifact({
      kind: "fleet-operation",
      organizationId: organization.id,
      actorId: context.user?.id ?? null,
      dedupeKey: `fleet:${previewId}:${idempotency ?? expectedDigest}`,
      payload: {
        phase: "execution",
        action,
        "preview-id": previewId,
        manifest,
        "per-target": perTarget,
        "permission-failures": payload["permission-failures"] ?? [],
        "canceled-remaining": false,
        "executed-at": new Date().toISOString(),
      },
      status: perTarget.some((target): boolean => target["status"] === "failed") ? "partial-failure" : "completed",
    });
    await updatePlatformArtifact(preview.id, "fleet-operation", organization.id, { status: "committed", payload: { ...payload, "committed-operation-id": artifact.id } });
    context.set.status = 201;
    return { data: fleetResource(artifact) };
  })
  .get("/api/v2/organizations/:org_name/fleet-operations/:operation_id", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-workspaces"))) return notFound(context.set);
    const row = await getPlatformArtifact(context.params["operation_id"] ?? "", "fleet-operation", organization.id);
    if (row === undefined) return notFound(context.set);
    return { data: fleetResource(row) };
  })
  .post("/api/v2/organizations/:org_name/fleet-operations/:operation_id/cancel", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-workspaces"))) return notFound(context.set);
    const row = await getPlatformArtifact(context.params["operation_id"] ?? "", "fleet-operation", organization.id);
    if (row === undefined) return notFound(context.set);
    const targets = Array.isArray(row.payload["per-target"]) ? row.payload["per-target"] : [];
    const perTarget = targets.map((target): unknown => target !== null && typeof target === "object" && !Array.isArray(target) && (target as Record<string, unknown>)["status"] === "queued" ? { ...(target as Record<string, unknown>), status: "canceled", reason: "remaining-work-canceled" } : target);
    const updated = await updatePlatformArtifact(row.id, "fleet-operation", organization.id, { status: "canceled", payload: { ...artifactPayload(row), "per-target": perTarget, "canceled-remaining": true } });
    if (updated === undefined) return notFound(context.set);
    return { data: fleetResource(updated) };
  })
  .post("/api/v2/organizations/:org_name/promotions", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-workspaces"))) return notFound(context.set);
    const attrs = attributesFrom(context.body);
    const configurationDigest = stringAttribute(attrs, "configuration-digest", "configurationDigest");
    const targetIds = stringArrayAttribute(attrs, "target-workspace-ids", "workspace-ids");
    if (configurationDigest === null || targetIds.length === 0 || targetIds.length > 25) return errorDocument(context.set, 422, "configuration-digest and 1 to 25 ordered target workspaces are required");
    const stages = targetIds.map((workspaceId, index): Record<string, unknown> => ({ "stage-number": index + 1, "workspace-id": workspaceId, status: "pending", "run-id": null }));
    const configurationVersionIds = attrs["configuration-version-ids"] !== null && typeof attrs["configuration-version-ids"] === "object" && !Array.isArray(attrs["configuration-version-ids"]) ? attrs["configuration-version-ids"] as Record<string, unknown> : {};
    const release = {
      "configuration-digest": configurationDigest,
      "target-graph": stages,
      "configuration-version-ids": Object.fromEntries(Object.entries(configurationVersionIds).filter(([workspaceId, id]): boolean => targetIds.includes(workspaceId) && typeof id === "string")),
      "promoted-by": context.user?.id ?? null,
      "promotion-reason": stringAttribute(attrs, "reason", "promotion-reason"),
      "failed-stage": null,
      "stopped": false,
    };
    const idempotency = context.request.headers.get("Idempotency-Key");
    const artifact = await createPlatformArtifact({
      kind: "promotion",
      organizationId: organization.id,
      actorId: context.user?.id ?? null,
      ...(idempotency === null ? {} : { dedupeKey: `promotion:${organization.id}:${idempotency}` }),
      payload: release,
      status: "pending",
    });
    context.set.status = 201;
    return { data: promotionResource(artifact) };
  })
  .get("/api/v2/organizations/:org_name/promotions/:promotion_id", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-workspaces"))) return notFound(context.set);
    const row = await getPlatformArtifact(context.params["promotion_id"] ?? "", "promotion", organization.id);
    if (row === undefined) return notFound(context.set);
    return { data: promotionResource(row) };
  })
  .post("/api/v2/organizations/:org_name/promotions/:promotion_id/advance", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-workspaces"))) return notFound(context.set);
    const row = await getPlatformArtifact(context.params["promotion_id"] ?? "", "promotion", organization.id);
    if (row === undefined) return notFound(context.set);
    const payload = artifactPayload(row);
    if (payload["stopped"] === true) return errorDocument(context.set, 409, "Promotion was explicitly stopped; create a deliberate retry from the recorded stage", "Promotion Stopped");
    const stages = Array.isArray(payload["target-graph"]) ? payload["target-graph"].map((stage): Record<string, unknown> => stage as Record<string, unknown>) : [];
    const retryFailed = attributesFrom(context.body)["retry-failed"] === true;
    const stage = stages.find((candidate): boolean => candidate["status"] === "pending" || (retryFailed && candidate["status"] === "failed"));
    if (stage === undefined) return { data: promotionResource(row), meta: { "promotion-complete": true } };
    const workspaceId = typeof stage["workspace-id"] === "string" ? stage["workspace-id"] : "";
    const workspace = await workspaceByPermission(workspaceId, context, "plan");
    if (workspace === undefined || workspace.orgId !== organization.id) {
      stage["status"] = "failed";
      stage["reason"] = "permission-revoked-at-execution";
      await updatePlatformArtifact(row.id, "promotion", organization.id, { status: "partial-failure", payload: { ...payload, "failed-stage": stage["stage-number"], "target-graph": stages } });
      return errorDocument(context.set, 403, "Promotion stage is no longer authorized", "Promotion Stage Failed");
    }
    const configuredVersion = payload["configuration-version-ids"] !== null && typeof payload["configuration-version-ids"] === "object" && !Array.isArray(payload["configuration-version-ids"]) ? (payload["configuration-version-ids"] as Record<string, unknown>)[workspaceId] : undefined;
    const configuration = typeof configuredVersion === "string" ? await db.query.configurationVersions.findFirst({ where: and(eq(configurationVersions.id, configuredVersion), eq(configurationVersions.workspaceId, workspaceId)) }) : await latestConfigurationVersion(workspaceId);
    if (configuration === undefined) {
      stage["status"] = "failed";
      stage["reason"] = "target-configuration-version-unavailable";
      await updatePlatformArtifact(row.id, "promotion", organization.id, { status: "partial-failure", payload: { ...payload, "failed-stage": stage["stage-number"], "target-graph": stages } });
      return errorDocument(context.set, 409, "Target has no configuration version for a fresh plan", "Promotion Stage Failed");
    }
    const runId = newResourceId("run");
    await db.insert(runs).values({ id: runId, workspaceId, configurationVersionId: configuration.id, status: "pending", operation: "plan_only", planOnly: true, autoApply: false, message: `Promotion ${row.id} digest ${payload["configuration-digest"] as string}`, createdBy: context.user?.id ?? null, createdAt: Date.now() });
    stage["status"] = "queued";
    stage["run-id"] = runId;
    const updated = await updatePlatformArtifact(row.id, "promotion", organization.id, { status: "in-progress", payload: { ...payload, "target-graph": stages, "last-advanced-at": new Date().toISOString() } });
    if (updated === undefined) return notFound(context.set);
    return { data: promotionResource(updated), meta: { "created-run-id": runId, "target-configuration-version-id": configuration.id, "fresh-plan-required": true } };
  })
  .post("/api/v2/organizations/:org_name/promotions/:promotion_id/stop", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-workspaces"))) return notFound(context.set);
    const row = await getPlatformArtifact(context.params["promotion_id"] ?? "", "promotion", organization.id);
    if (row === undefined) return notFound(context.set);
    const updated = await updatePlatformArtifact(row.id, "promotion", organization.id, { status: "stopped", payload: { ...artifactPayload(row), stopped: true, "stopped-at": new Date().toISOString() } });
    if (updated === undefined) return notFound(context.set);
    return { data: promotionResource(updated) };
  })
  .post("/api/v2/workspaces/:workspace_id/upgrade-rehearsals", async (context: ParamContext): Promise<unknown> => {
    const workspace = await workspaceByPermission(context.params["workspace_id"] ?? "", context, "plan");
    if (workspace === undefined) return notFound(context.set);
    const attrs = attributesFrom(context.body);
    const engine = stringAttribute(attrs, "engine", "candidate-engine") ?? "terraform";
    const version = stringAttribute(attrs, "version", "candidate-version");
    if (version === null) return errorDocument(context.set, 422, "candidate engine version is required");
    const baseline = stringAttribute(attrs, "baseline-state-version-id", "baselineStateVersionId");
    const state = baseline === null ? await db.query.stateVersions.findFirst({ where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized")), orderBy: [desc(stateVersions.serial)] }) : await db.query.stateVersions.findFirst({ where: and(eq(stateVersions.id, baseline), eq(stateVersions.workspaceId, workspace.id)) });
    if (state === undefined) return errorDocument(context.set, 409, "A retained baseline state version is required for an upgrade rehearsal", "Baseline Unavailable");
    const candidateLock = stringAttribute(attrs, "candidate-lock-digest", "lock-file-digest");
    const result = upgradeRehearsalResult({ engine, version, baselineFresh: Date.now() - state.createdAt < 24 * 86_400_000, candidateLockDigest: candidateLock });
    const artifact = await createPlatformArtifact({ kind: "upgrade-rehearsal", organizationId: workspace.orgId, workspaceId: workspace.id, actorId: context.user?.id ?? null, payload: { "baseline-state-version-id": state.id, "baseline-digest": state.uploadSha256 ?? null, "candidate-engine": engine, "candidate-version": version, "candidate-lock-digest": candidateLock, result, "apply-authority": false, "default-settings-mutated": false }, status: result["status"] === "invalid" ? "invalid" : "review" });
    context.set.status = 201;
    return { data: artifactResource(artifact, "upgrade-rehearsals") };
  })
  .get("/api/v2/workspaces/:workspace_id/upgrade-rehearsals", async (context: ParamContext): Promise<unknown> => {
    const workspace = await workspaceByPermission(context.params["workspace_id"] ?? "", context, "plan");
    if (workspace === undefined) return notFound(context.set);
    return resourceList(await listPlatformArtifacts({ kind: "upgrade-rehearsal", organizationId: workspace.orgId, workspaceId: workspace.id }), "upgrade-rehearsals");
  })
  .post("/api/v2/upgrade-rehearsals/:rehearsal_id/promote", async (context: ParamContext): Promise<unknown> => {
    const row = await db.query.durableJobs.findFirst({ where: and(eq(durableJobs.id, context.params["rehearsal_id"] ?? ""), eq(durableJobs.kind, "upgrade-rehearsal")) });
    if (row === undefined || typeof row.payload["organizationId"] !== "string") return notFound(context.set);
    const workspaceId = typeof row.payload["workspaceId"] === "string" ? row.payload["workspaceId"] : "";
    if (await workspaceByPermission(workspaceId, context, "admin") === undefined) return notFound(context.set);
    return errorDocument(context.set, 409, "Rehearsals are review-only. Promote an explicit workspace engine/settings change, then run the normal plan/apply flow", "Explicit Configuration Change Required");
  })
  .post("/api/v2/organizations/:org_name/policy-playground", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-policies"))) return notFound(context.set);
    const attrs = attributesFrom(context.body);
    const kind = stringAttribute(attrs, "kind", "policy-kind") === "sentinel" ? "sentinel" : "opa";
    const source = stringAttribute(attrs, "source", "policy-source") ?? "";
    const result = policyPlaygroundResult({ kind, source, plan: attrs["plan"] ?? attrs["input"] ?? {} });
    const artifact = await createPlatformArtifact({ kind: "policy-playground", organizationId: organization.id, actorId: context.user?.id ?? null, payload: { result, source: source.length > 0 ? "provided" : "missing", "policy-digest": result["policy-digest"], "plan-digest": result["plan-digest"], "apply-authority": false }, status: result["status"] === "invalid" ? "invalid" : "review-only" });
    context.set.status = 201;
    return { data: artifactResource(artifact, "policy-playground-runs") };
  })
  .get("/api/v2/organizations/:org_name/policy-playground/:playground_id", async (context: ParamContext): Promise<unknown> => {
    const organization = await organizationForName(context.params["org_name"] ?? "");
    if (organization === undefined || !(await organizationCanManage(organization, context, "manage-policies"))) return notFound(context.set);
    const row = await getPlatformArtifact(context.params["playground_id"] ?? "", "policy-playground", organization.id);
    if (row === undefined) return notFound(context.set);
    return { data: artifactResource(row, "policy-playground-runs") };
  });
