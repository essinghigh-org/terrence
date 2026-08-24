import { Elysia } from "elysia";
import { db } from "../db";
import { actionInvocations, actions, runs, stacks } from "../db/schema";
import { and, desc, eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { TFP_API_VERSION } from "../lib/constants";
import { checkOrganizationPermission } from "../lib/utils";
import { cachedOrgByName } from "../lib/cached-lookups";

type Ctx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  user?: { id: string } | null;
  orgId?: string | null;
  teamId?: string | null;
  request: Readonly<{ url: string }>;
  set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
}>;

function actionResource(row: typeof actions.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    type: "actions",
    attributes: {
      name: row.name,
      description: row.description,
      "action-type": row.actionType,
      status: row.status,
      configuration: row.configuration,
      "created-at": new Date(row.createdAt).toISOString(),
      "updated-at": new Date(row.updatedAt).toISOString(),
    },
    relationships: { organization: { data: { id: row.orgId, type: "organizations" } } },
  };
}

function invocationResource(row: typeof actionInvocations.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    type: "action-invocations",
    attributes: {
      status: row.status,
      output: row.output,
      "error-message": row.errorMessage,
      "created-at": new Date(row.createdAt).toISOString(),
      "updated-at": new Date(row.updatedAt).toISOString(),
      "completed-at": row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
    },
    relationships: {
      action: { data: { id: row.actionId, type: "actions" } },
      ...(row.runId !== null ? { run: { data: { id: row.runId, type: "runs" } } } : {}),
      ...(row.stackId !== null ? { stack: { data: { id: row.stackId, type: "stacks" } } } : {}),
    },
  };
}

