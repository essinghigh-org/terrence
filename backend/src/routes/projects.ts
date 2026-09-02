import { Elysia } from "elysia";
import { db } from "../db";
import { agentPools, projects, projectTags, workspaces, teamWorkspaces, type users } from "../db/schema";
import { eq, and, inArray, count, countDistinct, asc, isNotNull, sql } from "drizzle-orm";
import { projectResource, projectTagBindingResource } from "../lib/response";
import { checkOrganizationPermission, pageRequest, pagination } from "../lib/utils";
import { agentPoolAllowsProject } from "../lib/agent-pool-scope";
import { isExecutionMode } from "../lib/constants";
import { authPlugin } from "../auth";
import { cachedOrgByName } from "../lib/cached-lookups";
import { isUniqueConstraintError } from "../lib/validation";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

async function countsByProject(projectIds: readonly string[]): Promise<Map<string, { workspaceCount: number; teamCount: number }>> {
  const result = new Map<string, { workspaceCount: number; teamCount: number }>();
  if (projectIds.length === 0) return result;
  const workspaceRows = await db.select({ projectId: workspaces.projectId, total: count() })
    .from(workspaces)
    .where(and(inArray(workspaces.projectId, [...projectIds]), isNotNull(workspaces.projectId)))
    .groupBy(workspaces.projectId);
  const teamRows = await db.select({ projectId: workspaces.projectId, total: countDistinct(teamWorkspaces.teamId) })
    .from(workspaces)
    .innerJoin(teamWorkspaces, eq(teamWorkspaces.workspaceId, workspaces.id))
    .where(and(inArray(workspaces.projectId, [...projectIds]), isNotNull(workspaces.projectId)))
    .groupBy(workspaces.projectId);
  for (const projectId of projectIds) {
    result.set(projectId, { workspaceCount: 0, teamCount: 0 });
  }
  for (const row of workspaceRows) {
    if (row.projectId === null) continue;
    const current = result.get(row.projectId);
    if (current !== undefined) current.workspaceCount = row.total;
  }
  for (const row of teamRows) {
    if (row.projectId === null) continue;
    const current = result.get(row.projectId);
    if (current !== undefined) current.teamCount = row.total;
  }
  return result;
}

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string }>;
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

const autoDestroyDuration = /^[1-9]\d{0,3}[dh]$/;

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

