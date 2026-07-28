import { count, desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { authPlugin } from "../auth";
import { db } from "../db";
import { changeRequests, type users, workspaces } from "../db/schema";
import { checkOrgPermission, pageRequest, pagination } from "../lib/utils";

type SetObject = Readonly<{
  status?: number | string;
  headers: Readonly<Record<string, string | number>>;
}>;

type Context = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  request: Readonly<{ url: string }>;
  set: SetObject;
}>;

type ChangeRequest = Readonly<typeof changeRequests.$inferSelect>;
type Workspace = Readonly<typeof workspaces.$inferSelect>;

function errorResponse(set: SetObject, status: number, title: string, detail?: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  return {
    errors: [{
      status: String(status),
      title,
      ...(detail === undefined ? {} : { detail }),
    }],
  };
}

function resource(changeRequest: ChangeRequest): Record<string, unknown> {
  return {
    id: changeRequest.id,
    type: "workspace-change-requests",
    attributes: {
      subject: changeRequest.subject,
      message: changeRequest.message,
      status: changeRequest.status,
      "archived-by": changeRequest.status === "approved" ? changeRequest.resolvedBy : null,
      "archived-at": changeRequest.status === "approved" && changeRequest.resolvedAt !== null
        ? new Date(changeRequest.resolvedAt).toISOString()
        : null,
      "resolved-by": changeRequest.resolvedBy,
      "resolved-at": changeRequest.resolvedAt === null ? null : new Date(changeRequest.resolvedAt).toISOString(),
      "created-at": new Date(changeRequest.createdAt).toISOString(),
      "updated-at": new Date(changeRequest.updatedAt).toISOString(),
    },
    relationships: {
      workspace: { data: { id: changeRequest.workspaceId, type: "workspaces" } },
      creator: { data: changeRequest.createdBy === null ? null : { id: changeRequest.createdBy, type: "users" } },
    },
    links: { self: `/api/v2/change-requests/${changeRequest.id}` },
  };
}

async function authorizedWorkspace(
  identifier: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  role: "owner" | "member" = "member",
): Promise<Workspace | undefined> {
  const byId = await db.query.workspaces.findFirst({ where: eq(workspaces.id, identifier) });
  if (byId !== undefined && await checkOrgPermission(userId, byId.orgId, role, tokenOrgId)) return byId;
  const byName = await db.query.workspaces.findMany({ where: eq(workspaces.name, identifier) });
  for (const workspace of byName) {
    if (await checkOrgPermission(userId, workspace.orgId, role, tokenOrgId)) return workspace;
  }
  return undefined;
}

async function authorizedChangeRequest(
  id: string,
  userId: string | undefined,
  tokenOrgId: string | null,
): Promise<ChangeRequest | undefined> {
  const changeRequest = await db.query.changeRequests.findFirst({ where: eq(changeRequests.id, id) });
  if (changeRequest === undefined) return undefined;
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, changeRequest.workspaceId) });
  if (workspace === undefined || !(await checkOrgPermission(userId, workspace.orgId, "member", tokenOrgId))) return undefined;
  return changeRequest;
}

async function resolveChangeRequest(
  id: string,
  status: "approved" | "discarded",
  userId: string | undefined,
  tokenOrgId: string | null,
  set: SetObject,
): Promise<unknown> {
  const changeRequest = await authorizedChangeRequest(id, userId, tokenOrgId);
  if (changeRequest === undefined) return errorResponse(set, 404, "Not Found");
  if (changeRequest.status !== "pending") {
    return errorResponse(set, 409, "Conflict", "Change request is already resolved");
  }
  const now = Date.now();
  await db.update(changeRequests).set({
    status,
    resolvedBy: userId ?? null,
    resolvedAt: now,
    updatedAt: now,
  }).where(eq(changeRequests.id, id));
  const updated = await db.query.changeRequests.findFirst({ where: eq(changeRequests.id, id) });
  if (updated === undefined) return errorResponse(set, 404, "Not Found");
  return { data: resource(updated) };
}

export const changeRequestRoutes = new Elysia({ name: "change-requests" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/change-requests", async ({ params, user, orgId, request, set }: Context): Promise<unknown> => {
    const workspace = await authorizedWorkspace(params["workspace_id"] ?? "", user?.id, orgId ?? null);
    if (workspace === undefined) return errorResponse(set, 404, "Not Found");
    const { number, size } = pageRequest(request);
    const [rows, counts] = await Promise.all([
      db.query.changeRequests.findMany({
        where: eq(changeRequests.workspaceId, workspace.id),
        orderBy: [desc(changeRequests.createdAt)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(changeRequests).where(eq(changeRequests.workspaceId, workspace.id)),
    ]);
    return {
      data: rows.map(resource),
      ...pagination(request, number, size, counts[0]?.total ?? 0),
    };
  })
  .post("/api/v2/workspaces/:workspace_id/change-requests", async ({ params, body, user, orgId, set }: Context): Promise<unknown> => {
    const workspace = await authorizedWorkspace(params["workspace_id"] ?? "", user?.id, orgId ?? null, "owner");
    if (workspace === undefined) return errorResponse(set, 404, "Not Found");
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload["data"];
    const attributes = data !== null && typeof data === "object"
      && (data as Record<string, unknown>)["attributes"] !== null
      && typeof (data as Record<string, unknown>)["attributes"] === "object"
      ? (data as Record<string, unknown>)["attributes"] as Record<string, unknown>
      : {};
    const subject = typeof attributes["subject"] === "string" ? attributes["subject"].trim() : "";
    const message = typeof attributes["message"] === "string" ? attributes["message"].trim() : "";
    if (subject === "" || message === "") {
      return errorResponse(set, 422, "Unprocessable Entity", "Subject and message are required");
    }
    const now = Date.now();
    const changeRequest = {
      id: `wscr-${crypto.randomUUID()}`,
      workspaceId: workspace.id,
      subject,
      message,
      status: "pending",
      createdBy: user?.id ?? null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    } satisfies typeof changeRequests.$inferInsert;
    await db.insert(changeRequests).values(changeRequest);
    (set as { status: number }).status = 201;
    return { data: resource(changeRequest) };
  })
  .get("/api/v2/change-requests/:change_request_id", async ({ params, user, orgId, set }: Context): Promise<unknown> => {
    const changeRequest = await authorizedChangeRequest(params["change_request_id"] ?? "", user?.id, orgId ?? null);
    return changeRequest === undefined ? errorResponse(set, 404, "Not Found") : { data: resource(changeRequest) };
  })
  .get("/api/v2/workspaces/change-requests/:change_request_id", async ({ params, user, orgId, set }: Context): Promise<unknown> => {
    const changeRequest = await authorizedChangeRequest(params["change_request_id"] ?? "", user?.id, orgId ?? null);
    return changeRequest === undefined ? errorResponse(set, 404, "Not Found") : { data: resource(changeRequest) };
  })
  .post("/api/v2/change-requests/:change_request_id/actions/approve", async ({ params, user, orgId, set }: Context): Promise<unknown> =>
    resolveChangeRequest(params["change_request_id"] ?? "", "approved", user?.id, orgId ?? null, set))
  .post("/api/v2/change-requests/:change_request_id/actions/discard", async ({ params, user, orgId, set }: Context): Promise<unknown> =>
    resolveChangeRequest(params["change_request_id"] ?? "", "discarded", user?.id, orgId ?? null, set))
  .patch("/api/v2/workspaces/change-requests/:change_request_id", async ({ params, user, orgId, set }: Context): Promise<unknown> =>
    resolveChangeRequest(params["change_request_id"] ?? "", "approved", user?.id, orgId ?? null, set));
