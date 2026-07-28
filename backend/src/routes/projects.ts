import { Elysia } from "elysia";
import { db } from "../db";
import { agentPools, projects, projectTags, organizations, workspaces, type users } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { projectResource, projectTagBindingResource } from "../lib/response";
import { checkOrganizationPermission } from "../lib/utils";
import { agentPoolAllowsProject } from "../lib/agent-pool-scope";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObj;
}>;

type TagEntry = Readonly<{
  readonly key: string;
  readonly value: string | null;
}>;

type ProjectSettings = Readonly<{
  defaultExecutionMode: string;
  defaultAgentPoolId: string | null;
  autoDestroyActivityDuration: string | null;
  settingOverwrites: Record<string, boolean>;
}>;

type ExistingProjectSettings = Readonly<{
  defaultExecutionMode: string | null;
  defaultAgentPoolId: string | null;
  autoDestroyActivityDuration: string | null;
  settingOverwrites: Readonly<Record<string, boolean>> | null;
}>;

const executionModes = new Set(["remote", "local", "agent"]);
const autoDestroyDuration = /^[1-9]\d{0,3}[dh]$/;

export function isExecutionMode(value: unknown): value is string {
  return typeof value === "string" && executionModes.has(value);
}

export function isAutoDestroyDuration(value: unknown): value is string {
  return typeof value === "string" && autoDestroyDuration.test(value);
}

export function parseSettingOverwrites(
  input: unknown,
  existing: Readonly<Record<string, boolean>> | null | undefined,
): Readonly<{ value: Record<string, boolean> }> | Readonly<{ error: string }> {
  if (input === undefined) return { value: { "execution-mode": false, ...existing } };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { error: "setting-overwrites must be an object of boolean values" };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.some(([, value]): boolean => typeof value !== "boolean")) {
    return { error: "setting-overwrites must be an object of boolean values" };
  }
  return {
    value: {
      "execution-mode": false,
      ...existing,
      ...Object.fromEntries(entries) as Record<string, boolean>,
    },
  };
}

function parseDefaultAgentPool(
  data: Readonly<Record<string, unknown>> | undefined,
  attributes: Readonly<Record<string, unknown>>,
): Readonly<{ provided: boolean; value: string | null }> | Readonly<{ error: string }> {
  const relationships = typeof data?.relationships === "object" && data.relationships !== null
    ? data.relationships as Record<string, unknown>
    : {};
  if (Object.prototype.hasOwnProperty.call(relationships, "default-agent-pool")) {
    const relationship = relationships["default-agent-pool"];
    if (relationship === null || typeof relationship !== "object") {
      return { error: "default-agent-pool relationship is invalid" };
    }
    const poolData = (relationship as Record<string, unknown>).data;
    if (poolData === null) return { provided: true, value: null };
    if (typeof poolData !== "object") {
      return { error: "default-agent-pool relationship is invalid" };
    }
    const resource = poolData as Record<string, unknown>;
    if (typeof resource.id !== "string" || (resource.type !== undefined && resource.type !== "agent-pools")) {
      return { error: "default-agent-pool relationship is invalid" };
    }
    return { provided: true, value: resource.id };
  }
  if (!Object.prototype.hasOwnProperty.call(attributes, "default-agent-pool")) {
    return { provided: false, value: null };
  }
  const value = attributes["default-agent-pool"];
  return typeof value === "string" || value === null
    ? { provided: true, value }
    : { error: "default-agent-pool must be an agent pool ID or null" };
}

