import { Elysia } from "elysia";
import { db } from "../db";
import { variableSets, variableSetWorkspaces, variableSetProjects, variableSetVariables, workspaces, projects, organizations } from "../db/schema";
import { eq, and, asc, like, count, inArray } from "drizzle-orm";
import { variableSetResource, variableSetVariableResource, variableSetVariableUpdate } from "../lib/response";
import { validVariableSetAttributes, validVariableSetVariableAttributes, isUniqueConstraintError } from "../lib/validation";
import { checkOrgPermission, findAuthorizedVariableSet, pageRequest, pagination, workspaceRelationshipIds, projectRelationshipIds, variableRelationshipResources } from "../lib/utils";
import { authPlugin } from "../auth";

export const varsetRoutes = new Elysia({ name: "varsets" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/varsets", async ({ params: { org_name }, user, orgId, request, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const search = new URL(request.url).searchParams.get("q")?.trim();
    const scope = eq(variableSets.orgId, org.id);
    const where = search ? and(scope, like(variableSets.name, `%${search}%`)) : scope;
    const [records, [{ total }]] = await Promise.all([
      db.query.variableSets.findMany({ where, orderBy: [asc(variableSets.name)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(variableSets).where(where),
    ]);
    return { data: await Promise.all(records.map(variableSetResource)), ...pagination(request, number, size, total) };
  })
  .post("/api/v2/organizations/:org_name/varsets", async ({ params: { org_name }, user, orgId, body, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "varsets" || !validVariableSetAttributes(attributes)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }
    const record = { id: `varset-${crypto.randomUUID()}`, orgId: org.id, name: attributes.name.trim(), description: attributes.description ?? null, global: attributes.global ?? false, priority: attributes.priority ?? false };
    await db.insert(variableSets).values(record);
    set.status = 201;
    return { data: await variableSetResource(record) };
  })
  .get("/api/v2/varsets/:varset_id", async ({ params: { varset_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await variableSetResource(record) };
  })
  .patch("/api/v2/varsets/:varset_id", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "varsets" || !validVariableSetAttributes(attributes, true)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }
    const updated = {
      name: attributes.name === undefined ? record.name : attributes.name.trim(),
      description: attributes.description === undefined ? record.description : attributes.description,
      global: attributes.global === undefined ? record.global : attributes.global,
      priority: attributes.priority === undefined ? record.priority : attributes.priority,
    };
    await db.update(variableSets).set(updated).where(eq(variableSets.id, record.id));
    return { data: await variableSetResource({ ...record, ...updated }) };
  })
  .delete("/api/v2/varsets/:varset_id", async ({ params: { varset_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(variableSets).where(eq(variableSets.id, record.id));
    set.status = 204;
  })
  // relationships/workspaces
  .post("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const workspaceIds = workspaceRelationshipIds(body);
    if (!workspaceIds) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] }; }
    const targets = await db.query.workspaces.findMany({ where: inArray(workspaces.id, workspaceIds) });
    if (targets.length !== workspaceIds.length || targets.some(w => w.orgId !== record.orgId)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Workspaces must belong to the variable set organization" }] };
    }
    await db.insert(variableSetWorkspaces).values(workspaceIds.map(wid => ({ id: crypto.randomUUID(), variableSetId: record.id, workspaceId: wid }))).onConflictDoNothing();
    set.status = 204;
  })
  .delete("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const workspaceIds = workspaceRelationshipIds(body);
    if (!workspaceIds) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] }; }
    await db.delete(variableSetWorkspaces).where(and(eq(variableSetWorkspaces.variableSetId, record.id), inArray(variableSetWorkspaces.workspaceId, workspaceIds)));
    set.status = 204;
  })
  // relationships/projects
  .post("/api/v2/varsets/:varset_id/relationships/projects", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const projectIds = projectRelationshipIds(body);
    if (!projectIds) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid project relationships" }] }; }
    const targets = await db.query.projects.findMany({ where: inArray(projects.id, projectIds) });
    if (targets.length !== projectIds.length || targets.some(p => p.orgId !== record.orgId)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Projects must belong to the variable set organization" }] };
    }
    await db.insert(variableSetProjects).values(projectIds.map(pid => ({ id: `vsp-${crypto.randomUUID()}`, variableSetId: record.id, projectId: pid }))).onConflictDoNothing();
    set.status = 204;
  })
  .delete("/api/v2/varsets/:varset_id/relationships/projects", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const projectIds = projectRelationshipIds(body);
    if (!projectIds) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid project relationships" }] }; }
    await db.delete(variableSetProjects).where(and(eq(variableSetProjects.variableSetId, record.id), inArray(variableSetProjects.projectId, projectIds)));
    set.status = 204;
  })
  // relationships/vars
  .get("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, request, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(variableSetVariables.variableSetId, record.id);
    const [variables, [{ total }]] = await Promise.all([
      db.query.variableSetVariables.findMany({ where, orderBy: [asc(variableSetVariables.key)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(variableSetVariables).where(where),
    ]);
    return { data: variables.map(variableSetVariableResource), ...pagination(request, number, size, total) };
  })
  .get("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params: { varset_id, var_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    const variable = record ? await db.query.variableSetVariables.findFirst({ where: and(eq(variableSetVariables.id, var_id), eq(variableSetVariables.variableSetId, record.id)) }) : undefined;
    if (!variable) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: variableSetVariableResource(variable) };
  })
  .post("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "vars" || !validVariableSetVariableAttributes(attributes)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const variable = { id: `var-${crypto.randomUUID()}`, variableSetId: record.id, key: attributes.key, value: attributes.value ?? "", category: attributes.category ?? "terraform", sensitive: attributes.sensitive ?? false, description: attributes.description ?? null };
    try { await db.insert(variableSetVariables).values(variable); } catch (error: any) {
      if (isUniqueConstraintError(error)) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] }; }
      throw error;
    }
    return { data: variableSetVariableResource(variable) };
  })
  .patch("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const relationship = variableRelationshipResources(body);
    if (!relationship || relationship.resources.some(item => !validVariableSetVariableAttributes(item.attributes, true))) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] };
    }
    const ids = relationship.resources.map(item => item.id as string);
    const variables = await db.query.variableSetVariables.findMany({ where: and(eq(variableSetVariables.variableSetId, record.id), inArray(variableSetVariables.id, ids)) });
    if (variables.length !== ids.length) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const byId = new Map(variables.map(v => [v.id, v]));
    const updates = relationship.resources.map(item => { const v = byId.get(item.id)!; return { variable: v, values: variableSetVariableUpdate(v, item.attributes) }; });
    try {
      await db.transaction(async tx => {
        for (const u of updates) await tx.update(variableSetVariables).set(u.values).where(eq(variableSetVariables.id, u.variable.id));
      });
    } catch (error: any) {
      if (isUniqueConstraintError(error)) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] }; }
      throw error;
    }
    const resources = updates.map(u => variableSetVariableResource({ ...u.variable, ...u.values }));
    return { data: relationship.many ? resources : resources[0] };
  })
  .delete("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const relationship = variableRelationshipResources(body);
    if (!relationship) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] }; }
    const ids = relationship.resources.map(item => item.id as string);
    const variables = await db.query.variableSetVariables.findMany({ where: and(eq(variableSetVariables.variableSetId, record.id), inArray(variableSetVariables.id, ids)) });
    if (variables.length !== ids.length) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(variableSetVariables).where(and(eq(variableSetVariables.variableSetId, record.id), inArray(variableSetVariables.id, ids)));
    set.status = 204;
  })
  .patch("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params: { varset_id, var_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    const variable = record ? await db.query.variableSetVariables.findFirst({ where: and(eq(variableSetVariables.id, var_id), eq(variableSetVariables.variableSetId, record.id)) }) : undefined;
    if (!record || !variable) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "vars" || !validVariableSetVariableAttributes(attributes, true)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const updated = variableSetVariableUpdate(variable, attributes);
    try { await db.update(variableSetVariables).set(updated).where(eq(variableSetVariables.id, variable.id)); } catch (error: any) {
      if (error.message?.includes("UNIQUE") || error.code === "SQLITE_CONSTRAINT_UNIQUE") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] }; }
      throw error;
    }
    return { data: variableSetVariableResource({ ...variable, ...updated }) };
  })
  .delete("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params: { varset_id, var_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    const variable = record ? await db.query.variableSetVariables.findFirst({ where: and(eq(variableSetVariables.id, var_id), eq(variableSetVariables.variableSetId, record.id)) }) : undefined;
    if (!record || !variable) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(variableSetVariables).where(eq(variableSetVariables.id, variable.id));
    set.status = 204;
  });
