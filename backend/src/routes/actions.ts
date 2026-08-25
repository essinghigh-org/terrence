import { Elysia } from "elysia";
import { db } from "../db";
import { actionInvocations, actions, organizationMemberships, runs, stacks, workspaces } from "../db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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

/** Whether the authenticated user may read resources belonging to the
 * workspace: mirrors the workspace "read" permission used by run reads. */
async function checkRunReadAccess(workspaceId: string, userId: string): Promise<boolean> {
  const { checkWorkspacePermission } = await import("../lib/utils");
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (workspace === undefined) return false;
  return await checkWorkspacePermission(workspace, userId, null, null, "read");
}

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
  .get("/api/v2/actions", async ({ user, request, set }: Ctx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as unknown as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const url = new URL(request.url);
    const orgName = url.searchParams.get("organization") ?? url.searchParams.get("filter[organization]") ?? "";
    const actionType = url.searchParams.get("filter[action-type]") ?? url.searchParams.get("action-type");
    let rows: (typeof actions.$inferSelect)[];
    if (orgName !== "") {
      const org = await cachedOrgByName(orgName);
      if (org === undefined || !(await checkOrganizationPermission(org.id, user.id, null, null, "read-workspaces"))) {
        return { data: [], meta: { pagination: { "current-page": 1, "total-pages": 0, "total-count": 0 } } };
      }
      const where = actionType !== null ? and(eq(actions.orgId, org.id), eq(actions.actionType, actionType)) : eq(actions.orgId, org.id);
      rows = await db.query.actions.findMany({ where, orderBy: [desc(actions.createdAt)] });
    } else {
      // Unscoped listing is restricted to the caller's own organizations,
      // and membership alone is not enough: each org must also grant the
      // caller workspace-read (matching the org-scoped path above).
      const memberships = await db.query.organizationMemberships.findMany({
        where: eq(organizationMemberships.userId, user.id),
        columns: { orgId: true },
      });
      const visibleOrgIds: string[] = [];
      for (const membership of memberships) {
        if (await checkOrganizationPermission(membership.orgId, user.id, null, null, "read-workspaces")) {
          visibleOrgIds.push(membership.orgId);
        }
      }
      const scoped = actionType !== null ? and(inArray(actions.orgId, visibleOrgIds), eq(actions.actionType, actionType)) : inArray(actions.orgId, visibleOrgIds);
      rows = await db.query.actions.findMany({
        where: visibleOrgIds.length > 0 ? scoped : sql`false`,
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
  .get("/api/v2/actions/:id", async ({ user, params, set }: Ctx): Promise<unknown> => {
    const id = params.id ?? "";
    if (user === null || user === undefined) {
      (set as unknown as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const row = await db.query.actions.findFirst({ where: eq(actions.id, id) });
    if (row === undefined || !(await checkOrganizationPermission(row.orgId, user.id, null, null, "read-workspaces"))) {
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
  .get("/api/v2/runs/:run_id/actions", async ({ params, user, set }: Ctx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    if (user === null || user === undefined) {
      (set as unknown as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    // The caller must be able to read the run itself; invocations inherit
    // that visibility (they can carry run-scoped output).
    const run = await db.query.runs.findFirst({
      where: eq(runs.id, runId),
      columns: { id: true, workspaceId: true },
    });
    if (run === undefined) {
      (set as { status: number }).status = 404;
      return { data: [], meta: { pagination: { "current-page": 1, "total-pages": 0, "total-count": 0 } } };
    }
    if (!(await checkRunReadAccess(run.workspaceId, user.id))) {
      (set as { status: number }).status = 404;
      return { data: [], meta: { pagination: { "current-page": 1, "total-pages": 0, "total-count": 0 } } };
    }
    const rows = await db.query.actionInvocations.findMany({ where: eq(actionInvocations.runId, runId), orderBy: [desc(actionInvocations.createdAt)] });
    const h = (set as { headers: Record<string, string | number> }).headers;
    (h)["TFP-API-Version"] = TFP_API_VERSION;
    return { data: rows.map(invocationResource), meta: { pagination: { "current-page": 1, "total-pages": 1, "total-count": rows.length } } };
  })
  .get("/api/v2/actions/:id/output", async ({ user, params, set }: Ctx): Promise<unknown> => {
    const id = params.id ?? "";
    if (user === null || user === undefined) {
      (set as unknown as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const action = await db.query.actions.findFirst({ where: eq(actions.id, id) });
    if (action !== undefined && !(await checkOrganizationPermission(action.orgId, user.id, null, null, "read-workspaces"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: `Action ${id} has no output` }] };
    }
    const invs = await db.query.actionInvocations.findMany({ where: eq(actionInvocations.actionId, id), orderBy: [desc(actionInvocations.createdAt)], limit: 1 });
    const latest = invs[0];
    if (latest?.output !== null && latest?.output !== undefined) {
      return { data: { type: "action-output", id: latest.id, attributes: { output: latest.output, status: latest.status } } };
    }
    const inv = await db.query.actionInvocations.findFirst({ where: eq(actionInvocations.id, id) });
    if (inv?.output !== null && inv?.output !== undefined) {
      // Invocation-ID fallback: the invocation's own org governs access.
      if (!(await checkOrganizationPermission(inv.orgId, user.id, null, null, "read-workspaces"))) {
        (set as { status: number }).status = 404;
        return { errors: [{ status: "404", title: "Not Found", detail: `Action ${id} has no output` }] };
      }
      return { data: { type: "action-output", id: inv.id, attributes: { output: inv.output, status: inv.status } } };
    }
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found", detail: `Action ${id} has no output` }] };
  })
  .get("/api/v2/stacks/:stack_id/actions", async ({ params, user, set }: Ctx): Promise<unknown> => {
    const stackId = params.stack_id ?? "";
    if (user === null || user === undefined) {
      (set as unknown as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const stack = await db.query.stacks.findFirst({ where: eq(stacks.id, stackId) });
    if (stack === undefined || !(await checkOrganizationPermission(stack.orgId, user.id, null, null, "read-workspaces"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const rows = await db.query.actionInvocations.findMany({ where: eq(actionInvocations.stackId, stackId), orderBy: [desc(actionInvocations.createdAt)] });
    const h = (set as { headers: Record<string, string | number> }).headers;
    (h)["TFP-API-Version"] = TFP_API_VERSION;
    return { data: rows.map(invocationResource), meta: { pagination: { "current-page": 1, "total-pages": 1, "total-count": rows.length } } };
  });