async function projectSettings(
  orgId: string,
  projectId: string,
  data: Readonly<Record<string, unknown>> | undefined,
  attributes: Readonly<Record<string, unknown>>,
  existing?: ExistingProjectSettings,
): Promise<Readonly<{ value: ProjectSettings }> | Readonly<{ error: string }>> {
  const rawMode = attributes["default-execution-mode"];
  const defaultExecutionMode = rawMode === undefined
    ? existing?.defaultExecutionMode ?? "remote"
    : typeof rawMode === "string" ? rawMode : "";
  if (!isExecutionMode(defaultExecutionMode)) {
    return { error: "default-execution-mode must be remote, local, or agent" };
  }

  const overwrites = parseSettingOverwrites(attributes["setting-overwrites"], existing?.settingOverwrites);
  if ("error" in overwrites) return overwrites;
  if (
    rawMode !== undefined
    && (
      attributes["setting-overwrites"] === undefined
      || !Object.prototype.hasOwnProperty.call(attributes["setting-overwrites"] as object, "execution-mode")
    )
  ) {
    overwrites.value["execution-mode"] = defaultExecutionMode !== "remote";
  }

  const rawDuration = attributes["auto-destroy-activity-duration"];
  const autoDestroyActivityDuration = rawDuration === undefined
    ? existing?.autoDestroyActivityDuration ?? null
    : rawDuration;
  if (
    autoDestroyActivityDuration !== null
    && !isAutoDestroyDuration(autoDestroyActivityDuration)
  ) {
    return { error: "auto-destroy-activity-duration must be null or a duration such as 14d or 24h" };
  }

  const parsedPool = parseDefaultAgentPool(data, attributes);
  if ("error" in parsedPool) return parsedPool;
  const defaultAgentPoolId = parsedPool.provided
    ? parsedPool.value
    : defaultExecutionMode === "agent" ? existing?.defaultAgentPoolId ?? null : null;
  if (defaultExecutionMode === "agent" && defaultAgentPoolId === null) {
    return { error: "default-agent-pool is required for agent execution mode" };
  }
  if (defaultExecutionMode !== "agent" && defaultAgentPoolId !== null) {
    return { error: "default-agent-pool is only valid for agent execution mode" };
  }
  if (defaultAgentPoolId !== null) {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, defaultAgentPoolId) });
    if (pool?.orgId !== orgId) {
      return { error: "default-agent-pool must belong to the project organization" };
    }
    if (!(await agentPoolAllowsProject(pool, projectId))) {
      return { error: "default-agent-pool is not allowed for this project" };
    }
  }

  return {
    value: {
      defaultExecutionMode,
      defaultAgentPoolId,
      autoDestroyActivityDuration,
      settingOverwrites: overwrites.value,
    },
  };
}

export async function ensureDefaultProject(orgId: string): Promise<typeof projects.$inferSelect> {
  let project = await db.query.projects.findFirst({
    where: and(eq(projects.orgId, orgId), eq(projects.isDefault, true)),
  });
  if (project !== undefined) return project;
  await db.insert(projects).values({
    id: `prj-${crypto.randomUUID()}`,
    orgId,
    name: "Default Project",
    description: "Default Project for Organization",
    defaultExecutionMode: "remote",
    settingOverwrites: { "execution-mode": false },
    isDefault: true,
    createdAt: Date.now(),
  }).onConflictDoNothing();
  project = await db.query.projects.findFirst({
    where: and(eq(projects.orgId, orgId), eq(projects.isDefault, true)),
  });
  if (project === undefined) throw new Error("Unable to create the default project");
  return project;
}

