import { Elysia } from "elysia";
import { db } from "../db";
import { teamProjects, teams, projects, type users } from "../db/schema";
import { and, eq } from "drizzle-orm";
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
    workspaceAccess: { create: false, move: false, locking: true, delete: false, runs: "apply", variables: "write", "state-versions": "write", "sentinel-mocks": "read", "run-tasks": false, "policy-overrides": false },
  },
  maintain: {
    projectAccess: { settings: "read", teams: "none" },
    workspaceAccess: { create: true, move: false, locking: true, delete: true, runs: "apply", variables: "write", "state-versions": "write", "sentinel-mocks": "read", "run-tasks": true, "policy-overrides": true },
  },
  admin: {
    projectAccess: { settings: "delete", teams: "manage" },
    workspaceAccess: { create: true, move: true, locking: true, delete: true, runs: "apply", variables: "write", "state-versions": "write", "sentinel-mocks": "read", "run-tasks": true, "policy-overrides": true },
  },
};

const FALLBACK_ACCESS: AccessLevel = { projectAccess: { settings: "read", teams: "none" }, workspaceAccess: { create: false, move: false, locking: false, delete: false, runs: "read", variables: "none", "state-versions": "none", "sentinel-mocks": "none", "run-tasks": false, "policy-overrides": false } };
const ACCESS_LEVELS = new Set(["read", "write", "maintain", "admin", "custom"]);
const PROJECT_ACCESS_KEYS = new Set(["settings", "teams"]);
const WORKSPACE_ACCESS_KEYS = new Set(["create", "move", "locking", "delete", "runs", "variables", "state-versions", "sentinel-mocks", "run-tasks", "policy-overrides"]);

