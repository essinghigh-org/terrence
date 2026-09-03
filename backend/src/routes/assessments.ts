import { Elysia } from "elysia";
import { eq, desc } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import {
  assessmentCheckResults,
  assessmentResults,
  workspaces,
  type users,
} from "../db/schema";
import { checkWorkspacePermission, findAuthorizedRun, findAuthorizedWorkspace , type DeepReadonly } from "../lib/utils";
import { notFound, forbidden } from "../lib/utils";

type SetObject = Readonly<{
  status?: number | string;
  headers: Readonly<Record<string, string | number>>;
}>;

type ParamContext = Readonly<{
  params: Readonly<Record<string, string>>;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  teamId?: string | null;
  set: SetObject;
}>;


type Assessment = DeepReadonly<typeof assessmentResults.$inferSelect>;

function assessmentResource(result: Assessment): Record<string, unknown> {
  return {
    id: result.id,
    type: "assessment-results",
    attributes: {
      drifted: result.drifted,
      succeeded: result.succeeded,
      "error-msg": result.errorMessage,
      "resources-drifted": result.resourcesDrifted,
      "resources-undrifted": result.resourcesUndrifted,
      "all-checks-succeeded": result.allChecksSucceeded,
      "checks-passed": result.checksPassed,
      "checks-failed": result.checksFailed,
      "checks-errored": result.checksErrored,
      "checks-unknown": result.checksUnknown,
      status: result.status,
      "created-at": new Date(result.createdAt).toISOString(),
      "completed-at": result.completedAt === null ? null : new Date(result.completedAt).toISOString(),
    },
    relationships: {
      workspace: { data: { id: result.workspaceId, type: "workspaces" } },
      "check-results": {
        links: { related: `/api/v2/assessment-results/${result.id}/check-results` },
      },
    },
    links: {
      self: `/api/v2/assessment-results/${result.id}`,
      "json-output": `/api/v2/assessment-results/${result.id}/json-output`,
      "json-schema": `/api/v2/assessment-results/${result.id}/json-schema`,
      "log-output": `/api/v2/assessment-results/${result.id}/log-output`,
    },
  };
}

type CheckResult = DeepReadonly<typeof assessmentCheckResults.$inferSelect>;

function checkResultResource(check: CheckResult): Record<string, unknown> {
  return {
    id: check.id,
    type: "check-results",
    attributes: {
      address: check.address,
      kind: check.kind,
      status: check.status,
      message: check.message,
      detail: check.detail,
      "created-at": new Date(check.createdAt).toISOString(),
    },
  };
}

async function findAuthorizedAssessment(
  id: string,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
): Promise<Assessment | undefined> {
  const result = await db.query.assessmentResults.findFirst({
    where: eq(assessmentResults.id, id),
  });
  if (result === undefined) return undefined;
  return (await findAuthorizedWorkspace(result.workspaceId, userId, orgId, teamId)) === undefined
    ? undefined
    : result;
}

async function canReadArtifacts(
  result: Assessment,
  userId: string | undefined,
  teamId: string | null,
): Promise<boolean> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, result.workspaceId),
  });
  if (workspace === undefined) return false;
  return checkWorkspacePermission(workspace, userId, null, teamId, "admin");
}

async function artifactResponse(
  id: string,
  kind: "jsonOutput" | "jsonSchema" | "logOutput",
  context: ParamContext,
): Promise<unknown> {
  const result = await findAuthorizedAssessment(id, context.user?.id, context.orgId ?? null, context.teamId ?? null);
  if (result === undefined) return notFound(context.set);
  if (!(await canReadArtifacts(result, context.user?.id, context.teamId ?? null))) return forbidden(context.set);
  if (kind === "logOutput") {
    return new Response(result.logOutput ?? "", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(JSON.stringify(result[kind] ?? {}), {
    headers: { "Content-Type": "application/json" },
  });
}

export const assessmentRoutes = new Elysia({ name: "assessments" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/assessment-results", async (context: ParamContext): Promise<unknown> => {
    const workspaceId = context.params["workspace_id"] ?? "";
    if ((await findAuthorizedWorkspace(workspaceId, context.user?.id, context.orgId ?? null, context.teamId ?? null)) === undefined) {
      return notFound(context.set);
    }
    const results = await db.query.assessmentResults.findMany({
      where: eq(assessmentResults.workspaceId, workspaceId),
      orderBy: [desc(assessmentResults.createdAt)],
      limit: 20,
    });
    return { data: results.map((result: Assessment): Record<string, unknown> => assessmentResource(result)) };
  })
  .get("/api/v2/assessment-results/:assessment_result_id", async (context: ParamContext): Promise<unknown> => {
    const id = context.params["assessment_result_id"] ?? "";
    const result = await findAuthorizedAssessment(id, context.user?.id, context.orgId ?? null, context.teamId ?? null);
    return result === undefined ? notFound(context.set) : { data: assessmentResource(result) };
  })
  .get("/api/v2/assessment-results/:assessment_result_id/check-results", async (context: ParamContext): Promise<unknown> => {
    const id = context.params["assessment_result_id"] ?? "";
    const result = await findAuthorizedAssessment(id, context.user?.id, context.orgId ?? null, context.teamId ?? null);
    if (result === undefined) return notFound(context.set);
    const checks = await db.query.assessmentCheckResults.findMany({
      where: eq(assessmentCheckResults.assessmentResultId, id),
    });
    return {
      data: checks.map((check: CheckResult): Record<string, unknown> => checkResultResource(check)),
    };
  })
  .get("/api/v2/runs/:run_id/check-results", async (context: ParamContext): Promise<unknown> => {
    const runId = context.params["run_id"] ?? "";
    if ((await findAuthorizedRun(runId, context.user?.id, context.orgId ?? null, context.teamId ?? null)) === undefined) return notFound(context.set);
    const checks = await db.query.assessmentCheckResults.findMany({
      where: eq(assessmentCheckResults.runId, runId),
    });
    return {
      data: checks.map((check: CheckResult): Record<string, unknown> => checkResultResource(check)),
    };
  })
  .get("/api/v2/assessment-results/:assessment_result_id/json-output", async (context: ParamContext): Promise<unknown> =>
    artifactResponse(context.params["assessment_result_id"] ?? "", "jsonOutput", context))
  .get("/api/v2/assessment-results/:assessment_result_id/json-schema", async (context: ParamContext): Promise<unknown> =>
    artifactResponse(context.params["assessment_result_id"] ?? "", "jsonSchema", context))
  .get("/api/v2/assessment-results/:assessment_result_id/log-output", async (context: ParamContext): Promise<unknown> =>
    artifactResponse(context.params["assessment_result_id"] ?? "", "logOutput", context));