export const projectRoutes = new Elysia({ name: "projects" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/projects", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "read-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await ensureDefaultProject(org.id);
    const projList = await db.query.projects.findMany({ where: eq(projects.orgId, org.id) });
    return { data: projList.map((project): Record<string, unknown> => projectResource(project)) };
  })
  .post("/api/v2/organizations/:org_name/projects", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    await ensureDefaultProject(org.id);
    const id = `prj-${crypto.randomUUID()}`;
    const settings = await projectSettings(org.id, id, data, attributes);
    if ("error" in settings) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: settings.error }] };
    }
    const description = typeof attributes.description === "string" ? attributes.description : null;
    const newProj: typeof projects.$inferInsert = {
      id,
      orgId: org.id,
      name,
      description,
      ...settings.value,
      createdAt: Date.now(),
    };
    await db.insert(projects).values(newProj);
    const created = await db.query.projects.findFirst({ where: eq(projects.id, id) });
    if (created === undefined) throw new Error("Unable to create project");
    (set as { status: number }).status = 201;
    return { data: projectResource(created) };
  })
  .get("/api/v2/projects/:project_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: projectResource(project) };
  })
  .patch("/api/v2/projects/:project_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const settings = await projectSettings(project.orgId, projectId, data, attributes, project);
    if ("error" in settings) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: settings.error }] };
    }
    const updates: Partial<typeof projects.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = typeof attributes.description === "string" ? attributes.description : null;
    Object.assign(updates, settings.value);
    const projectWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.projectId, projectId) });
    await db.transaction(async (tx): Promise<void> => {
      await tx.update(projects).set(updates).where(eq(projects.id, projectId));
      // ponytail: project setting changes are rare; switch to set-based JSON SQL if fan-out becomes hot.
      for (const workspace of projectWorkspaces) {
        const workspaceUpdates: Partial<typeof workspaces.$inferInsert> = {};
        const overwrites = workspace.settingOverwrites ?? {};
        if (overwrites["execution-mode"] !== true) {
          workspaceUpdates.executionMode = settings.value.defaultExecutionMode;
          if (settings.value.defaultExecutionMode !== "agent") {
            workspaceUpdates.agentPoolId = null;
          } else if (overwrites["agent-pool"] !== true) {
            workspaceUpdates.agentPoolId = settings.value.defaultAgentPoolId;
          }
        }
        if (workspace.inheritsProjectAutoDestroy) {
          workspaceUpdates.autoDestroyActivityDuration = settings.value.autoDestroyActivityDuration;
        }
        if (Object.keys(workspaceUpdates).length > 0) {
          await tx.update(workspaces).set(workspaceUpdates).where(eq(workspaces.id, workspace.id));
        }
      }
    });
    const updated = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: projectResource(updated) };
  })
  .delete("/api/v2/projects/:project_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (project.isDefault) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "The default project cannot be deleted" }] };
    }
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.projectId, projectId) });
    if (workspace !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Project must be empty before it can be deleted" }] };
    }
    await db.delete(projects).where(eq(projects.id, projectId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Project Tag Bindings ---
  .get("/api/v2/projects/:project_id/tag-bindings", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.projectTags.findMany({ where: eq(projectTags.projectId, projectId) });
    return { data: tags.map((t: Readonly<typeof projectTags.$inferSelect>): Record<string, unknown> => projectTagBindingResource(t)) };
  })
  .get("/api/v2/projects/:project_id/effective-tag-bindings", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.projectTags.findMany({ where: eq(projectTags.projectId, projectId) });
    return { data: tags.map((t: Readonly<typeof projectTags.$inferSelect>): Record<string, unknown> => projectTagBindingResource(t)) };
  })
  .post("/api/v2/projects/:project_id/tag-bindings", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    const tagList = Array.isArray(items) ? items : [items];
    const entries: TagEntry[] = tagList.map((item: unknown): TagEntry => {
      const i = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const attrs = typeof i.attributes === "object" && i.attributes !== null ? (i.attributes as Record<string, unknown>) : {};
      const key = typeof attrs.key === "string" ? attrs.key : (typeof i.key === "string" ? i.key : "");
      const value = typeof attrs.value === "string" ? attrs.value : (typeof i.value === "string" ? i.value : null);
      return { key, value };
    }).filter((e: TagEntry): boolean => e.key !== "");
    const keys = entries.map((e: TagEntry): string => e.key);
    if (keys.length === 0) {
      (set as { status: number }).status = 201;
      return { data: [] };
    }
    const existingTags = await db.query.projectTags.findMany({ where: and(eq(projectTags.projectId, projectId), inArray(projectTags.key, keys)) });
    const existingKeys = new Set(existingTags.map((t: Readonly<{ readonly key: string }>): string => t.key));
    for (const et of existingTags) {
      const entry = entries.find((e: TagEntry): boolean => e.key === et.key);
      if (entry !== undefined && entry.value !== et.value) {
        await db.update(projectTags).set({ value: entry.value }).where(eq(projectTags.id, et.id));
      }
    }
    const newEntries = entries.filter((e: TagEntry): boolean => !existingKeys.has(e.key));
    if (newEntries.length > 0) {
      await db.insert(projectTags).values(newEntries.map((e: TagEntry): typeof projectTags.$inferInsert => ({ id: `ptag-${crypto.randomUUID()}`, projectId, key: e.key, value: e.value })));

    }
    const allTags = await db.query.projectTags.findMany({ where: and(eq(projectTags.projectId, projectId), inArray(projectTags.key, keys)) });
    const created = allTags.map((pt: Readonly<typeof projectTags.$inferSelect>): Record<string, unknown> => projectTagBindingResource(pt));
    (set as { status: number }).status = 201;
    return { data: created.length === 1 ? created[0] : created };
  })
  .delete("/api/v2/projects/:project_id/tag-bindings", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    const tagList = Array.isArray(items) ? items : [items];
    const keys = tagList.map((item: unknown): string => {
      const i = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const attrs = typeof i.attributes === "object" && i.attributes !== null ? (i.attributes as Record<string, unknown>) : {};
      return typeof attrs.key === "string" ? attrs.key : (typeof i.key === "string" ? i.key : "");
    }).filter((k: string): boolean => k !== "");
    if (keys.length > 0) await db.delete(projectTags).where(and(eq(projectTags.projectId, projectId), inArray(projectTags.key, keys)));
    (set as { status: number }).status = 204;
    return {};
  });
