import { asc, eq, sql, and } from "drizzle-orm";
import { db } from "../../db";
import { projects, teamProjects, workspaces } from "../../db/schema";
import { checkOrgPermission, checkOrganizationPermission } from "../utils";
import { toolBadRequest, toolError, type McpSession, type McpTool } from "./types";
import { cachedOrgByName } from "../cached-lookups";

/**
 * Project tools. All are org-scoped and require the relevant project grant,
 * mirroring the API's `read-projects` / `manage-projects` checks.
 */
export const projectTools: readonly McpTool[] = [
  {
    name: "get_projects",
    description: "List projects within an organization, with optional name search and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Organization name" },
        search: { type: "string", description: "Optional substring match on project name" },
        limit: { type: "number", description: "Max results (default 50)", default: 50 },
        offset: { type: "number", description: "Pagination offset", default: 0 },
      },
      required: ["org"],
    },
    requires: ["projects:read"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const orgName = typeof args.org === "string" ? args.org : "";
      const org = await cachedOrgByName(orgName);
      if (org === undefined) return toolBadRequest(`Organization "${orgName}" not found`);
      if (!(await checkOrgPermission(session.userId ?? undefined, org.id, "member", session.orgId, session.teamId))) {
        return toolError("Not authorized to access this organization");
      }
      const search = typeof args.search === "string" ? args.search : undefined;
      const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
      const offset = Math.max(Number(args.offset ?? 0), 0);
      const pattern = search === undefined ? undefined : `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      const where = search !== undefined
        ? and(eq(projects.orgId, org.id), sql`${projects.name} LIKE ${pattern} ESCAPE '\\'`)
        : eq(projects.orgId, org.id);
      const rows = await db.query.projects.findMany({
        where,
        orderBy: [asc(projects.name)],
        limit,
        offset,
        columns: { id: true, name: true, createdAt: true },
      });
      return rows;
    },
  },
  {
    name: "get_project",
    description: "Get a single project by ID, with workspace and team counts.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project ID" } },
      required: ["project_id"],
    },
    requires: ["projects:read"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const projectId = String(args.project_id);
      const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
      if (project === undefined || !(await checkOrganizationPermission(project.orgId, session.userId ?? undefined, session.orgId, session.teamId, "read-projects"))) {
        return toolError("Project not found or not authorized");
      }
      const [workspaceCountRows, teamCountRows] = await Promise.all([
        db.select({ total: sql<number>`count(*)` }).from(workspaces).where(eq(workspaces.projectId, project.id)),
        db.select({ total: sql<number>`count(*)` }).from(teamProjects).where(eq(teamProjects.projectId, project.id)),
      ]);
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        orgId: project.orgId,
        workspaceCount: workspaceCountRows[0]?.total ?? 0,
        teamCount: teamCountRows[0]?.total ?? 0,
        createdAt: project.createdAt,
      };
    },
  },
  {
    name: "create_project",
    description: "Create a project within an organization.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Organization name" },
        name: { type: "string", description: "Project name" },
        description: { type: "string", description: "Optional description" },
      },
      required: ["org", "name"],
    },
    requires: ["projects:write"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const orgName = String(args.org);
      const name = (typeof args.name === "string" ? args.name : "").trim();
      const org = await cachedOrgByName(orgName);
      if (org === undefined) return toolBadRequest(`Organization "${orgName}" not found`);
      if (!(await checkOrganizationPermission(org.id, session.userId ?? undefined, session.orgId, session.teamId, "manage-projects"))) {
        return toolError("Not authorized to manage projects in this organization");
      }
      if (name === "" || name.length > 90) return toolBadRequest("Project name must be between 1 and 90 characters");
      const existing = await db.query.projects.findFirst({ where: and(eq(projects.orgId, org.id), eq(projects.name, name)) });
      if (existing !== undefined) return toolBadRequest(`Project "${name}" already exists in this organization`);
      const id = `prj-${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
      const createdAt = Date.now();
      await db.insert(projects).values({
        id,
        orgId: org.id,
        name,
        description: typeof args.description === "string" && args.description !== "" ? args.description.trim() : null,
        createdAt,
      });
      return { id, name, orgId: org.id, createdAt, description: typeof args.description === "string" ? args.description.trim() : null };
    },
  },
];