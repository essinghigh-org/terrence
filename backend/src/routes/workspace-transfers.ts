import { Elysia } from "elysia";
import { db } from "../db";
import { workspaceTransfers, workspaces, organizations, projects, type users } from "../db/schema";
import { eq, count, desc } from "drizzle-orm";
import { authPlugin } from "../auth";
import { pageRequest, pagination, checkOrgPermission } from "../lib/utils";

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

type WorkspaceTransferItem = Readonly<typeof workspaceTransfers.$inferSelect>;

function transferResource(t: WorkspaceTransferItem): Record<string, unknown> {
  return {
    id: t.id,
    type: "workspace-transfers",
    attributes: {
      "approval-mode": t.approvalMode,
      "cleanup-on-failure": t.cleanupOnFailure,
      "history-cutoff": t.historyCutoff,
      "policy-set-mode": t.policySetMode,
      "variable-mode": t.variableMode,
      "workspace-prefix": t.workspacePrefix,
      "workspace-suffix": t.workspaceSuffix,
      status: t.status,
      "pause-reason": t.pauseReason,
      "created-at": new Date(t.createdAt).toISOString(),
      "updated-at": new Date(t.updatedAt).toISOString(),
    },
    relationships: {
      "source-workspace": t.sourceWorkspaceId ? { data: { id: t.sourceWorkspaceId, type: "workspaces" } } : { data: null },
      "destination-organization": t.destinationOrgId ? { data: { id: t.destinationOrgId, type: "organizations" } } : { data: null },
      "destination-project": t.destinationProjectId ? { data: { id: t.destinationProjectId, type: "projects" } } : { data: null },
    },
  };
}

export const workspaceTransferRoutes = new Elysia({ name: "workspace-transfers" })
  .use(authPlugin)
  .post("/api/v2/workspace-transfers", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};
    const rels = (data?.relationships as Record<string, unknown>) ?? {};

    const srcWsRel = rels["source-workspace"] as Record<string, unknown> | undefined;
    const destOrgRel = rels["destination-organization"] as Record<string, unknown> | undefined;
    const destProjRel = rels["destination-project"] as Record<string, unknown> | undefined;

    const sourceWorkspaceId = typeof (srcWsRel?.data as Record<string, unknown>)?.id === "string" ? ((srcWsRel?.data as Record<string, unknown>).id as string) : null;
    const destinationOrgId = typeof (destOrgRel?.data as Record<string, unknown>)?.id === "string" ? ((destOrgRel?.data as Record<string, unknown>).id as string) : null;
    const destinationProjectId = typeof (destProjRel?.data as Record<string, unknown>)?.id === "string" ? ((destProjRel?.data as Record<string, unknown>).id as string) : null;

    const id = `wt-${crypto.randomUUID()}`;
    const transfer: WorkspaceTransferItem = {
      id,
      sourceWorkspaceId,
      destinationOrgId,
      destinationProjectId,
      approvalMode: typeof attributes["approval-mode"] === "string" ? attributes["approval-mode"] : "auto",
      cleanupOnFailure: typeof attributes["cleanup-on-failure"] === "boolean" ? attributes["cleanup-on-failure"] : true,
      historyCutoff: typeof attributes["history-cutoff"] === "string" ? attributes["history-cutoff"] : null,
      policySetMode: typeof attributes["policy-set-mode"] === "string" ? attributes["policy-set-mode"] : "move",
      variableMode: typeof attributes["variable-mode"] === "string" ? attributes["variable-mode"] : "move",
      workspacePrefix: typeof attributes["workspace-prefix"] === "string" ? attributes["workspace-prefix"] : null,
      workspaceSuffix: typeof attributes["workspace-suffix"] === "string" ? attributes["workspace-suffix"] : null,
      status: "pending",
      pauseReason: null,
      createdBy: user.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await db.insert(workspaceTransfers).values(transfer);
    (set as { status: number }).status = 201;
    return { data: transferResource(transfer) };
  })
  .get("/api/v2/workspace-transfers", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const { number, size } = pageRequest(request);
    const total = (await db.select({ value: count() }).from(workspaceTransfers))[0]?.value ?? 0;
    const items = await db.query.workspaceTransfers.findMany({
      orderBy: [desc(workspaceTransfers.createdAt)],
      offset: (number - 1) * size,
      limit: size,
    });
    return {
      data: items.map((t) => transferResource(t)),
      ...pagination(request, number, size, total),
    };
  })
  .get("/api/v2/workspace-transfers/:transfer_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const transfer = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, params.transfer_id ?? "") });
    if (transfer === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: transferResource(transfer) };
  })
  .post("/api/v2/workspace-transfers/:transfer_id/actions/cancel", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const id = params.transfer_id ?? "";
    const transfer = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, id) });
    if (transfer === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(workspaceTransfers).set({ status: "canceled", updatedAt: Date.now() }).where(eq(workspaceTransfers.id, id));
    const updated = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, id) });
    return { data: transferResource(updated!) };
  })
  .post("/api/v2/workspace-transfers/:transfer_id/actions/resume", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const id = params.transfer_id ?? "";
    const transfer = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, id) });
    if (transfer === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(workspaceTransfers).set({ status: "running", pauseReason: null, updatedAt: Date.now() }).where(eq(workspaceTransfers.id, id));
    const updated = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, id) });
    return { data: transferResource(updated!) };
  });
