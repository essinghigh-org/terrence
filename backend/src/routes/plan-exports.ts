import { Elysia } from "elysia";
import { db } from "../db";
import { planExports, type users } from "../db/schema";
import { eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { findAuthorizedRun } from "../lib/utils";
import { readPlanJsonArtifact } from "../lib/plan-json";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

type PlanExportItem = Readonly<typeof planExports.$inferSelect>;

function planExportResource(pe: PlanExportItem): Record<string, unknown> {
  return {
    id: pe.id,
    type: "plan-exports",
    attributes: {
      "data-type": pe.dataType,
      status: pe.status,
      "created-at": new Date(pe.createdAt).toISOString(),
    },
    relationships: {
      plan: { data: { id: pe.planId, type: "plans" } },
    },
    links: {
      self: `/api/v2/plan-exports/${pe.id}`,
    },
  };
}

export const planExportRoutes = new Elysia({ name: "plan-exports" })
  .use(authPlugin)
  .post("/api/v2/plan-exports", async ({ user, body, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes: Record<string, unknown> = (data?.attributes ?? {}) as Record<string, unknown>;
    const rels: Record<string, unknown> = (data?.relationships ?? {}) as Record<string, unknown>;
    const planRel = rels.plan as Record<string, unknown> | undefined;
    const planId = typeof (planRel?.data as Record<string, unknown> | undefined)?.id === "string" ? ((planRel?.data as Record<string, unknown>).id as string) : "";

    if (planId === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "plan ID is required" }] };
    }

    const runId = planId.replace(/^plan-/, "");
    const authorized = await findAuthorizedRun(runId, user.id, orgId, teamId);
    if (authorized === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const id = `pe-${crypto.randomUUID()}`;
    const pe: PlanExportItem = {
      id,
      planId,
      dataType: typeof attributes["data-type"] === "string" ? attributes["data-type"] : "sentinel-mock-bundle-v0",
      status: "finished",
      downloadUrl: `/api/v2/plan-exports/${id}/download`,
      expiresAt: Date.now() + 3600 * 1000,
      createdAt: Date.now(),
    };

    await db.insert(planExports).values(pe);
    (set as { status: number }).status = 201;
    return { data: planExportResource(pe) };
  })
  .get("/api/v2/plan-exports/:export_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const pe = await db.query.planExports.findFirst({ where: eq(planExports.id, params.export_id ?? "") });
    if (pe === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const runId = pe.planId.replace(/^plan-/, "");
    const authorized = await findAuthorizedRun(runId, user.id, orgId, teamId);
    if (authorized === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: planExportResource(pe) };
  })
  .get("/api/v2/plan-exports/:export_id/download", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const pe = await db.query.planExports.findFirst({ where: eq(planExports.id, params.export_id ?? "") });
    if (pe === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const runId = pe.planId.replace(/^plan-/, "");
    const authorized = await findAuthorizedRun(runId, user.id, orgId, teamId);
    if (authorized === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (pe.expiresAt !== null && pe.expiresAt <= Date.now()) {
      (set as { status: number }).status = 410;
      return { errors: [{ status: "410", title: "Gone", detail: "Plan export has expired" }] };
    }
    const plan = await readPlanJsonArtifact(runId);
    if (plan === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "Plan export artifact is unavailable" }] };
    }
    const headers = set.headers as Record<string, string | number>;
    headers["Content-Type"] = "application/json";
    headers["Content-Disposition"] = `attachment; filename=plan-export-${pe.id}.json`;
    return new Response(JSON.stringify({ version: 1, dataType: pe.dataType, planId: pe.planId, plan }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename=plan-export-${pe.id}.json` },
    });
  });
