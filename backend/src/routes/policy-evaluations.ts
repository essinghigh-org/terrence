import { Elysia } from "elysia";
import { db } from "../db";
import { policyEvaluations, policySetOutcomes, taskStages, type users } from "../db/schema";
import { and, count, eq, inArray } from "drizzle-orm";
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

/** Audit finding 3: TF-policy resource matching go-tfe's TFPolicyEvaluation
 * shape (the type the CLI decodes). Stage-type derives from the linked task
 * stage; omitted when unknown so the CLI filters it out instead of
 * misattributing it. */
export type TFPolicyStageType = "Init" | "Plan" | "Apply";

export function tfStageTypeForTaskStage(taskStage: string | null | undefined): TFPolicyStageType | undefined {
  if (taskStage === "pre_plan" || taskStage === "post_plan") return "Plan";
  if (taskStage === "pre_apply" || taskStage === "post_apply") return "Apply";
  return undefined;
}

async function tfStageTypeForEvaluation(
  evalRecord: Readonly<typeof policyEvaluations.$inferSelect>,
): Promise<TFPolicyStageType | undefined> {
  if (evalRecord.taskStageId === null) return undefined;
  const stage = (await db.select().from(taskStages).where(eq(taskStages.id, evalRecord.taskStageId)))[0];
  return tfStageTypeForTaskStage(stage?.stage);
}

/** Batch stage-type resolution for sideloads (one query, no N+1). */
export async function tfStageTypesForEvaluations(
  evalRecords: readonly Readonly<typeof policyEvaluations.$inferSelect>[],
): Promise<ReadonlyMap<string, TFPolicyStageType>> {
  const stageIds = [...new Set(evalRecords.flatMap((evalRecord): string[] =>
    evalRecord.taskStageId === null ? [] : [evalRecord.taskStageId]))];
  if (stageIds.length === 0) return new Map();
  const stages = await db.select().from(taskStages).where(inArray(taskStages.id, stageIds));
  const stageById = new Map(stages.map((stage): [string, string] => [stage.id, stage.stage]));
  const result = new Map<string, TFPolicyStageType>();
  for (const evalRecord of evalRecords) {
    const stageType = evalRecord.taskStageId === null
      ? undefined
      : tfStageTypeForTaskStage(stageById.get(evalRecord.taskStageId));
    if (stageType !== undefined) result.set(evalRecord.id, stageType);
  }
  return result;
}

export function tfPolicyEvaluationResource(
  evalRecord: Readonly<typeof policyEvaluations.$inferSelect>,
  stageType?: TFPolicyStageType,
): Record<string, unknown> {
  return {
    id: evalRecord.id,
    type: "tf-policy-evaluations",
    attributes: {
      status: evalRecord.status,
      ...(stageType === undefined ? {} : { "stage-type": stageType }),
      "status-timestamps": evalRecord.statusTimestamps ?? {},
      "result-count": evalRecord.resultCount ?? {},
      "created-at": new Date(evalRecord.createdAt).toISOString(),
    },
    relationships: {
      run: evalRecord.runId ? { data: { id: evalRecord.runId, type: "runs" } } : { data: null },
    },
    links: { self: `/api/v2/tf-policy-evaluations/${evalRecord.id}` },
  };
}

/** Audit finding 3: one stored per-policy row translates to one outcome
 * entry — the row IS the outcome, so the CLI counts and renders hold. */
export function tfPolicySetOutcomeResource(
  outcome: Readonly<typeof policySetOutcomes.$inferSelect>,
): Record<string, unknown> {
  return {
    id: outcome.id,
    type: "tf-policy-set-outcomes",
    attributes: {
      outcomes: [
        {
          policy_name: outcome.policyName ?? "default-policy",
          status: outcome.status,
          description: outcome.description ?? "",
          enforcement_level: outcome.enforcementLevel,
        },
      ],
      error: outcome.error ?? null,
      overridable: outcome.overridable === true,
      "policy-set-name": outcome.policySetName ?? "default-policy-set",
      "result-count": outcome.resultCount ?? {},
    },
    links: { self: `/api/v2/tf-policy-set-outcomes/${outcome.id}` },
  };
}

