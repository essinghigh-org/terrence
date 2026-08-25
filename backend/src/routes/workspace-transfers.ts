import { Elysia } from "elysia";
import { db } from "../db";
import { workspaceTransfers, workspaces, organizationMemberships, organizations, projects, type users } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { authPlugin } from "../auth";
import { checkOrgPermission, checkWorkspacePermission, findAuthorizedWorkspace, pageRequest, pagination } from "../lib/utils";
import { organizationName } from "../lib/response";

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

/** Resolve the orgs a transfer touches: the source workspace's org and the
 * destination org. Either side may be null on legacy/partial records. */
async function transferOrgIds(transfer: WorkspaceTransferItem): Promise<{ sourceOrgId: string | null; destinationOrgId: string | null }> {
  const sourceOrgId = transfer.sourceWorkspaceId !== null
    ? (await db.query.workspaces.findFirst({ where: eq(workspaces.id, transfer.sourceWorkspaceId), columns: { orgId: true } }))?.orgId ?? null
    : null;
  return { sourceOrgId, destinationOrgId: transfer.destinationOrgId };
}

/** Whether the principal may see or act on this transfer: site admins can,
 * as can members of either the source workspace's org or the destination
 * organization. Transfers move state, variables, and policy sets between
 * orgs, so their existence and shape are sensitive across that boundary. */
async function canSeeTransfer(user: NonNullable<ParamCtx["user"]>, transfer: WorkspaceTransferItem): Promise<boolean> {
  if (user.isSiteAdmin === true) return true;
  const memberships = await db.query.organizationMemberships.findMany({
    where: eq(organizationMemberships.userId, user.id),
    columns: { orgId: true },
  });
  const memberOrgIds = new Set(memberships.map((membership): string => membership.orgId));
  const { sourceOrgId, destinationOrgId } = await transferOrgIds(transfer);
  return (sourceOrgId !== null && memberOrgIds.has(sourceOrgId))
    || (destinationOrgId !== null && memberOrgIds.has(destinationOrgId));
}

async function transferResource(t: WorkspaceTransferItem): Promise<Record<string, unknown>> {
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
      "destination-organization": t.destinationOrgId ? { data: { id: (await organizationName(t.destinationOrgId)) ?? t.destinationOrgId, type: "organizations" } } : { data: null },
      "destination-project": t.destinationProjectId ? { data: { id: t.destinationProjectId, type: "projects" } } : { data: null },
    },
  };
}

export const workspaceTransferRoutes = new Elysia({ name: "workspace-transfers" })
  .use(authPlugin)
  // Authorization helpers. Workspace transfers move configuration, state,
  // and variables between organizations, so they are gated at the same
  // level as destructive workspace administration: the caller must be a
  // site admin, an admin of the SOURCE workspace, and (for creation) an
  // owner of the DESTINATION organization.
  .derive(async ({ user }: { user?: Readonly<typeof users.$inferSelect> | null }): Promise<{ isSiteAdmin: boolean }> => {
    return { isSiteAdmin: user?.isSiteAdmin === true };
  })
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

    if (sourceWorkspaceId === null || destinationOrgId === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A source workspace and a destination organization are required" }] };
    }

    // Authorization: creating a transfer requires admin over the SOURCE
    // workspace and org-owner of the DESTINATION organization (or site
    // admin). Without this any authenticated user could stage a transfer
    // moving an arbitrary workspace into an arbitrary organization.
    const isSiteAdmin = user.isSiteAdmin === true;
    const sourceWorkspace = await findAuthorizedWorkspace(sourceWorkspaceId, user.id, null, null);
    if (!isSiteAdmin && (sourceWorkspace === undefined || !(await checkWorkspacePermission(sourceWorkspace, user.id, null, null, "admin")))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "Source workspace not found or not accessible" }] };
    }
    const destinationOrg = await db.query.organizations.findFirst({ where: eq(organizations.id, destinationOrgId), columns: { id: true } });
    if (destinationOrg === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "Destination organization not found" }] };
    }
    if (!isSiteAdmin && destinationOrg.id === sourceWorkspace?.orgId) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The destination organization must differ from the workspace's current organization" }] };
    }
    if (!isSiteAdmin && !(await checkOrgPermission(user.id, destinationOrgId, "owner"))) {
      // Mirror the collection's not-found convention for cross-org probes:
      // do not reveal whether the destination organization exists.
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "Destination organization not found" }] };
    }
    if (destinationProjectId !== null && !isSiteAdmin) {
      // The project must belong to the destination organization.
      const project = await db.query.projects.findFirst({ where: eq(projects.id, destinationProjectId), columns: { orgId: true } });
      if (project === undefined || project.orgId !== destinationOrgId) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The destination project must belong to the destination organization" }] };
      }
    }

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
    return { data: await transferResource(transfer) };
  })
  .get("/api/v2/workspace-transfers", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const { number, size } = pageRequest(request);
    // Visibility: site admins see every transfer; everyone else sees only
    // transfers touching organizations they belong to. Transfers move state,
    // variables, and policy sets between orgs, so their existence and shape
    // are sensitive across that boundary.
    const visibleOrgIds = user.isSiteAdmin === true ? null : new Set(
      (await db.query.organizationMemberships.findMany({
        where: eq(organizationMemberships.userId, user.id),
        columns: { orgId: true },
      })).map((membership): string => membership.orgId),
    );
    const all = await db.query.workspaceTransfers.findMany({ orderBy: [desc(workspaceTransfers.createdAt)] });
    const visible: WorkspaceTransferItem[] = [];
    for (const transfer of all) {
      if (visibleOrgIds === null) {
        visible.push(transfer);
        continue;
      }
      const sourceOrgId = transfer.sourceWorkspaceId !== null
        ? (await db.query.workspaces.findFirst({ where: eq(workspaces.id, transfer.sourceWorkspaceId), columns: { orgId: true } }))?.orgId ?? null
        : null;
      const destinationOrgId = transfer.destinationOrgId;
      if ((sourceOrgId !== null && visibleOrgIds.has(sourceOrgId)) || (destinationOrgId !== null && visibleOrgIds.has(destinationOrgId))) {
        visible.push(transfer);
      }
    }
    const total = visible.length;
    const items = visible.slice((number - 1) * size, (number - 1) * size + size);
    return {
      data: await Promise.all(items.map(async (t) => transferResource(t))),
      ...pagination(request, number, size, total),
    };
  })
  .get("/api/v2/workspace-transfers/:transfer_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const transfer = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, params.transfer_id ?? "") });
    if (transfer === undefined || !(await canSeeTransfer(user, transfer))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: await transferResource(transfer) };
  })
  .post("/api/v2/workspace-transfers/:transfer_id/actions/cancel", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const id = params.transfer_id ?? "";
    const transfer = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, id) });
    if (transfer === undefined || !(await canSeeTransfer(user, transfer))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(workspaceTransfers).set({ status: "canceled", updatedAt: Date.now() }).where(eq(workspaceTransfers.id, id));
    const updated = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, id) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: await transferResource(updated) };
  })
  .post("/api/v2/workspace-transfers/:transfer_id/actions/resume", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const id = params.transfer_id ?? "";
    const transfer = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, id) });
    if (transfer === undefined || !(await canSeeTransfer(user, transfer))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(workspaceTransfers).set({ status: "running", pauseReason: null, updatedAt: Date.now() }).where(eq(workspaceTransfers.id, id));
    const updated = await db.query.workspaceTransfers.findFirst({ where: eq(workspaceTransfers.id, id) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: await transferResource(updated) };
  });
