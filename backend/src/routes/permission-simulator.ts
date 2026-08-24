import { Elysia } from "elysia";
import { db } from "../db";
import type { users} from "../db/schema";
import { teams, workspaces } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { checkWorkspacePermission, checkOrgPermission, type WorkspacePermission } from "../lib/utils";
import { authPlugin } from "../auth";
import { cachedOrgByName } from "../lib/cached-lookups";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  set: SetObj;
}>;

const SIMULATABLE_ACTIONS: WorkspacePermission[] = [
  "read", "run-read", "plan", "apply", "discard", "cancel", "lock",
  "run-tasks", "run-tasks-read", "policy-override", "variables-read",
  "variables-write", "state-outputs", "state-read", "state-write",
];

/**
 * Read-only permission simulator (kanban 20.5). Evaluates how a team would
 * be granted workspace actions under the current RBAC rules without
 * changing anything. Useful for debugging "why can this team not apply?"
 * questions and for testing the access matrix before issuing tokens.
 */
export const permissionSimulatorRoutes = new Elysia()
  .use(authPlugin)
  .post("/api/v2/organizations/:org_name/simulate-permissions", async ({
    params,
    body,
    user,
    orgId,
    set,
  }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (orgId !== null && orgId !== undefined && orgId !== org.id) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Scoped tokens may only simulate within their organization" }] };
    }

    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const rawTeamId = payload["team-id"];
    const rawWorkspaceName = payload["workspace-name"];
    const rawActions = payload.actions;
    if (typeof rawTeamId !== "string" || rawTeamId === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "team-id is required" }] };
    }
    if (typeof rawWorkspaceName !== "string" || rawWorkspaceName === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "workspace-name is required" }] };
    }
    if (!Array.isArray(rawActions) || rawActions.length === 0 || rawActions.some((action): boolean => typeof action !== "string")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "actions must be a non-empty array of strings" }] };
    }
    const requestedActions = (rawActions as string[]).filter((action): action is WorkspacePermission =>
      (SIMULATABLE_ACTIONS as string[]).includes(action));
    if (requestedActions.length === 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "no valid actions supplied" }] };
    }

    const team = await db.query.teams.findFirst({
      where: and(eq(teams.orgId, org.id), eq(teams.id, rawTeamId)),
    });
    if (team === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "team does not belong to this organization" }] };
    }
    const workspace = await db.query.workspaces.findFirst({
      where: and(eq(workspaces.name, rawWorkspaceName), eq(workspaces.orgId, org.id)),
    });
    if (workspace === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "workspace does not exist in this organization" }] };
    }

    // Evaluate purely as the team: the caller's own identity must not leak
    // into the simulation, so userId is deliberately undefined while teamId
    // carries the team access for checkWorkspacePermission's team resolution.
    const results = await Promise.all(requestedActions.map(async (action: WorkspacePermission) => ({
      action,
      granted: await checkWorkspacePermission(workspace, undefined, orgId ?? null, rawTeamId, action),
    })));

    return {
      data: {
        id: `${team.id}:${workspace.id}`,
        type: "permission-simulations",
        attributes: {
          "team-id": team.id,
          "team-name": team.name,
          "workspace-id": workspace.id,
          "workspace-name": workspace.name,
          results: results.map((result): Record<string, unknown> => ({
            action: result.action,
            granted: result.granted,
          })),
        },
      },
    };
  });