export const policyEvaluationRoutes = new Elysia({ name: "policyEvaluations" })
  .use(authPlugin)
  .get("/api/v2/task-stages/:task_stage_id/policy-evaluations", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const stageId = params["task_stage_id"] ?? "";
    const stage = (await db.select().from(taskStages).where(eq(taskStages.id, stageId)))[0];
    if (stage === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(stage.runId, user?.id, orgId, teamId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }

    const evals = await db.select().from(policyEvaluations).where(eq(policyEvaluations.taskStageId, stage.id));
    return { data: evals.map(evaluationResource) };
  })
  .get("/api/v2/policy-evaluations/:policy_evaluation_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const evalId = params["policy_evaluation_id"] ?? "";
    const evalRecord = (await db.select().from(policyEvaluations).where(eq(policyEvaluations.id, evalId)))[0];
    if (evalRecord === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (evalRecord.runId !== null && evalRecord.runId !== undefined) {
      const authorized = await findAuthorizedRun(evalRecord.runId, user?.id, orgId, teamId);
      if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    }

    return { data: evaluationResource(evalRecord) };
  })
  .get("/api/v2/policy-evaluations/:policy_evaluation_id/policy-set-outcomes", async ({ params, request, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const evalId = params["policy_evaluation_id"] ?? "";
    const evalRecord = (await db.select().from(policyEvaluations).where(eq(policyEvaluations.id, evalId)))[0];
    if (evalRecord === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (evalRecord.runId !== null && evalRecord.runId !== undefined) {
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
  })
  .get("/api/v2/policy-set-outcomes/:policy_set_outcome_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const outcomeId = params["policy_set_outcome_id"] ?? "";
    const outcome = (await db.select().from(policySetOutcomes).where(eq(policySetOutcomes.id, outcomeId)))[0];
    if (outcome === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const evaluation = (await db.select().from(policyEvaluations).where(eq(policyEvaluations.id, outcome.policyEvaluationId)))[0];
    if (evaluation === undefined || evaluation.runId === null || (await findAuthorizedRun(evaluation.runId, user?.id, orgId, teamId)) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: outcome.id,
        type: "policy-set-outcomes",
        attributes: {
          "policy-set-name": outcome.policySetName ?? "default-policy-set",
          "policy-name": outcome.policyName ?? "default-policy",
          "enforcement-level": outcome.enforcementLevel,
          status: outcome.status,
          query: outcome.query ?? "",
          description: outcome.description ?? "",
          error: outcome.error ?? null,
          overridable: Boolean(outcome.overridable),
          "result-count": outcome.resultCount ?? { passed: 1 },
        },
        relationships: { "policy-evaluation": { data: { id: evaluation.id, type: "policy-evaluations" } } },
      },
    };
  })
  .get("/api/v2/tf-policy-evaluations/:tf_policy_evaluation_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const evalId = params["tf_policy_evaluation_id"] ?? "";
    const evalRecord = (await db.select().from(policyEvaluations).where(eq(policyEvaluations.id, evalId)))[0];
    if (evalRecord === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (evalRecord.runId !== null && evalRecord.runId !== undefined) {
      const authorized = await findAuthorizedRun(evalRecord.runId, user?.id, orgId, teamId);
      if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    }
    return { data: tfPolicyEvaluationResource(evalRecord, await tfStageTypeForEvaluation(evalRecord)) };
  })
  .get("/api/v2/tf-policy-evaluations/:tf_policy_evaluation_id/tf-policy-set-outcomes", async ({ params, request, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    // Audit finding 3: the exact path go-tfe TFPolicyEvaluationOutcomes.List
    // GETs (with page + filter[status]/filter[enforcement-level] support) so
    // the CLI renders per-stage TF policy outcomes instead of skipping them.
    const evalId = params["tf_policy_evaluation_id"] ?? "";
    const evalRecord = (await db.select().from(policyEvaluations).where(eq(policyEvaluations.id, evalId)))[0];
    if (evalRecord === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (evalRecord.runId !== null && evalRecord.runId !== undefined) {
      const authorized = await findAuthorizedRun(evalRecord.runId, user?.id, orgId, teamId);
      if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    }
    const url = new URL(request.url);
    const filterStatus = url.searchParams.get("filter[status]");
    const filterEnforcement = url.searchParams.get("filter[enforcement-level]") ?? url.searchParams.get("filter[enforcementLevel]");
    const pageParam = Number.parseInt(url.searchParams.get("page[number]") ?? "1", 10);
    const sizeParam = Number.parseInt(url.searchParams.get("page[size]") ?? "20", 10);
    const pageNumber = Number.isSafeInteger(pageParam) && pageParam > 0 ? pageParam : 1;
    const pageSize = Number.isSafeInteger(sizeParam) && sizeParam > 0 ? Math.min(sizeParam, 100) : 20;
    const conditions = [eq(policySetOutcomes.policyEvaluationId, evalId)];
    if (filterStatus !== null && filterStatus !== "") conditions.push(eq(policySetOutcomes.status, filterStatus));
    if (filterEnforcement !== null && filterEnforcement !== "") conditions.push(eq(policySetOutcomes.enforcementLevel, filterEnforcement));
    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      db.select().from(policySetOutcomes).where(where).limit(pageSize).offset((pageNumber - 1) * pageSize),
      db.select({ total: count() }).from(policySetOutcomes).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    return {
      data: rows.map(tfPolicySetOutcomeResource),
      meta: {
        pagination: {
          "current-page": pageNumber,
          "page-size": pageSize,
          "total-pages": totalPages,
          "total-count": totalCount,
        },
      },
    };
  })
  .get("/api/v2/runs/:run_id/tf-policy-evaluations", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId, teamId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const evals = await db.select().from(policyEvaluations).where(eq(policyEvaluations.runId, runId));
    const stageTypes = await tfStageTypesForEvaluations(evals);
    return {
      data: evals.map((evalRecord): Record<string, unknown> =>
        tfPolicyEvaluationResource(evalRecord, stageTypes.get(evalRecord.id))),
    };
  })
  .get("/api/v2/tf-policy-set-outcomes/:tf_policy_set_outcome_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const outcomeId = params["tf_policy_set_outcome_id"] ?? "";
    const outcome = (await db.select().from(policySetOutcomes).where(eq(policySetOutcomes.id, outcomeId)))[0];
    if (outcome === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const evaluation = (await db.select().from(policyEvaluations).where(eq(policyEvaluations.id, outcome.policyEvaluationId)))[0];
    if (evaluation === undefined || evaluation.runId === null || (await findAuthorizedRun(evaluation.runId, user?.id, orgId, teamId)) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: tfPolicySetOutcomeResource(outcome) };
  });
