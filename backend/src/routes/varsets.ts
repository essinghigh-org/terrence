import { Elysia } from "elysia";
import { db } from "../db";
import { variableSets, variableSetWorkspaces, variableSetProjects, variableSetVariables, stackVariableSets, stacks, workspaces, projects, type users } from "../db/schema";
import { eq, and, asc, count, inArray } from "drizzle-orm";
import { variableSetResource, variableSetVariableResource, variableSetVariableUpdate } from "../lib/response";
import { validVariableSetAttributes, validVariableSetVariableAttributes, isUniqueConstraintError } from "../lib/validation";
import { variableValueForWrite } from "../lib/variable-crypto";
import { caseInsensitiveLike, checkOrganizationPermission, findAuthorizedVariableSet, pageRequest, pagination, workspaceRelationshipIds, projectRelationshipIds, stackRelationshipIds, variableRelationshipResources, scopeWorkspaceIdsForOrg } from "../lib/utils";
import { scopeCoversOrg, scopeGrants } from "../lib/token-scopes";
import { currentTokenScopes } from "../lib/request-scope";
import { authPlugin } from "../auth";
import { cachedOrgByName } from "../lib/cached-lookups";

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
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-varsets"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const url = new URL(request.url);
    const search = url.searchParams.get("q")?.trim() ?? "";
    const projectFilter = url.searchParams.get("filter[project][id]")?.trim() ?? "";
    const scopes = currentTokenScopes();
    if (scopes !== null && (!scopeCoversOrg(scopes, org.id) || !scopeGrants(scopes, "varsets:read"))) {
      return { data: [], ...pagination(request, number, size, 0) };
    }
    const scope = eq(variableSets.orgId, org.id);
    const conditions: (typeof scope)[] = [scope];
    if (search !== "") conditions.push(caseInsensitiveLike(variableSets.name, `%${search}%`));
    if (scopes !== null) {
      const workspaceIds = await scopeWorkspaceIdsForOrg(scopes, org.id);
      if (workspaceIds !== null) {
        const scopedProjects = new Set<string>(scopes.projects ?? []);
        if (workspaceIds.length > 0) {
          const workspaceRows = await db.query.workspaces.findMany({
            where: inArray(workspaces.id, [...workspaceIds]),
            columns: { projectId: true },
          });
          for (const workspace of workspaceRows) {
            if (workspace.projectId !== null) scopedProjects.add(workspace.projectId);
          }
        }
        const [workspaceLinks, projectLinks, ownedSets, globalSets] = await Promise.all([
          workspaceIds.length === 0 ? [] : db.query.variableSetWorkspaces.findMany({
            where: inArray(variableSetWorkspaces.workspaceId, [...workspaceIds]),
            columns: { variableSetId: true },
          }),
          scopedProjects.size === 0 ? [] : db.query.variableSetProjects.findMany({
            where: inArray(variableSetProjects.projectId, [...scopedProjects]),
            columns: { variableSetId: true },
          }),
          scopedProjects.size === 0 ? [] : db.query.variableSets.findMany({
            where: and(eq(variableSets.orgId, org.id), inArray(variableSets.parentProjectId, [...scopedProjects])),
            columns: { id: true },
          }),
          db.query.variableSets.findMany({
            where: and(eq(variableSets.orgId, org.id), eq(variableSets.global, true)),
            columns: { id: true },
          }),
        ]);
        const visibleIds = new Set<string>([
          ...workspaceLinks.map((row): string => row.variableSetId),
          ...projectLinks.map((row): string => row.variableSetId),
          ...ownedSets.map((row): string => row.id),
          ...globalSets.map((row): string => row.id),
        ]);
        if (visibleIds.size === 0) return { data: [], ...pagination(request, number, size, 0) };
        conditions.push(inArray(variableSets.id, [...visibleIds]));
      }
    }
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
    const [records, countRows] = await Promise.all([
      db.query.variableSets.findMany({ where, orderBy: [asc(variableSets.name)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(variableSets).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
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
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-varsets"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : undefined;
    if (data?.["type"] !== "varsets" || attributes === undefined || attributes === null || !validVariableSetAttributes(attributes)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }
    const name = typeof attributes["name"] === "string" ? attributes["name"].trim() : "";
    const description = typeof attributes["description"] === "string" ? attributes["description"] : null;
    const global = typeof attributes["global"] === "boolean" ? attributes["global"] : false;
    const priority = typeof attributes["priority"] === "boolean" ? attributes["priority"] : false;
    const parentProjectId = typeof attributes["parent-project-id"] === "string"
      ? attributes["parent-project-id"]
      : null;
    if (parentProjectId !== null) {
      const parent = await db.query.projects.findFirst({ where: eq(projects.id, parentProjectId) });
      if (parent === undefined || parent.orgId !== org.id) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Parent project must belong to the organization" }] };
      }
      // the reference format: project-owned variable sets cannot be global.
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
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId);
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await variableSetResource(record) };
  })
  .patch("/api/v2/varsets/:varset_id", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : undefined;
    if (data?.["type"] !== "varsets" || !attributes || !validVariableSetAttributes(attributes, true)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }
    if (attributes["parent-project-id"] !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The owning project of a variable set cannot be changed" }] };
    }
    const updated = {
      name: typeof attributes["name"] === "string" ? attributes["name"].trim() : record.name,
      description: attributes["description"] === undefined ? record.description : (typeof attributes["description"] === "string" ? attributes["description"] : null),
      global: typeof attributes["global"] === "boolean" ? attributes["global"] : record.global,
      priority: typeof attributes["priority"] === "boolean" ? attributes["priority"] : record.priority,
    };
    if (record.parentProjectId !== null && updated.global === true) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Project-owned variable sets cannot be global" }] };
    }
    await db.update(variableSets).set(updated).where(eq(variableSets.id, record.id));
    return { data: await variableSetResource({ ...record, ...updated }) };
  })
  .delete("/api/v2/varsets/:varset_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(variableSets).where(eq(variableSets.id, record.id));
    (set as { status: number }).status = 204;
    return {};
  })
  // relationships/workspaces
  .post("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const workspaceIds = workspaceRelationshipIds(body);
    if (workspaceIds === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] }; }
    // JSON:API no-op: an explicit empty add/remove does nothing (the reference format accepts it).
    if (workspaceIds.length === 0) { (set as { status: number }).status = 204; return {}; }
    const targets = await db.query.workspaces.findMany({ where: inArray(workspaces.id, workspaceIds) });
    if (targets.length !== workspaceIds.length || targets.some((w: Readonly<{ readonly orgId: string }>): boolean => w.orgId !== record.orgId)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Workspaces must belong to the variable set organization" }] };
    }
    await db.insert(variableSetWorkspaces).values(workspaceIds.map((wid: string): typeof variableSetWorkspaces.$inferInsert => ({ id: crypto.randomUUID(), variableSetId: record.id, workspaceId: wid }))).onConflictDoNothing();
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId);
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const links = await db.query.variableSetWorkspaces.findMany({
      where: eq(variableSetWorkspaces.variableSetId, record.id),
      orderBy: [asc(variableSetWorkspaces.workspaceId)],
    });
    return { data: links.map((link: { readonly workspaceId: string }): Record<string, string> => ({ id: link.workspaceId, type: "workspaces" })) };
  })
  .delete("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const workspaceIds = workspaceRelationshipIds(body);
    if (workspaceIds === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] }; }
    // JSON:API no-op: an explicit empty add/remove does nothing (the reference format accepts it).
    if (workspaceIds.length === 0) { (set as { status: number }).status = 204; return {}; }
    await db.delete(variableSetWorkspaces).where(and(eq(variableSetWorkspaces.variableSetId, record.id), inArray(variableSetWorkspaces.workspaceId, workspaceIds)));
    (set as { status: number }).status = 204;
    return {};
  })
  // relationships/projects
  .post("/api/v2/varsets/:varset_id/relationships/projects", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const projectIds = projectRelationshipIds(body);
    if (projectIds === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid project relationships" }] }; }
    // JSON:API no-op: an explicit empty add/remove does nothing (the reference format accepts it).
    if (projectIds.length === 0) { (set as { status: number }).status = 204; return {}; }
    const targets = await db.query.projects.findMany({ where: inArray(projects.id, projectIds) });
    if (targets.length !== projectIds.length || targets.some((p: Readonly<{ readonly orgId: string }>): boolean => p.orgId !== record.orgId)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Projects must belong to the variable set organization" }] };
    }
    await db.insert(variableSetProjects).values(projectIds.map((pid: string): typeof variableSetProjects.$inferInsert => ({ id: `vsp-${crypto.randomUUID()}`, variableSetId: record.id, projectId: pid }))).onConflictDoNothing();
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/varsets/:varset_id/relationships/projects", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const projectIds = projectRelationshipIds(body);
    if (projectIds === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid project relationships" }] }; }
    // JSON:API no-op: an explicit empty add/remove does nothing (the reference format accepts it).
    if (projectIds.length === 0) { (set as { status: number }).status = 204; return {}; }
    await db.delete(variableSetProjects).where(and(eq(variableSetProjects.variableSetId, record.id), inArray(variableSetProjects.projectId, projectIds)));
    (set as { status: number }).status = 204;
    return {};
  })
  // relationships/stacks (tfe_stack_variable_set — go-tfe VariableSets.ApplyToStacks / RemoveFromStacks)
  .post("/api/v2/varsets/:varset_id/relationships/stacks", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const stackIds = stackRelationshipIds(body);
    if (stackIds === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid stack relationships" }] }; }
    // JSON:API no-op: an explicit empty add/remove does nothing (the reference format accepts it).
    if (stackIds.length === 0) { (set as { status: number }).status = 204; return {}; }
    const targets = await db.query.stacks.findMany({ where: inArray(stacks.id, stackIds) });
    if (targets.length !== stackIds.length || targets.some((s: Readonly<{ readonly orgId: string }>): boolean => s.orgId !== record.orgId)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Stacks must belong to the variable set organization" }] };
    }
    await db.insert(stackVariableSets).values(stackIds.map((sid: string): typeof stackVariableSets.$inferInsert => ({ stackId: sid, variableSetId: record.id }))).onConflictDoNothing();
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/varsets/:varset_id/relationships/stacks", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const stackIds = stackRelationshipIds(body);
    if (stackIds === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid stack relationships" }] }; }
    // JSON:API no-op: an explicit empty add/remove does nothing (the reference format accepts it).
    if (stackIds.length === 0) { (set as { status: number }).status = 204; return {}; }
    await db.delete(stackVariableSets).where(and(eq(stackVariableSets.variableSetId, record.id), inArray(stackVariableSets.stackId, stackIds)));
    (set as { status: number }).status = 204;
    return {};
  })
  // relationships/vars
  .get("/api/v2/varsets/:varset_id/relationships/vars", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params["varset_id"] ?? "";
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
    const varsetId = params["varset_id"] ?? "";
    const varId = params["var_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId);
    const variable = record !== undefined ? await db.query.variableSetVariables.findFirst({ where: and(eq(variableSetVariables.id, varId), eq(variableSetVariables.variableSetId, record.id)) }) : undefined;
    if (variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: variableSetVariableResource(variable) };
  })
  .post("/api/v2/varsets/:varset_id/relationships/vars", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : undefined;
    if (data?.["type"] !== "vars" || !validVariableSetVariableAttributes(attributes)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const key = typeof attributes?.["key"] === "string" ? attributes["key"] : "";
    const rawValue = typeof attributes?.["value"] === "string" ? attributes["value"] : "";
    const category = typeof attributes?.["category"] === "string" ? attributes["category"] : "terraform";
    const sensitive = typeof attributes?.["sensitive"] === "boolean" ? attributes["sensitive"] : false;
    const hcl = typeof attributes?.["hcl"] === "boolean" ? attributes["hcl"] : false;
    const description = typeof attributes?.["description"] === "string" ? attributes["description"] : null;
    // Sensitive values are encrypted at rest (todo 167/168).
    const stored = await variableValueForWrite(sensitive, rawValue);
    const variable = { id: `var-${crypto.randomUUID()}`, variableSetId: record.id, key, value: stored.value, valueEncrypted: stored.valueEncrypted, category, sensitive, hcl, description };
    try { await db.insert(variableSetVariables).values(variable); } catch (error: unknown) {
      if (isUniqueConstraintError(error)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] }; }
      throw error;
    }
    (set as { status: number }).status = 201;
    return { data: variableSetVariableResource(variable) };
  })
  .patch("/api/v2/varsets/:varset_id/relationships/vars", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const relationship = variableRelationshipResources(body);
    if (relationship === undefined) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] };
    }
    // JSON:API no-op: an explicit empty bulk PATCH does nothing (the reference format accepts it).
    if (relationship.resources.length === 0) { (set as { status: number }).status = 204; return {}; }
    if ((relationship.resources as ResItem[]).some((item: ResItem): boolean => !validVariableSetVariableAttributes(item.attributes, true))) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] };
    }
    const ids = (relationship.resources as ResItem[]).map((item: ResItem): string => item.id);
    const variables = await db.query.variableSetVariables.findMany({ where: and(eq(variableSetVariables.variableSetId, record.id), inArray(variableSetVariables.id, ids)) });
    if (variables.length !== ids.length) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const byId = new Map(variables.map((v: VarItem): [string, VarItem] => [v.id, v]));
    const updates = await Promise.all((relationship.resources as ResItem[]).map(async (item: ResItem): Promise<{ variable: VarItem; values: Record<string, unknown> }> => {
      const v = byId.get(item.id);
      if (v === undefined) throw new Error("Variable not found");
      const base = variableSetVariableUpdate(v, item.attributes as Parameters<typeof variableSetVariableUpdate>[1]);
      const sensitiveNow = base["sensitive"] === true;
      const valueChanged = base["value"] !== v.value;
      const sensitiveChanged = sensitiveNow !== (v.sensitive === true);
      if (valueChanged || sensitiveChanged) {
        const stored = await variableValueForWrite(sensitiveNow, base["value"] as string);
        base["value"] = stored.value;
        (base)["valueEncrypted"] = stored.valueEncrypted;
      } else {
        (base)["valueEncrypted"] = v.valueEncrypted;
      }
      return { variable: v, values: base };
    }));
    try {
      await db.transaction(async (tx: unknown): Promise<void> => {
        const t = tx as typeof db;
        // Independent same-shaped updates: run them concurrently inside the
        // transaction so a single queue tick is one round-trip, not N.
        await Promise.all(updates.map(
          async (u): Promise<unknown> => t.update(variableSetVariables).set(u.values).where(eq(variableSetVariables.id, u.variable.id)),
        ));
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] }; }
      throw error;
    }
    const resources = updates.map((u: Readonly<{ readonly variable: VarItem; readonly values: Readonly<Record<string, unknown>> }>): Record<string, unknown> => variableSetVariableResource({ ...u.variable, ...u.values }));


    return { data: relationship.many ? resources : resources[0] };
  })
  .delete("/api/v2/varsets/:varset_id/relationships/vars", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const varsetId = params["varset_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const relationship = variableRelationshipResources(body);
    if (relationship === undefined) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] };
    }
    // JSON:API no-op: an explicit empty bulk DELETE does nothing (the reference format accepts it).
    if (relationship.resources.length === 0) { (set as { status: number }).status = 204; return {}; }
    const ids = (relationship.resources as ResItem[]).map((item: ResItem): string => item.id);
    const variables = await db.query.variableSetVariables.findMany({ where: and(eq(variableSetVariables.variableSetId, record.id), inArray(variableSetVariables.id, ids)) });
    if (variables.length !== ids.length) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(variableSetVariables).where(and(eq(variableSetVariables.variableSetId, record.id), inArray(variableSetVariables.id, ids)));
    (set as { status: number }).status = 204;
    return {};
  })
  .patch("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params, user, orgId, teamId, body, set }: ParamCtx): Promise<unknown> => {
    const varsetId = params["varset_id"] ?? "";
    const varId = params["var_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    const variable = record !== undefined ? await db.query.variableSetVariables.findFirst({ where: and(eq(variableSetVariables.id, varId), eq(variableSetVariables.variableSetId, record.id)) }) : undefined;
    if (record === undefined || variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : undefined;
    if (data?.["type"] !== "vars" || !validVariableSetVariableAttributes(attributes, true)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const updated = variableSetVariableUpdate(variable, attributes as Parameters<typeof variableSetVariableUpdate>[1]);
    // Re-encrypt when the value or sensitive flag changed (todo 167-169).
    const sensitiveNow = updated["sensitive"] === true;
    const valueChanged = updated["value"] !== variable.value;
    const sensitiveChanged = sensitiveNow !== (variable.sensitive === true);
    if (valueChanged || sensitiveChanged) {
      const stored = await variableValueForWrite(sensitiveNow, updated["value"] as string);
      updated["value"] = stored.value;
      updated["valueEncrypted"] = stored.valueEncrypted;
    } else {
      updated["valueEncrypted"] = variable.valueEncrypted;
    }
    try { await db.update(variableSetVariables).set(updated).where(eq(variableSetVariables.id, variable.id)); } catch (error: unknown) {
      if (isUniqueConstraintError(error)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] }; }
      throw error;
    }
    return { data: variableSetVariableResource({ ...variable, ...updated }) };
  })
  .delete("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const varsetId = params["varset_id"] ?? "";
    const varId = params["var_id"] ?? "";
    const record = await findAuthorizedVariableSet(varsetId, user?.id, orgId, teamId, "manage-varsets");
    const variable = record !== undefined ? await db.query.variableSetVariables.findFirst({ where: and(eq(variableSetVariables.id, varId), eq(variableSetVariables.variableSetId, record.id)) }) : undefined;
    if (record === undefined || variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(variableSetVariables).where(eq(variableSetVariables.id, variable.id));
    (set as { status: number }).status = 204;
    return {};
  });