export const actionsRoutes = new Elysia({ name: "actions" })
  .use(authPlugin)
  .get("/api/v2/actions", async ({ request, set }: Ctx): Promise<unknown> => {
    const url = new URL(request.url);
    const orgName = url.searchParams.get("organization") ?? url.searchParams.get("filter[organization]") ?? "";
    const actionType = url.searchParams.get("filter[action-type]") ?? url.searchParams.get("action-type");
    let rows: (typeof actions.$inferSelect)[];
    if (orgName !== "") {
      const org = await cachedOrgByName(orgName);
      if (org === undefined) return { data: [], meta: { pagination: { "current-page": 1, "total-pages": 0, "total-count": 0 } } };
      const where = actionType !== null ? and(eq(actions.orgId, org.id), eq(actions.actionType, actionType)) : eq(actions.orgId, org.id);
      rows = await db.query.actions.findMany({ where, orderBy: [desc(actions.createdAt)] });
    } else {
      rows = await db.query.actions.findMany({
        where: actionType !== null ? eq(actions.actionType, actionType) : undefined,
        orderBy: [desc(actions.createdAt)],
        limit: 100,
      });
    }
    const h = (set as { headers: Record<string, string | number> }).headers;
    (h)["TFP-API-Version"] = TFP_API_VERSION;
    return { data: rows.map(actionResource), meta: { pagination: { "current-page": 1, "total-pages": 1, "total-count": rows.length } } };
  })
  .post("/api/v2/actions", async ({ body, user, orgId: tokenOrgId, teamId, set }: Ctx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data !== null && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : {};
    const attrs = data.attributes !== null && typeof data.attributes === "object" ? (data.attributes as Record<string, unknown>) : {};
    const rels = data.relationships !== null && typeof data.relationships === "object" ? (data.relationships as Record<string, unknown>) : {};
    const orgRel = rels.organization !== null && typeof rels.organization === "object" ? (rels.organization as Record<string, unknown>) : {};
    const orgData = orgRel.data !== null && typeof orgRel.data === "object" ? (orgRel.data as Record<string, unknown>) : {};
    const orgName = typeof orgData.id === "string" ? orgData.id : typeof attrs.organization === "string" ? String(attrs.organization) : "";
    const name = typeof attrs.name === "string" ? attrs.name.trim() : "";
    if (orgName === "" || name === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "organization and name are required" }] };
    }
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-workspaces"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const actionType = typeof attrs["action-type"] === "string" ? String(attrs["action-type"]) : "custom";
    const description = typeof attrs.description === "string" ? attrs.description : null;
    const configuration = attrs.configuration !== null && typeof attrs.configuration === "object" ? (attrs.configuration as Record<string, unknown>) : {};
    const id = `action-${crypto.randomUUID()}`;
    const now = Date.now();
    await db.insert(actions).values({ id, orgId: org.id, name, description, actionType, status: "active", configuration, createdAt: now, updatedAt: now });
    const row = await db.query.actions.findFirst({ where: eq(actions.id, id) });
    if (row === undefined) throw new Error("Created action could not be loaded");
    (set as { status: number }).status = 201;
    return { data: actionResource(row) };
  })
  .get("/api/v2/actions/:id", async ({ params, set }: Ctx): Promise<unknown> => {
    const id = params.id ?? "";
    const row = await db.query.actions.findFirst({ where: eq(actions.id, id) });
    if (row === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: `Action ${id} not found` }] };
    }
    return { data: actionResource(row) };
  })
  .delete("/api/v2/actions/:id", async ({ params, user, orgId: tokenOrgId, teamId, set }: Ctx): Promise<unknown> => {
    const id = params.id ?? "";
    const row = await db.query.actions.findFirst({ where: eq(actions.id, id) });
    if (row === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-workspaces"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(actions).where(eq(actions.id, id));
    (set as { status: number }).status = 204;
    return null;
  })
  .post("/api/v2/actions/:id/invocations", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: Ctx): Promise<unknown> => {
    const actionId = params.id ?? "";
    const action = await db.query.actions.findFirst({ where: eq(actions.id, actionId) });
    if (action === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrganizationPermission(action.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-workspaces"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data !== null && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : {};
    const attrs = data.attributes !== null && typeof data.attributes === "object" ? (data.attributes as Record<string, unknown>) : {};
    const runId = typeof attrs["run-id"] === "string" ? String(attrs["run-id"]) : typeof attrs.runId === "string" ? String(attrs.runId) : null;
    const stackId = typeof attrs["stack-id"] === "string" ? String(attrs["stack-id"]) : typeof attrs.stackId === "string" ? String(attrs.stackId) : null;
    if (runId !== null) {
      const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
      if (run === undefined) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "run not found" }] };
      }
    }
    if (stackId !== null) {
      const stack = await db.query.stacks.findFirst({ where: eq(stacks.id, stackId) });
      if (stack === undefined) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "stack not found" }] };
      }
    }
    const id = `actinv-${crypto.randomUUID()}`;
    const now = Date.now();
    const output = attrs.output !== null && typeof attrs.output === "object" ? (attrs.output as Record<string, unknown>) : null;
    await db.insert(actionInvocations).values({
      id,
      actionId,
      orgId: action.orgId,
      runId,
      stackId,
      deploymentId: typeof attrs.deploymentId === "string" ? String(attrs.deploymentId) : null,
      status: "pending",
      output,
      createdAt: now,
      updatedAt: now,
    });
    const row = await db.query.actionInvocations.findFirst({ where: eq(actionInvocations.id, id) });
    if (row === undefined) throw new Error("Created invocation could not be loaded");
    (set as { status: number }).status = 201;
    return { data: invocationResource(row) };
  })
  .get("/api/v2/runs/:run_id/actions", async ({ params, set }: Ctx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const rows = await db.query.actionInvocations.findMany({ where: eq(actionInvocations.runId, runId), orderBy: [desc(actionInvocations.createdAt)] });
    const h = (set as { headers: Record<string, string | number> }).headers;
    (h)["TFP-API-Version"] = TFP_API_VERSION;
    return { data: rows.map(invocationResource), meta: { pagination: { "current-page": 1, "total-pages": 1, "total-count": rows.length } } };
  })
  .get("/api/v2/actions/:id/output", async ({ params, set }: Ctx): Promise<unknown> => {
    const id = params.id ?? "";
    const action = await db.query.actions.findFirst({ where: eq(actions.id, id) });
    if (action !== undefined) {
      const invs = await db.query.actionInvocations.findMany({ where: eq(actionInvocations.actionId, id), orderBy: [desc(actionInvocations.createdAt)], limit: 1 });
      const latest = invs[0];
      if (latest?.output !== null && latest?.output !== undefined) {
        return { data: { type: "action-output", id: latest.id, attributes: { output: latest.output, status: latest.status } } };
      }
    }
    const inv = await db.query.actionInvocations.findFirst({ where: eq(actionInvocations.id, id) });
    if (inv?.output !== null && inv?.output !== undefined) {
      return { data: { type: "action-output", id: inv.id, attributes: { output: inv.output, status: inv.status } } };
    }
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found", detail: `Action ${id} has no output` }] };
  })
  .get("/api/v2/stacks/:stack_id/actions", async ({ params, set }: Ctx): Promise<unknown> => {
    const stackId = params.stack_id ?? "";
    const rows = await db.query.actionInvocations.findMany({ where: eq(actionInvocations.stackId, stackId), orderBy: [desc(actionInvocations.createdAt)] });
    const h = (set as { headers: Record<string, string | number> }).headers;
    (h)["TFP-API-Version"] = TFP_API_VERSION;
    return { data: rows.map(invocationResource), meta: { pagination: { "current-page": 1, "total-pages": 1, "total-count": rows.length } } };
  });
