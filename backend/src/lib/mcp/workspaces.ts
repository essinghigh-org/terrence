import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  organizations,
  projects,
  workspaceTags,
  workspaceVariables,
  workspaces,
} from "../../db/schema";
import {
  checkOrgPermission,
  checkOrganizationPermission,
  checkWorkspacePermission,
  findAuthorizedWorkspace,
  findWorkspaceByName,
  workspaceIdsForPermission,
} from "../utils";
import { validateVersion } from "../utils";
import { ensureDefaultProject, isExecutionMode } from "../../routes/projects";
import { validVariableAttributes } from "../validation";
import { toolBadRequest, toolError, type McpSession, type McpTool } from "./types";

/**
 * Workspace tools. Read/list operations require `workspaces:read`, mutations
 * require `workspaces:write`, and lock/unlock require `workspaces:lock` —
 * matching the API's WorkspacePermission checks (`read`, `admin`, `lock`).
 * Every handler re-authorizes the target workspace via findAuthorizedWorkspace
 * so fine-grained scopes (org/project/workspace/tag) are enforced on top of
 * the declared grant.
 */
export const workspaceTools: readonly McpTool[] = [
  {
    name: "create_workspace",
    description: "Create a new workspace in an organization. Requires the workspaces:write grant.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Organization name" },
        name: { type: "string", description: "Workspace name (alphanumeric, - or _)" },
        description: { type: "string", description: "Optional description" },
        project_id: { type: "string", description: "Project ID (defaults to the organization's default project)" },
        "auto-apply": { type: "boolean", description: "Auto-apply successful plans (default false)" },
        "execution-mode": { type: "string", description: "remote, local, or agent" },
        "terraform-version": { type: "string", description: "Terraform/OpenTofu version (default latest)" },
        tags: {
          type: "array", items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
          description: "Tag bindings to assign to the workspace",
        },
      },
      required: ["org", "name"],
    },
    requires: ["workspaces:write"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const orgName = typeof args.org === "string" ? args.org : "";
      const name = (typeof args.name === "string" ? args.name : "").trim();
      const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
      if (org === undefined) return toolBadRequest(`Organization "${orgName}" not found`);
      if (!(await checkOrganizationPermission(org.id, session.userId ?? undefined, session.orgId, session.teamId, "manage-workspaces"))) {
        return toolError("Not authorized to manage workspaces in this organization");
      }
      const description = typeof args.description === "string" && args.description !== "" ? args.description.trim() : null;
      const autoApply = typeof args["auto-apply"] === "boolean" ? args["auto-apply"] : false;
      const executionMode = typeof args["execution-mode"] === "string" ? args["execution-mode"] : undefined;
      const terraformVersion = typeof args["terraform-version"] === "string" ? args["terraform-version"] : undefined;
      if (name === "" || !/^[A-Za-z0-9_-]+$/.test(name)) return toolBadRequest("Invalid workspace name");
      if ((await findWorkspaceByName(org.id, name)) !== undefined) return toolBadRequest("Workspace name already exists in this organization");
      if (terraformVersion !== undefined && !validateVersion(terraformVersion)) return toolBadRequest("Invalid terraformVersion format");
      if (executionMode !== undefined && !isExecutionMode(executionMode)) return toolBadRequest("execution-mode must be remote, local, or agent");
      let project: typeof projects.$inferSelect | undefined;
      if (typeof args.project_id === "string" && args.project_id !== "") {
        project = await db.query.projects.findFirst({ where: and(eq(projects.id, args.project_id), eq(projects.orgId, org.id)) });
        if (project === undefined) return toolBadRequest("Project must belong to the workspace organization");
      } else {
        project = await ensureDefaultProject(org.id);
      }
      const id = `ws-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const finalTfVer = terraformVersion ?? "latest";
      await db.insert(workspaces).values({
        id, name, orgId: org.id, description, projectId: project.id,
        autoApply, terraformVersion: finalTfVer,
        executionMode: executionMode ?? project.defaultExecutionMode ?? "remote",
        createdAt: Date.now(),
      });
      const rawTags = Array.isArray(args.tags) ? args.tags : [];
      const tagBindings = rawTags.filter((t): boolean =>
        t !== null && typeof t === "object" && typeof (t as Record<string, unknown>).key === "string" && typeof (t as Record<string, unknown>).value === "string");
      const bindings = tagBindings.map((t): { key: string; value: string } => {
        const b = t as Record<string, unknown>;
        return { key: b.key as string, value: b.value as string };
      });
      if (bindings.length > 0) {
        await db.insert(workspaceTags).values(bindings.map((binding): typeof workspaceTags.$inferInsert => ({
          id: crypto.randomUUID(), workspaceId: id, key: binding.key, value: binding.value,
        })));
      }
      return { id, name, orgId: org.id, projectId: project.id, autoApply, executionMode: executionMode ?? project.defaultExecutionMode ?? "remote" };
    },
  },
  {
    name: "get_workspace",
    description: "Look up workspace(s) within an organization, by exact name or search.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Organization name" },
        name: { type: "string", description: "Exact workspace name (if absent, returns list)" },
        search: { type: "string", description: "Substring match on workspace name" },
        limit: { type: "number", description: "Max results (default 50)", default: 50 },
        offset: { type: "number", description: "Pagination offset", default: 0 },
      },
      required: ["org"],
    },
    requires: ["workspaces:read"],
      handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
        const orgName = String(args.org);
        const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
        if (org === undefined) return toolBadRequest(`Organization "${orgName}" not found`);
        if (!(await checkOrgPermission(session.userId ?? undefined, org.id, "member", session.orgId, session.teamId))) {
        return toolError("Not authorized to access this organization");
      }
      const exactName = typeof args.name === "string" ? args.name : undefined;
      const search = typeof args.search === "string" ? args.search : undefined;
      const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
      const offset = Math.max(Number(args.offset ?? 0), 0);
      if (exactName !== undefined) {
        const ws = await db.query.workspaces.findFirst({
          where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, exactName)),
          columns: { id: true, name: true, orgId: true, locked: true, createdAt: true },
        });
        if (ws === undefined) return toolBadRequest(`Workspace "${exactName}" not found in org "${orgName}"`);
        const authorized = await findAuthorizedWorkspace(ws.id, session.userId ?? undefined, session.orgId, session.teamId, "read");
        if (authorized === undefined) return toolError("Not authorized to access this workspace");
        return { ...ws, id: authorized.id, name: authorized.name };
      }
      const authorizedIds = await workspaceIdsForPermission(org.id, session.userId ?? undefined, session.orgId, session.teamId, "read");
      if (authorizedIds === null || authorizedIds.length === 0) return [];
      const pattern = search === undefined ? undefined : `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      const where = search !== undefined
        ? and(inArray(workspaces.id, authorizedIds as string[]), sql`${workspaces.name} LIKE ${pattern} ESCAPE '\\'`)
        : inArray(workspaces.id, authorizedIds as string[]);
      const rows = await db.query.workspaces.findMany({
        where,
        orderBy: [asc(workspaces.name)],
        limit,
        offset,
        columns: { id: true, name: true, orgId: true, locked: true, createdAt: true },
      });
      return rows;
    },
  },
  {
    name: "get_workspace_vars",
    description: "List variables for a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
        limit: { type: "number", description: "Max results (default 100)", default: 100 },
        offset: { type: "number", description: "Pagination offset", default: 0 },
      },
      required: ["workspace_id"],
    },
    requires: ["variables:read"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "variables-read");
      if (ws === undefined) return toolError("Workspace not found or not authorized");
      const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 500);
      const offset = Math.max(Number(args.offset ?? 0), 0);
      const rows = await db.query.workspaceVariables.findMany({
        where: eq(workspaceVariables.workspaceId, wsId),
        orderBy: [asc(workspaceVariables.key)],
        limit,
        offset,
        columns: { id: true, key: true, value: true, sensitive: true, hcl: true, category: true, description: true },
      });
      return rows;
    },
  },
  {
    name: "create_workspace_variable",
    description: "Create a variable on a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
        key: { type: "string", description: "Variable key" },
        value: { type: "string", description: "Variable value" },
        category: { type: "string", description: "terraform or env (default terraform)" },
        sensitive: { type: "boolean", description: "Whether the value is sensitive" },
        hcl: { type: "boolean", description: "Whether the value is HCL" },
        description: { type: "string", description: "Optional description" },
      },
      required: ["workspace_id", "key", "value"],
    },
    requires: ["variables:write"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "variables-write");
      if (ws === undefined) return toolError("Workspace not found or not authorized");
      const key = typeof args.key === "string" ? args.key : "";
      const value = typeof args.value === "string" ? args.value : "";
      const category = typeof args.category === "string" ? args.category : "terraform";
      const sensitive = typeof args.sensitive === "boolean" ? args.sensitive : false;
      const hcl = typeof args.hcl === "boolean" ? args.hcl : false;
      const description = typeof args.description === "string" ? args.description : null;
      if (!validVariableAttributes({ key, value, category, sensitive, hcl, description })) {
        return toolBadRequest("Invalid variable attributes");
      }
      const existing = await db.query.workspaceVariables.findFirst({
        where: and(eq(workspaceVariables.workspaceId, wsId), eq(workspaceVariables.key, key)),
      });
      if (existing !== undefined) return toolBadRequest(`Variable "${key}" already exists in this workspace`);
      const id = `wsvar-${crypto.randomUUID()}`;
      await db.insert(workspaceVariables).values({ id, workspaceId: wsId, key, value, category, sensitive, hcl, description });
      return { id, workspaceId: wsId, key, value, category, sensitive, hcl, description };
    },
  },
  {
    name: "update_workspace_variable",
    description: "Update an existing workspace variable.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
        variable_id: { type: "string", description: "Variable ID" },
        key: { type: "string", description: "Variable key" },
        value: { type: "string", description: "Variable value" },
        category: { type: "string", description: "terraform or env" },
        sensitive: { type: "boolean", description: "Whether the value is sensitive" },
        hcl: { type: "boolean", description: "Whether the value is HCL" },
        description: { type: "string", description: "Optional description" },
      },
      required: ["workspace_id", "variable_id"],
    },
    requires: ["variables:write"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const varId = String(args.variable_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "variables-write");
      if (ws === undefined) return toolError("Workspace not found or not authorized");
      const variable = await db.query.workspaceVariables.findFirst({
        where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, wsId)),
      });
      if (variable === undefined) return toolBadRequest(`Variable "${varId}" not found in workspace`);
      const key = typeof args.key === "string" ? args.key : variable.key;
      const value = typeof args.value === "string" ? args.value : variable.value;
      const category = typeof args.category === "string" ? args.category : variable.category;
      let sensitive = typeof args.sensitive === "boolean" ? args.sensitive : (variable.sensitive ?? false);
      if ((variable.sensitive ?? false) && !sensitive && args.value === undefined) sensitive = true;
      const hcl = typeof args.hcl === "boolean" ? args.hcl : (variable.hcl ?? false);
      const description = typeof args.description === "string" ? args.description : variable.description;
      if (!validVariableAttributes({ key, value, category, sensitive, hcl, description }, true)) {
        return toolBadRequest("Invalid variable attributes");
      }
      const updated = { key, value, category, sensitive, hcl, description };
      try {
        await db.update(workspaceVariables).set(updated).where(eq(workspaceVariables.id, varId));
      } catch (error: unknown) {
        if (error !== null && typeof error === "object" && "message" in error
          && typeof error.message === "string" && error.message.includes("UNIQUE")) {
          return toolBadRequest("Variable key already exists in this workspace");
        }
        throw error;
      }
      return { ...variable, ...updated };
    },
  },
  {
    name: "delete_workspace_variable",
    description: "Delete a workspace variable.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
        variable_id: { type: "string", description: "Variable ID" },
      },
      required: ["workspace_id", "variable_id"],
    },
    requires: ["variables:write"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const varId = String(args.variable_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "variables-write");
      if (ws === undefined) return toolError("Workspace not found or not authorized");
      const variable = await db.query.workspaceVariables.findFirst({
        where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, wsId)),
      });
      if (variable === undefined) return toolBadRequest(`Variable "${varId}" not found in workspace`);
      await db.delete(workspaceVariables).where(eq(workspaceVariables.id, varId));
      return { deleted: true, id: varId };
    },
  },
  {
    name: "lock_workspace",
    description: "Lock a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
        reason: { type: "string", description: "Optional lock reason" },
      },
      required: ["workspace_id"],
    },
    requires: ["workspaces:lock"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId);
      if (ws === undefined) return toolError("Workspace not found or not authorized");
      if (!(await checkWorkspacePermission(ws, session.userId ?? undefined, session.orgId, session.teamId, "lock"))) {
        return toolError("Not authorized to lock this workspace");
      }
      if (ws.locked === true) return toolBadRequest("Workspace is already locked");
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (reason.length > 300) return toolBadRequest("Lock reason must be at most 300 characters");
      await db.update(workspaces).set({ locked: true, lockedReason: reason === "" ? null : reason }).where(eq(workspaces.id, wsId));
      return { id: wsId, locked: true, lockedReason: reason === "" ? null : reason };
    },
  },
  {
    name: "unlock_workspace",
    description: "Unlock a workspace.",
    inputSchema: {
      type: "object",
      properties: { workspace_id: { type: "string", description: "Workspace ID" } },
      required: ["workspace_id"],
    },
    requires: ["workspaces:lock"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId);
      if (ws === undefined) return toolError("Workspace not found or not authorized");
      if (!(await checkWorkspacePermission(ws, session.userId ?? undefined, session.orgId, session.teamId, "lock"))) {
        return toolError("Not authorized to unlock this workspace");
      }
      if (ws.locked !== true) return toolBadRequest("Workspace is not locked");
      await db.update(workspaces).set({ locked: false, lockedReason: null }).where(eq(workspaces.id, wsId));
      return { id: wsId, locked: false };
    },
  },
];