function newProjectId(): string {
  return `prj-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function ensureDefaultProject(orgId: string): Promise<typeof projects.$inferSelect> {
  let project = await db.query.projects.findFirst({
    where: and(eq(projects.orgId, orgId), eq(projects.isDefault, true)),
  });
  if (project !== undefined) return project;
  await db.insert(projects).values({
    id: newProjectId(),
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
  .get("/api/v2/organizations/:org_name/projects", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "read-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await ensureDefaultProject(org.id);
    const { number, size } = pageRequest(request);
    const [projList, countRows] = await Promise.all([
      db.query.projects.findMany({
        where: eq(projects.orgId, org.id),
        orderBy: [asc(projects.name)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(projects).where(eq(projects.orgId, org.id)),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    const counts = await countsByProject(projList.map((p): string => p.id));
    return { data: await Promise.all(projList.map(async (project): Promise<Record<string, unknown>> => {
      const projectCounts = counts.get(project.id) ?? { workspaceCount: 0, teamCount: 0 };
      return projectResource(project, projectCounts.workspaceCount, projectCounts.teamCount, undefined, org.name);
    })), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/organizations/:org_name/projects", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    await ensureDefaultProject(org.id);
    const id = newProjectId();
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
    try {
      await db.insert(projects).values(newProj);
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "A project with this name already exists in the organization" }] };
    }
    const created = await db.query.projects.findFirst({ where: eq(projects.id, id) });
    if (created === undefined) throw new Error("Unable to create project");
    (set as { status: number }).status = 201;
    return { data: await projectResource(created, 0, 0) };
  })
  .get("/api/v2/projects/:project_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const projectCounts = (await countsByProject([projectId])).get(projectId) ?? { workspaceCount: 0, teamCount: 0 };
    const canManage = await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects");
    return { data: await projectResource(project, projectCounts.workspaceCount, projectCounts.teamCount, {
      "can-update": canManage,
      "can-destroy": canManage,
      "can-create-workspace": canManage,
    }) };
  })
  .patch("/api/v2/projects/:project_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    if (data !== null && typeof data === "object" && "type" in data && (data as Record<string, unknown>).type !== undefined && (data as Record<string, unknown>).type !== "projects") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid type" }] };
    }
    if (attributes.name !== undefined && typeof attributes.name === "string" && attributes.name.trim() === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] };
    }
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
    try {
      await db.transaction(async (tx): Promise<void> => {
        await tx.update(projects).set(updates).where(eq(projects.id, projectId));
        // Batch the per-workspace setting fan-out: workspaces that resolve to the
        // same resulting update are written with one query keyed by an IN clause,
        // instead of updating each workspace one-by-one.
        const updatesById = new Map<string, Partial<typeof workspaces.$inferInsert>>();
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
            updatesById.set(workspace.id, workspaceUpdates);
          }
        }
        const groups = new Map<string, { ids: string[]; update: Partial<typeof workspaces.$inferInsert> }>();
        for (const [workspaceId, update] of updatesById) {
          const key = JSON.stringify(update);
          const group = groups.get(key);
          if (group === undefined) groups.set(key, { ids: [workspaceId], update });
          else group.ids.push(workspaceId);
        }
        for (const group of groups.values()) {
          await tx.update(workspaces).set(group.update).where(inArray(workspaces.id, group.ids));
        }
      });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "A project with this name already exists in the organization" }] };
    }
    const updated = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updatedCounts = (await countsByProject([projectId])).get(projectId) ?? { workspaceCount: projectWorkspaces.length, teamCount: 0 };
    return { data: await projectResource(updated, updatedCounts.workspaceCount, updatedCounts.teamCount) };
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
    return { data: tags.map((t: Readonly<typeof projectTags.$inferSelect>): Record<string, unknown> => projectTagBindingResource(t, true)) };
  })
  .patch("/api/v2/projects/:project_id/tag-bindings", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const items = Array.isArray(payload.data) ? payload.data : payload.data === undefined ? [] : [payload.data];
    const entries: TagEntry[] = items.map((item): TagEntry => {
      const resource = item !== null && typeof item === "object" ? item as Record<string, unknown> : {};
      const attrs = resource.attributes !== null && typeof resource.attributes === "object" ? resource.attributes as Record<string, unknown> : {};
      return { key: typeof attrs.key === "string" ? attrs.key : "", value: typeof attrs.value === "string" ? attrs.value : null };
    });
    if (entries.some((entry): boolean => entry.key === "" || entry.value === null || entry.value === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Each tag binding requires a string key and value" }] };
    }
    if (entries.length === 0 || entries.length > 10) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "At least one and no more than ten tag bindings are required" }] }; }
    if (new Set(entries.map((entry): string => entry.key)).size !== entries.length) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Tag binding keys must be unique" }] };
    }
    await db.insert(projectTags).values(entries.map((entry): typeof projectTags.$inferInsert => ({ id: `ptag-${crypto.randomUUID()}`, projectId, key: entry.key, value: entry.value }))).onConflictDoUpdate({ target: [projectTags.projectId, projectTags.key], set: { value: sql`excluded.value` } });
    const tags = await db.query.projectTags.findMany({ where: eq(projectTags.projectId, projectId) });
    (set as { status: number }).status = 200;
    return { data: tags.map((tag): Record<string, unknown> => projectTagBindingResource(tag)) };
  })
  .post("/api/v2/projects/:project_id/tag-bindings", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = Array.isArray(payload.data) ? payload.data : payload.data === undefined ? [] : [payload.data];
    const entries: TagEntry[] = items.map((item: unknown): TagEntry => {
      const resource = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const attrs = resource.attributes !== null && typeof resource.attributes === "object" ? (resource.attributes as Record<string, unknown>) : {};
      return { key: typeof attrs.key === "string" ? attrs.key : "", value: typeof attrs.value === "string" ? attrs.value : null };
    });
    if (entries.some((entry): boolean => entry.key === "" || entry.value === null || entry.value === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Each tag binding requires a string key and value" }] };
    }
    if (entries.length === 0 || entries.length > 10) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "At least one and no more than ten tag bindings are required" }] }; }
    if (new Set(entries.map((entry): string => entry.key)).size !== entries.length) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Tag binding keys must be unique" }] };
    }
    // Single upsert upserts all requested tag bindings in one statement
    // (insert new keys, update values for existing ones) instead of a
    // per-row UPDATE loop on top of a separate INSERT.
    await db.insert(projectTags).values(
      entries.map((e: TagEntry): typeof projectTags.$inferInsert => ({ id: `ptag-${crypto.randomUUID()}`, projectId, key: e.key, value: e.value })),
    ).onConflictDoUpdate({
      target: [projectTags.projectId, projectTags.key],
      set: { value: sql`excluded.value` },
    });
    const allTags = await db.query.projectTags.findMany({ where: and(eq(projectTags.projectId, projectId), inArray(projectTags.key, entries.map((e): string => e.key))) });
    const created = allTags.map((pt: Readonly<typeof projectTags.$inferSelect>): Record<string, unknown> => projectTagBindingResource(pt));
    (set as { status: number }).status = 201;
    return { data: created };
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
  })
  .post("/api/v2/projects/:project_id/relationships/workspaces", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const projectId = params.project_id ?? "";
    const destination = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (destination === undefined || !(await checkOrganizationPermission(destination.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const items = Array.isArray(payload.data) ? payload.data : [];
    const workspaceIds = items.map((item): string => {
      if (item === null || typeof item !== "object") return "";
      const value = item as Record<string, unknown>;
      return typeof value.id === "string" && (value.type === undefined || value.type === "workspaces") ? value.id : "";
    }).filter((id): boolean => id !== "");
    if (workspaceIds.length !== items.length || workspaceIds.length === 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data must contain workspace resource identifiers" }] };
    }
    const sourceWorkspaces = await db.query.workspaces.findMany({ where: inArray(workspaces.id, workspaceIds) });
    if (sourceWorkspaces.length !== workspaceIds.length || sourceWorkspaces.some((workspace): boolean => workspace.orgId !== destination.orgId)) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Workspace(s) not found or not authorized to move" }] };
    }
    const destinationExecutionMode = destination.defaultExecutionMode ?? "remote";
    await db.transaction(async (tx): Promise<void> => {
      for (const workspace of sourceWorkspaces) {
        const overwrites = workspace.settingOverwrites ?? {};
        const updates: Partial<typeof workspaces.$inferInsert> = { projectId };
        if (overwrites["execution-mode"] !== true) {
          updates.executionMode = destinationExecutionMode;
          if (destinationExecutionMode !== "agent") updates.agentPoolId = null;
          else if (overwrites["agent-pool"] !== true) updates.agentPoolId = destination.defaultAgentPoolId;
        }
        if (workspace.inheritsProjectAutoDestroy) updates.autoDestroyActivityDuration = destination.autoDestroyActivityDuration;
        await tx.update(workspaces).set(updates).where(eq(workspaces.id, workspace.id));
      }
    });
    (set as { status: number }).status = 204;
    return {};
  });