function normalizedCustomAccess(projectAccess: unknown, workspaceAccess: unknown): AccessLevel | undefined {
  const rawProject = projectAccess ?? {};
  const rawWorkspace = workspaceAccess ?? {};
  if (typeof rawProject !== "object" || Array.isArray(rawProject)
    || typeof rawWorkspace !== "object" || Array.isArray(rawWorkspace)) return undefined;
  const project = rawProject as Record<string, unknown>;
  const workspace = rawWorkspace as Record<string, unknown>;
  if (!Object.keys(project).every((key): boolean => PROJECT_ACCESS_KEYS.has(key))
    || !Object.keys(workspace).every((key): boolean => WORKSPACE_ACCESS_KEYS.has(key))) return undefined;
  if (project.settings !== undefined && !["read", "update", "delete"].includes(String(project.settings))) return undefined;
  if (project.teams !== undefined && !["none", "read", "manage"].includes(String(project.teams))) return undefined;
  const booleanKeys = ["create", "move", "locking", "delete", "run-tasks", "policy-overrides"];
  if (booleanKeys.some((key): boolean => workspace[key] !== undefined && typeof workspace[key] !== "boolean")) return undefined;
  if (workspace.runs !== undefined && !["read", "plan", "apply"].includes(String(workspace.runs))) return undefined;
  if (workspace.variables !== undefined && !["none", "read", "write"].includes(String(workspace.variables))) return undefined;
  if (workspace["state-versions"] !== undefined && !["none", "read-outputs", "read", "write"].includes(String(workspace["state-versions"]))) return undefined;
  if (workspace["sentinel-mocks"] !== undefined && !["none", "read"].includes(String(workspace["sentinel-mocks"]))) return undefined;
  return {
    projectAccess: { ...FALLBACK_ACCESS.projectAccess, ...project } as Record<string, string>,
    workspaceAccess: { ...FALLBACK_ACCESS.workspaceAccess, ...workspace },
  };
}

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
    return { data: list.filter((tp): boolean => tp.organizationId === null || tp.organizationId === project.orgId).map((tp) => teamProjectResource(tp)) };
  })
  .post("/api/v2/team-projects", async ({ body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    if (data?.type !== "team-projects") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be team-projects" }] }; }
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};
    const rels = (data?.relationships as Record<string, unknown>) ?? {};

    const teamRel = rels.team as Record<string, unknown> | undefined;
    const projRel = rels.project as Record<string, unknown> | undefined;
    const teamData = teamRel?.data as Record<string, unknown> | undefined;
    const projectData = projRel?.data as Record<string, unknown> | undefined;
    const teamId = teamData?.type === "teams" && typeof teamData.id === "string" ? teamData.id : "";
    const projectId = projectData?.type === "projects" && typeof projectData.id === "string" ? projectData.id : "";

    const [team, project] = await Promise.all([
      db.query.teams.findFirst({ where: eq(teams.id, teamId) }),
      db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    ]);

    if (!team || !project) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (team.orgId !== project.orgId) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "team and project must belong to the same organization" }] }; }
    if (!(await checkOrgPermission(user?.id, project.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const access = typeof attributes.access === "string" ? attributes.access : "";
    if (!ACCESS_LEVELS.has(access)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid access level" }] }; }
    const customAccess = access === "custom" ? normalizedCustomAccess(attributes["project-access"], attributes["workspace-access"]) : undefined;
    if (access === "custom" && customAccess === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid custom permission map" }] }; }

    // The (team_id, project_id) pair is unique. A second POST for the same
    // pair would hit the constraint and surface as a 500 through the global
    // error handler; return the existing record instead so the request is
    // idempotent.
    const existing = await db.query.teamProjects.findFirst({
      where: and(eq(teamProjects.teamId, team.id), eq(teamProjects.projectId, project.id)),
    });
    if (existing !== undefined) {
      (set as { status: number }).status = 200;
      return { data: teamProjectResource(existing) };
    }

    const id = `tprj-${crypto.randomUUID()}`;
    const tp: TeamProjectItem = {
      id,
      teamId: team.id,
      projectId: project.id,
      organizationId: project.orgId,
      access,
      projectAccess: customAccess?.projectAccess ?? null,
      workspaceAccess: customAccess?.workspaceAccess ?? null,
      createdAt: Date.now(),
    };

    await db.insert(teamProjects).values(tp);
    (set as { status: number }).status = 200;
    return { data: teamProjectResource(tp) };
  })
  .get("/api/v2/team-projects/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const tp = await db.query.teamProjects.findFirst({ where: eq(teamProjects.id, params.id ?? "") });
    if (!tp) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [project, team] = await Promise.all([
      db.query.projects.findFirst({ where: eq(projects.id, tp.projectId) }),
      db.query.teams.findFirst({ where: eq(teams.id, tp.teamId) }),
    ]);
    if (!project || team?.orgId !== project.orgId || (tp.organizationId !== null && tp.organizationId !== project.orgId) || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: teamProjectResource(tp) };
  })
  .patch("/api/v2/team-projects/:id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const tp = await db.query.teamProjects.findFirst({ where: eq(teamProjects.id, params.id ?? "") });
    if (!tp) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [project, team] = await Promise.all([
      db.query.projects.findFirst({ where: eq(projects.id, tp.projectId) }),
      db.query.teams.findFirst({ where: eq(teams.id, tp.teamId) }),
    ]);
    if (!project || team?.orgId !== project.orgId || (tp.organizationId !== null && tp.organizationId !== project.orgId) || !(await checkOrgPermission(user?.id, project.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    if (data?.type !== "team-projects") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be team-projects" }] }; }
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};

    const updates: Record<string, unknown> = {};
    const nextAccess = typeof attributes.access === "string" ? attributes.access : tp.access;
    if (!ACCESS_LEVELS.has(nextAccess)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid access level" }] }; }
    const nextProjectAccess = attributes["project-access"] !== undefined ? attributes["project-access"] : (tp.access === "custom" ? tp.projectAccess : undefined);
    const nextWorkspaceAccess = attributes["workspace-access"] !== undefined ? attributes["workspace-access"] : (tp.access === "custom" ? tp.workspaceAccess : undefined);
    const customAccess = nextAccess === "custom" ? normalizedCustomAccess(nextProjectAccess, nextWorkspaceAccess) : undefined;
    if (nextAccess === "custom" && customAccess === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid custom permission map" }] }; }
    updates.access = nextAccess;
    updates.projectAccess = customAccess?.projectAccess ?? null;
    updates.workspaceAccess = customAccess?.workspaceAccess ?? null;

    await db.update(teamProjects).set(updates).where(eq(teamProjects.id, tp.id));
    const updated = await db.query.teamProjects.findFirst({ where: eq(teamProjects.id, tp.id) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: teamProjectResource(updated) };
  })
  .delete("/api/v2/team-projects/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const tp = await db.query.teamProjects.findFirst({ where: eq(teamProjects.id, params.id ?? "") });
    if (!tp) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [project, team] = await Promise.all([
      db.query.projects.findFirst({ where: eq(projects.id, tp.projectId) }),
      db.query.teams.findFirst({ where: eq(teams.id, tp.teamId) }),
    ]);
    if (!project || team?.orgId !== project.orgId || (tp.organizationId !== null && tp.organizationId !== project.orgId) || !(await checkOrgPermission(user?.id, project.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(teamProjects).where(eq(teamProjects.id, tp.id));
    (set as { status: number }).status = 204;
    return {};
  });
