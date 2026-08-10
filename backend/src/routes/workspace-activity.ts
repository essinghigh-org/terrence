import { Elysia } from "elysia";
import { db } from "../db";
import { users, runs, auditLogs } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { findAuthorizedWorkspace } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  set: SetObj;
}>;

/**
 * Workspace activity feed (kanban 16.9). Aggregates the audit trail for the
 * workspace lifecycle (create/update/lock/unlock/destroy, VCS and variable
 * changes) with run lifecycle events, newest first. Runs and audit rows are
 * combined only for workspaces the caller can read.
 */
export const workspaceActivityRoutes = new Elysia()
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/activity", async ({
    params,
    user,
    orgId,
    set,
  }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId ?? null, null);
    if (ws === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const [workspaceEvents, runEvents] = await Promise.all([
      db.query.auditLogs.findMany({
        where: eq(auditLogs.resourceId, workspaceId),
        orderBy: [desc(auditLogs.createdAt)],
        limit: 50,
      }),
      db.query.runs.findMany({
        where: eq(runs.workspaceId, workspaceId),
        orderBy: [desc(runs.createdAt)],
        limit: 50,
      }),
    ]);

    type ActivityItem = Readonly<{
      id: string;
      kind: "run" | "audit";
      at: number;
      status?: string;
      message?: string | null;
      action?: string;
      resourceType?: string;
      details?: Record<string, unknown> | null;
    }>;

    const combined: ActivityItem[] = [
      ...runEvents.map((run): ActivityItem => ({
        id: run.id,
        kind: "run",
        at: run.createdAt,
        status: run.status,
        message: run.message,
      })),
      ...workspaceEvents.map((event): ActivityItem => ({
        id: event.id,
        kind: "audit",
        at: event.createdAt,
        action: event.action,
        resourceType: event.resourceType,
        details: event.details as Record<string, unknown> | null,
      })),
    ].sort((a, b): number => b.at - a.at).slice(0, 50);

    return {
      data: combined.map((item): Record<string, unknown> => ({
        id: item.id,
        type: "workspace-activity",
        attributes: {
          kind: item.kind,
          "created-at": new Date(item.at).toISOString(),
          ...(item.kind === "run"
            ? { status: item.status, message: item.message }
            : { action: item.action, "resource-type": item.resourceType, details: item.details ?? null }),
        },
      })),
    };
  });