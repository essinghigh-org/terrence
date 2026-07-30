import { Elysia } from "elysia";
import { db } from "../db";
import { queryRuns, workspaces, type users } from "../db/schema";
import { eq, count, desc } from "drizzle-orm";
import { authPlugin } from "../auth";
import { findAuthorizedWorkspace, pageRequest, pagination } from "../lib/utils";

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

type QueryRunItem = Readonly<typeof queryRuns.$inferSelect>;

function queryResource(q: QueryRunItem): Record<string, unknown> {
  return {
    id: q.id,
    type: "query-runs",
    attributes: {
      source: q.source,
      variables: q.variables ?? {},
      status: q.status,
      "log-read-url": q.logReadUrl,
      "status-timestamps": q.statusTimestamps ?? {},
      "created-at": new Date(q.createdAt).toISOString(),
    },
    relationships: {
      workspace: { data: { id: q.workspaceId, type: "workspaces" } },
      "created-by": q.createdBy ? { data: { id: q.createdBy, type: "users" } } : { data: null },
      "canceled-by": q.canceledBy ? { data: { id: q.canceledBy, type: "users" } } : { data: null },
    },
  };
}

export const queryRoutes = new Elysia({ name: "queries" })
  .use(authPlugin)
  .post("/api/v2/queries", async ({ user, body, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes: Record<string, unknown> = (data?.attributes ?? {}) as Record<string, unknown>;
    const rels: Record<string, unknown> = (data?.relationships ?? {}) as Record<string, unknown>;
    const wsRel = rels.workspace as Record<string, unknown> | undefined;
    const workspaceId = typeof (wsRel?.data as Record<string, unknown> | undefined)?.id === "string" ? ((wsRel?.data as Record<string, unknown>).id as string) : "";

    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user.id, orgId, teamId)) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const id = `qr-${crypto.randomUUID()}`;
    const q: QueryRunItem = {
      id,
      workspaceId: ws.id,
      source: typeof attributes.source === "string" ? attributes.source : "tfe-api",
      variables: (attributes.variables as Record<string, unknown>) ?? null,
      status: "pending",
      logReadUrl: `/api/v2/queries/${id}/log`,
      statusTimestamps: { "pending-at": new Date().toISOString() },
      createdBy: user.id,
      canceledBy: null,
      createdAt: Date.now(),
    };

    await db.insert(queryRuns).values(q);
    (set as { status: number }).status = 201;
    return { data: queryResource(q) };
  })
  .get("/api/v2/workspaces/:workspace_id/queries", async ({ params, user, request, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, params.workspace_id ?? "") });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, orgId, teamId)) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const total = (await db.select({ value: count() }).from(queryRuns).where(eq(queryRuns.workspaceId, ws.id)))[0]?.value ?? 0;
    const queries = await db.query.queryRuns.findMany({
      where: eq(queryRuns.workspaceId, ws.id),
      orderBy: [desc(queryRuns.createdAt)],
      offset: (number - 1) * size,
      limit: size,
    });
    return { data: queries.map((q) => queryResource(q)), ...pagination(request, number, size, total) };
  })
  .get("/api/v2/queries/:query_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const q = await db.query.queryRuns.findFirst({ where: eq(queryRuns.id, params.query_id ?? "") });
    if (q === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, q.workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, orgId, teamId)) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: queryResource(q) };
  })
  .post("/api/v2/queries/:query_id/actions/cancel", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const id = params.query_id ?? "";
    const q = await db.query.queryRuns.findFirst({ where: eq(queryRuns.id, id) });
    if (q === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, q.workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user.id, orgId, teamId)) === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const timestamps = { ...(q.statusTimestamps ?? {}), "canceled-at": new Date().toISOString() };
    await db.update(queryRuns).set({ status: "canceled", canceledBy: user.id, statusTimestamps: timestamps }).where(eq(queryRuns.id, id));
    const updated = await db.query.queryRuns.findFirst({ where: eq(queryRuns.id, id) });
    return { data: queryResource(updated!) };
  });
