import { Elysia } from "elysia";
import { db } from "../db";
import { teamProjects, teams, projects, type users } from "../db/schema";
import { eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { checkOrgPermission } from "../lib/utils";

type SetObj = Readonly<{ status?: number | string; headers: Record<string, string | number> }>;

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

type TeamProjectItem = Readonly<typeof teamProjects.$inferSelect>;

type AccessLevel = { readonly projectAccess: Record<string, string>; readonly workspaceAccess: Record<string, unknown> };
const defaultAccessLevels: Record<string, AccessLevel> = {
  read: {
    projectAccess: { settings: "read", teams: "none" },
    workspaceAccess: { create: false, move: false, locking: false, delete: false, runs: "read", variables: "read", "state-versions": "read", "sentinel-mocks": "none", "run-tasks": false, "policy-overrides": false },
  },
  write: {
    projectAccess: { settings: "read", teams: "none" },
    workspaceAccess: { create: false, move: false, locking: false, delete: false, runs: "apply", variables: "write", "state-versions": "read-outputs", "sentinel-mocks": "none", "run-tasks": false, "policy-overrides": false },
  },
  maintain: {
    projectAccess: { settings: "read", teams: "none" },
    workspaceAccess: { create: false, move: false, locking: true, delete: false, runs: "apply", variables: "write", "state-versions": "read-outputs", "sentinel-mocks": "read", "run-tasks": true, "policy-overrides": false },
  },
  admin: {
    projectAccess: { settings: "write", teams: "manage" },
    workspaceAccess: { create: true, move: true, locking: true, delete: true, runs: "apply", variables: "write", "state-versions": "read-outputs", "sentinel-mocks": "read", "run-tasks": true, "policy-overrides": true },
  },
};

const FALLBACK_ACCESS: AccessLevel = { projectAccess: { settings: "read", teams: "none" }, workspaceAccess: { create: false, move: false, locking: false, delete: false, runs: "read", variables: "read", "state-versions": "read", "sentinel-mocks": "none", "run-tasks": false, "policy-overrides": false } };

function teamProjectResource(tp: TeamProjectItem): Record<string, unknown> {
  const defaults = defaultAccessLevels[tp.access] ?? FALLBACK_ACCESS;
  return {
    id: tp.id,
    type: "team-projects",
    attributes: {
      access: tp.access,
      "project-access": tp.projectAccess ?? defaults.projectAccess,
      "workspace-access": tp.workspaceAccess ?? defaults.workspaceAccess,
    },
    relationships: {
      team: {
        data: { id: tp.teamId, type: "teams" },
        links: { related: `/api/v2/teams/${tp.teamId}` },
      },
      project: {
        data: { id: tp.projectId, type: "projects" },
        links: { related: `/api/v2/projects/${tp.projectId}` },
      },
    },
  };
}

export const teamProjectRoutes = new Elysia({ name: "team-projects" })
  .use(authPlugin)
  .get("/api/v2/team-projects", async ({ request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("filter[project][id]");
    if (!projectId) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "filter[project][id] is required" }] };
    }
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const list = await db.query.teamProjects.findMany({ where: eq(teamProjects.projectId, project.id) });
    return { data: list.map((tp) => teamProjectResource(tp)) };
  })
  .post("/api/v2/team-projects", async ({ body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};
    const rels = (data?.relationships as Record<string, unknown>) ?? {};

    const teamRel = rels.team as Record<string, unknown> | undefined;
    const projRel = rels.project as Record<string, unknown> | undefined;
    const teamId = typeof (teamRel?.data as Record<string, unknown>)?.id === "string" ? ((teamRel?.data as Record<string, unknown>).id as string) : "";
    const projectId = typeof (projRel?.data as Record<string, unknown>)?.id === "string" ? ((projRel?.data as Record<string, unknown>).id as string) : "";

    const [team, project] = await Promise.all([
      db.query.teams.findFirst({ where: eq(teams.id, teamId) }),
      db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    ]);

    if (!team || !project) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, project.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const access = typeof attributes.access === "string" ? attributes.access : "read";
    const id = `tprj-${crypto.randomUUID()}`;
    const tp: TeamProjectItem = {
      id,
      teamId: team.id,
      projectId: project.id,
      access,
      projectAccess: (attributes["project-access"] as Record<string, string>) ?? null,
      workspaceAccess: (attributes["workspace-access"] as Record<string, unknown>) ?? null,
      createdAt: Date.now(),
    };

    await db.insert(teamProjects).values(tp);
    (set as { status: number }).status = 201;
    return { data: teamProjectResource(tp) };
  })
  .get("/api/v2/team-projects/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const tp = await db.query.teamProjects.findFirst({ where: eq(teamProjects.id, params.id ?? "") });
    if (!tp) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const project = await db.query.projects.findFirst({ where: eq(projects.id, tp.projectId) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: teamProjectResource(tp) };
  })
  .patch("/api/v2/team-projects/:id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const tp = await db.query.teamProjects.findFirst({ where: eq(teamProjects.id, params.id ?? "") });
    if (!tp) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const project = await db.query.projects.findFirst({ where: eq(projects.id, tp.projectId) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};

    const updates: Record<string, unknown> = {};
    if (typeof attributes.access === "string") updates.access = attributes.access;
    if (attributes["project-access"] !== undefined) updates.projectAccess = attributes["project-access"];
    if (attributes["workspace-access"] !== undefined) updates.workspaceAccess = attributes["workspace-access"];

    await db.update(teamProjects).set(updates).where(eq(teamProjects.id, tp.id));
    const updated = await db.query.teamProjects.findFirst({ where: eq(teamProjects.id, tp.id) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: teamProjectResource(updated) };
  })
  .delete("/api/v2/team-projects/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const tp = await db.query.teamProjects.findFirst({ where: eq(teamProjects.id, params.id ?? "") });
    if (!tp) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const project = await db.query.projects.findFirst({ where: eq(projects.id, tp.projectId) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(teamProjects).where(eq(teamProjects.id, tp.id));
    (set as { status: number }).status = 204;
    return {};
  });
