import { Elysia } from "elysia";
import { db } from "../db";
import { variableSets, variableSetWorkspaces, variableSetProjects, variableSetVariables, workspaces, projects, organizations, type users } from "../db/schema";
import { eq, and, asc, like, count, inArray } from "drizzle-orm";
import { variableSetResource, variableSetVariableResource, variableSetVariableUpdate } from "../lib/response";
import { validVariableSetAttributes, validVariableSetVariableAttributes, isUniqueConstraintError } from "../lib/validation";
import { checkOrganizationPermission, findAuthorizedVariableSet, pageRequest, pagination, workspaceRelationshipIds, projectRelationshipIds, variableRelationshipResources } from "../lib/utils";
import { scopeCoversOrg, scopeGrants } from "../lib/token-scopes";
import { currentTokenScopes } from "../lib/request-scope";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

type VarSetItem = Readonly<typeof variableSets.$inferSelect>;
type VarItem = Readonly<typeof variableSetVariables.$inferSelect>;

type ResItem = Readonly<{
  readonly id: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}>;


export const varsetRoutes = new Elysia({ name: "varsets" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/varsets", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-varsets"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const url = new URL(request.url);
    const search = url.searchParams.get("q")?.trim() ?? "";
    const projectFilter = url.searchParams.get("filter[project][id]")?.trim() ?? "";
    const scope = eq(variableSets.orgId, org.id);
    const conditions: (typeof scope)[] = [scope];
    if (search !== "") conditions.push(like(variableSets.name, `%${search}%`));
    if (projectFilter !== "") {
      // Project-scoped variable sets: those owned by the project
      // (parent_project_id) plus org-owned sets explicitly applied to it.
      const owned = await db.query.variableSets.findMany({
        where: eq(variableSets.parentProjectId, projectFilter),
        columns: { id: true },
      });
      const applied = await db.query.variableSetProjects.findMany({
        where: eq(variableSetProjects.projectId, projectFilter),
        columns: { variableSetId: true },
      });
      const ids = new Set<string>([
        ...owned.map((v): string => v.id),
        ...applied.map((l): string => l.variableSetId),
      ]);
      if (ids.size === 0) {
        return { data: [], ...pagination(request, number, size, 0) };
      }
      conditions.push(inArray(variableSets.id, [...ids]));
    }
    const where = and(...conditions);
    let records = await db.query.variableSets.findMany({ where, orderBy: [asc(variableSets.name)], limit: size, offset: (number - 1) * size });
    // Mirror findAuthorizedVariableSet: a fine-grained token sees only the
    // variable sets its scope covers, so the collection cannot out-widen the
    // item endpoints. The scope check is org-level and pure, so it is cheap.
    const scopes = currentTokenScopes();
    if (scopes !== null) {
      records = records.filter((r: VarSetItem): boolean =>
        scopeCoversOrg(scopes, r.orgId) && scopeGrants(scopes, "varsets:read"));
    }
    const totalCount = records.length;
    // Batch the per-row N+1 (workspace/project/variable links + org name):
    // three queries for the whole page instead of three per variable set.
    const setIds = records.map((r: VarSetItem): string => r.id);
    const [workspaceLinkRows, projectLinkRows, variableRows] = setIds.length === 0
      ? [[], [], []]
      : await Promise.all([
        db.query.variableSetWorkspaces.findMany({ where: inArray(variableSetWorkspaces.variableSetId, setIds) }),
        db.query.variableSetProjects.findMany({ where: inArray(variableSetProjects.variableSetId, setIds) }),
        db.query.variableSetVariables.findMany({ where: inArray(variableSetVariables.variableSetId, setIds) }),
      ]);
    const groupBySetId = <T extends { variableSetId: string }>(rows: readonly T[]): Map<string, T[]> => {
      const grouped = new Map<string, T[]>();
      for (const row of rows) {
        const list = grouped.get(row.variableSetId) ?? [];
        list.push(row);
        grouped.set(row.variableSetId, list);
      }
      return grouped;
    };
    const workspaceLinksBySet = groupBySetId(workspaceLinkRows);
    const projectLinksBySet = groupBySetId(projectLinkRows);
    const variablesBySet = groupBySetId(variableRows);
    const data = await Promise.all(records.map(async (r: VarSetItem): Promise<Record<string, unknown>> =>
      variableSetResource(r, {
        orgName: org.name,
        workspaceLinks: workspaceLinksBySet.get(r.id) ?? [],
        projectLinks: projectLinksBySet.get(r.id) ?? [],
        variables: variablesBySet.get(r.id) ?? [],
      })));
    return { data, ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/organizations/:org_name/varsets", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-varsets"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : undefined;
    if (data?.type !== "varsets" || attributes === undefined || attributes === null || !validVariableSetAttributes(attributes)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    const description = typeof attributes.description === "string" ? attributes.description : null;
    const global = typeof attributes.global === "boolean" ? attributes.global : false;
    const priority = typeof attributes.priority === "boolean" ? attributes.priority : false;
    const parentProjectId = typeof attributes["parent-project-id"] === "string"
      ? attributes["parent-project-id"]
      : null;
    if (parentProjectId !== null) {
      const parent = await db.query.projects.findFirst({ where: eq(projects.id, parentProjectId) });
      if (parent === undefined || parent.orgId !== org.id) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Parent project must belong to the organization" }] };
      }
      // TFE: project-owned variable sets cannot be global.
      if (global === true) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Project-owned variable sets cannot be global" }] };
      }
    }
    const record = {
      id: `varset-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      orgId: org.id,
      parentProjectId,
      name,
      description,
      global: parentProjectId !== null ? false : global,
      priority,
    };
    await db.insert(variableSets).values(record);
    (set as { status: number }).status = 201;
    return { data: await variableSetResource(record) };
  })
  .get("/api/v2/varsets/:varset_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId);
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await variableSetResource(record) };
  })
  .patch("/api/v2/varsets/:varset_id", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : undefined;
    if (data?.type !== "varsets" || !attributes || !validVariableSetAttributes(attributes, true)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }
    if (attributes["parent-project-id"] !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The owning project of a variable set cannot be changed" }] };
    }
    const updated = {
      name: typeof attributes.name === "string" ? attributes.name.trim() : record.name,
      description: attributes.description === undefined ? record.description : (typeof attributes.description === "string" ? attributes.description : null),
      global: typeof attributes.global === "boolean" ? attributes.global : record.global,
      priority: typeof attributes.priority === "boolean" ? attributes.priority : record.priority,
    };
    if (record.parentProjectId !== null && updated.global === true) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Project-owned variable sets cannot be global" }] };
    }
    await db.update(variableSets).set(updated).where(eq(variableSets.id, record.id));
    return { data: await variableSetResource({ ...record, ...updated }) };
  })
  .delete("/api/v2/varsets/:varset_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(variableSets).where(eq(variableSets.id, record.id));
    (set as { status: number }).status = 204;
    return {};
  })
  // relationships/workspaces
  .post("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const workspaceIds = workspaceRelationshipIds(body);
    if (!workspaceIds || workspaceIds.length === 0) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] }; }
    const targets = await db.query.workspaces.findMany({ where: inArray(workspaces.id, workspaceIds) });
    if (targets.length !== workspaceIds.length || targets.some((w: Readonly<{ readonly orgId: string }>): boolean => w.orgId !== record.orgId)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Workspaces must belong to the variable set organization" }] };
    }
    await db.insert(variableSetWorkspaces).values(workspaceIds.map((wid: string): typeof variableSetWorkspaces.$inferInsert => ({ id: crypto.randomUUID(), variableSetId: record.id, workspaceId: wid }))).onConflictDoNothing();
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const workspaceIds = workspaceRelationshipIds(body);
    if (!workspaceIds || workspaceIds.length === 0) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] }; }
    await db.delete(variableSetWorkspaces).where(and(eq(variableSetWorkspaces.variableSetId, record.id), inArray(variableSetWorkspaces.workspaceId, workspaceIds)));
    (set as { status: number }).status = 204;
    return {};
  })
  // relationships/projects
  .post("/api/v2/varsets/:varset_id/relationships/projects", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const projectIds = projectRelationshipIds(body);
    if (!projectIds || projectIds.length === 0) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid project relationships" }] }; }
    const targets = await db.query.projects.findMany({ where: inArray(projects.id, projectIds) });
    if (targets.length !== projectIds.length || targets.some((p: Readonly<{ readonly orgId: string }>): boolean => p.orgId !== record.orgId)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Projects must belong to the variable set organization" }] };
    }
    await db.insert(variableSetProjects).values(projectIds.map((pid: string): typeof variableSetProjects.$inferInsert => ({ id: `vsp-${crypto.randomUUID()}`, variableSetId: record.id, projectId: pid }))).onConflictDoNothing();
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/varsets/:varset_id/relationships/projects", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const projectIds = projectRelationshipIds(body);
    if (!projectIds || projectIds.length === 0) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid project relationships" }] }; }
    await db.delete(variableSetProjects).where(and(eq(variableSetProjects.variableSetId, record.id), inArray(variableSetProjects.projectId, projectIds)));
    (set as { status: number }).status = 204;
    return {};
  })
  // relationships/vars
  .get("/api/v2/varsets/:varset_id/relationships/vars", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId);
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(variableSetVariables.variableSetId, record.id);
    const [variables, countRows] = await Promise.all([
      db.query.variableSetVariables.findMany({ where, orderBy: [asc(variableSetVariables.key)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(variableSetVariables).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: variables.map((v: VarItem): Record<string, unknown> => variableSetVariableResource(v)), ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params.varset_id ?? "";
    const varId = params.var_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId);
    const variable = record !== undefined ? await db.query.variableSetVariables.findFirst({ where: and(eq(variableSetVariables.id, varId), eq(variableSetVariables.variableSetId, record.id)) }) : undefined;
    if (variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: variableSetVariableResource(variable) };
  })
  .post("/api/v2/varsets/:varset_id/relationships/vars", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : undefined;
    if (data?.type !== "vars" || !validVariableSetVariableAttributes(attributes)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const key = typeof attributes?.key === "string" ? attributes.key : "";
    const value = typeof attributes?.value === "string" ? attributes.value : "";
    const category = typeof attributes?.category === "string" ? attributes.category : "terraform";
    const sensitive = typeof attributes?.sensitive === "boolean" ? attributes.sensitive : false;
    const description = typeof attributes?.description === "string" ? attributes.description : null;
    const variable = { id: `var-${crypto.randomUUID()}`, variableSetId: record.id, key, value, category, sensitive, description };
    try { await db.insert(variableSetVariables).values(variable); } catch (error: unknown) {
      if (isUniqueConstraintError(error)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] }; }
      throw error;
    }
    return { data: variableSetVariableResource(variable) };
  })
  .patch("/api/v2/varsets/:varset_id/relationships/vars", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const relationship = variableRelationshipResources(body);
    if (!relationship || relationship.resources.length === 0 || (relationship.resources as ResItem[]).some((item: ResItem): boolean => !validVariableSetVariableAttributes(item.attributes, true))) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] };
    }
    const ids = (relationship.resources as ResItem[]).map((item: ResItem): string => item.id);
    const variables = await db.query.variableSetVariables.findMany({ where: and(eq(variableSetVariables.variableSetId, record.id), inArray(variableSetVariables.id, ids)) });
    if (variables.length !== ids.length) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const byId = new Map(variables.map((v: VarItem): [string, VarItem] => [v.id, v]));
    const updates = (relationship.resources as ResItem[]).map((item: ResItem): { variable: VarItem; values: Record<string, unknown> } => {
      const v = byId.get(item.id);
      if (v === undefined) throw new Error("Variable not found");
      return { variable: v, values: variableSetVariableUpdate(v, item.attributes as Parameters<typeof variableSetVariableUpdate>[1]) };
    });
    try {
      await db.transaction(async (tx: unknown): Promise<void> => {
        const t = tx as typeof db;
        for (const u of updates) await t.update(variableSetVariables).set(u.values).where(eq(variableSetVariables.id, u.variable.id));
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] }; }
      throw error;
    }
    const resources = updates.map((u: Readonly<{ readonly variable: VarItem; readonly values: Readonly<Record<string, unknown>> }>): Record<string, unknown> => variableSetVariableResource({ ...u.variable, ...u.values }));


    return { data: relationship.many ? resources : resources[0] };
  })
  .delete("/api/v2/varsets/:varset_id/relationships/vars", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params.varset_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const relationship = variableRelationshipResources(body);
    const ids = ((relationship ?? { resources: [] }).resources as ResItem[]).map((item: ResItem): string => item.id);
    if (ids.length === 0) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] }; }
    const variables = await db.query.variableSetVariables.findMany({ where: and(eq(variableSetVariables.variableSetId, record.id), inArray(variableSetVariables.id, ids)) });
    if (variables.length !== ids.length) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(variableSetVariables).where(and(eq(variableSetVariables.variableSetId, record.id), inArray(variableSetVariables.id, ids)));
    (set as { status: number }).status = 204;
    return {};
  })
  .patch("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params.varset_id ?? "";
    const varId = params.var_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    const variable = record !== undefined ? await db.query.variableSetVariables.findFirst({ where: and(eq(variableSetVariables.id, varId), eq(variableSetVariables.variableSetId, record.id)) }) : undefined;
    if (record === undefined || variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : undefined;
    if (data?.type !== "vars" || !validVariableSetVariableAttributes(attributes, true)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const updated = variableSetVariableUpdate(variable, attributes as Parameters<typeof variableSetVariableUpdate>[1]);
    try { await db.update(variableSetVariables).set(updated).where(eq(variableSetVariables.id, variable.id)); } catch (error: unknown) {
      if (isUniqueConstraintError(error)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] }; }
      throw error;
    }
    return { data: variableSetVariableResource({ ...variable, ...updated }) };
  })
  .delete("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const varsetId = params.varset_id ?? "";
    const varId = params.var_id ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    const variable = record !== undefined ? await db.query.variableSetVariables.findFirst({ where: and(eq(variableSetVariables.id, varId), eq(variableSetVariables.variableSetId, record.id)) }) : undefined;
    if (record === undefined || variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(variableSetVariables).where(eq(variableSetVariables.id, variable.id));
    (set as { status: number }).status = 204;
    return {};
  });
