import { Elysia } from "elysia";
import { db } from "../db";
import { policyEvaluations, policySetOutcomes, taskStages, type users } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { authPlugin } from "../auth";
import { findAuthorizedRun } from "../lib/utils";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  request: Readonly<{ url: string }>;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObj;
}>;

function evaluationResource(evalRecord: Readonly<typeof policyEvaluations.$inferSelect>): Record<string, unknown> {
  return {
    id: evalRecord.id,
    type: "policy-evaluations",
    attributes: {
      status: evalRecord.status,
      "policy-kind": evalRecord.policyKind ?? "opa",
      "policy-tool-version": evalRecord.policyToolVersion ?? "0.44.0",
      "result-count": evalRecord.resultCount ?? {
        "advisory-failed": 0,
        errored: 0,
        "mandatory-failed": 0,
        passed: 1,
      },
      "status-timestamps": evalRecord.statusTimestamps ?? {
        "queued-at": new Date(evalRecord.createdAt).toISOString(),
        "passed-at": new Date(evalRecord.createdAt).toISOString(),
      },
    },
    relationships: {
      "task-stage": evalRecord.taskStageId ? { data: { id: evalRecord.taskStageId, type: "task-stages" } } : { data: null },
      run: evalRecord.runId ? { data: { id: evalRecord.runId, type: "runs" } } : { data: null },
    },
  };
}

export const policyEvaluationRoutes = new Elysia({ name: "policyEvaluations" })
  .use(authPlugin)
  .get("/api/v2/task-stages/:task_stage_id/policy-evaluations", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const stageId = params.task_stage_id ?? "";
    const stage = (await db.select().from(taskStages).where(eq(taskStages.id, stageId)))[0];
    if (stage === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(stage.runId, user?.id, orgId, teamId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }

    const evals = await db.select().from(policyEvaluations).where(eq(policyEvaluations.taskStageId, stage.id));
    return { data: evals.map(evaluationResource) };
  })
  .get("/api/v2/policy-evaluations/:policy_evaluation_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const evalId = params.policy_evaluation_id ?? "";
    const evalRecord = (await db.select().from(policyEvaluations).where(eq(policyEvaluations.id, evalId)))[0];
    if (evalRecord === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (evalRecord.runId) {
      const authorized = await findAuthorizedRun(evalRecord.runId, user?.id, orgId, teamId);
      if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    }

    return { data: evaluationResource(evalRecord) };
  })
  .get("/api/v2/policy-evaluations/:policy_evaluation_id/policy-set-outcomes", async ({ params, request, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const evalId = params.policy_evaluation_id ?? "";
    const evalRecord = (await db.select().from(policyEvaluations).where(eq(policyEvaluations.id, evalId)))[0];
    if (evalRecord === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (evalRecord.runId) {
      const authorized = await findAuthorizedRun(evalRecord.runId, user?.id, orgId, teamId);
      if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    }

    const url = new URL(request.url);
    const filterStatus = url.searchParams.get("filter[status]") ?? url.searchParams.get("filter[0][status]");
    const filterEnforcement = url.searchParams.get("filter[enforcementLevel]") ?? url.searchParams.get("filter[0][enforcementLevel]");

    let outcomes = await db.select().from(policySetOutcomes).where(eq(policySetOutcomes.policyEvaluationId, evalId));
    if (filterStatus) outcomes = outcomes.filter((o) => o.status === filterStatus);
    if (filterEnforcement) outcomes = outcomes.filter((o) => o.enforcementLevel === filterEnforcement);

    return {
      data: outcomes.map((o) => ({
        id: o.id,
        type: "policy-set-outcomes",
        attributes: {
          "policy-set-name": o.policySetName ?? "default-policy-set",
          "policy-name": o.policyName ?? "default-policy",
          "enforcement-level": o.enforcementLevel,
          status: o.status,
          query: o.query ?? "",
          description: o.description ?? "",
          error: o.error ?? null,
          overridable: Boolean(o.overridable),
          "result-count": o.resultCount ?? { passed: 1 },
        },
      })),
    };
  });
