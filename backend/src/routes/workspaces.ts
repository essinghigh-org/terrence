/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { Elysia } from "elysia";
import { db } from "../db";
import { workspaces, workspaceTags, workspaceVariables, organizations, stateVersions, runs, configurationVersions, logs, dataRetentionPolicies, remoteStateConsumers, sshKeys, projects, auditLogs, users } from "../db/schema";
import { eq, and, desc, asc, count, inArray, like, ne, notInArray, or, sql, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { workspaceResource, workspaceVariableResource, tagBindingResource, projectResource, stateVersionResource, projectTagBindingResource } from "../lib/response";
import { validVariableAttributes } from "../lib/validation";
import { validateVersion, checkOrgPermission, findAuthorizedWorkspace, findWorkspaceByName, pageRequest, pagination, parseTagBindings, auditLog, applyDataRetentionGarbageCollection, decodeStatePayload, deleteWorkspaceData, safeDeleteWorkspace } from "../lib/utils";
import { normalizeWorkingDirectory } from "../workspace";
import { authPlugin } from "../auth";

export const workspaceRoutes = new Elysia({ name: "workspaces" })
  .use(authPlugin)
  // --- Organization Workspaces ---
  .get("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, user, orgId: principalOrgId, request, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const params = new URL(request.url).searchParams;
    const csv = (name: string) => [...new Set(params.get(name)?.split(",").filter(Boolean) ?? [])];
    const conditions: any[] = [eq(workspaces.orgId, org.id)];
    const search = params.get("search[name]")?.trim() || params.get("q")?.trim();
    if (search) conditions.push(like(workspaces.name, `%${search}%`));
    const tags = csv("search[tags]");
    if (tags.length > 0) {
      const taggedWsIds = (await db.query.workspaceTags.findMany({
        where: and(inArray(workspaceTags.key, tags)),
        columns: { workspaceId: true },
      })).map(t => t.workspaceId);
      conditions.push(inArray(workspaces.id, [...new Set(taggedWsIds)]));
    }
    const excludeTags = params.get("search[exclude-tags]")?.trim();
    if (excludeTags) {
      const excludedIds = (await db.query.workspaceTags.findMany({
        where: eq(workspaceTags.key, excludeTags),
        columns: { workspaceId: true },
      })).map(t => t.workspaceId);
      conditions.push(notInArray(workspaces.id, [...new Set(excludedIds)]));
    }
    const projectIds = csv("filter[project][id]");
    if (projectIds.length > 0) conditions.push(inArray(workspaces.projectId, projectIds));
    const currentRunStatuses = csv("filter[current-run][status]");
    if (currentRunStatuses.length > 0) {
      const matchingWsIds = (await db.query.runs.findMany({
        where: and(inArray(runs.status, currentRunStatuses)),
        columns: { workspaceId: true },
      })).map(r => r.workspaceId);
      conditions.push(inArray(workspaces.id, [...new Set(matchingWsIds)]));
    }
    const where = and(...conditions);
    const [wsList, [{ total }]] = await Promise.all([
      db.query.workspaces.findMany({ where, orderBy: [asc(workspaces.name)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(workspaces).where(where),
    ]);
    return { data: await Promise.all(wsList.map(async w => workspaceResource(w, org.defaultIacBinary, Boolean(user)))), ...pagination(request, number, size, total) };
  })
  .post("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, body, user, orgId: principalOrgId, request, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const attributes = (body as any)?.data?.attributes || {};
    const { name, description, "auto-apply": autoApply, "terraform-version": terraformVersion, "working-directory": workingDirectory, "source-name": sourceName, "source-url": sourceUrl, "iac-binary": iacBinary, "execution-mode": executionMode } = attributes;
    if (!name || typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] };
    }
    if (await findWorkspaceByName(org.id, name)) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] };
    }
    if (description !== undefined && description !== null && typeof description !== "string") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] };
    }
    if (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] };
    }
    if (executionMode !== undefined && executionMode !== "remote") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only remote execution mode is supported" }] };
    }
    if (iacBinary !== undefined && iacBinary !== null && !["tofu", "terraform"].includes(iacBinary)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] };
    }
    let normalizedWorkingDirectory: string | null = null;
    if (workingDirectory !== undefined && workingDirectory !== null) {
      try { normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory); } catch (error: any) {
        set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error.message }] };
      }
    }
    const id = crypto.randomUUID();
    const projectRel = (body as any)?.data?.relationships?.project?.data;
    const projectId = projectRel ? projectRel.id : null;
    await db.insert(workspaces).values({
      id, name, orgId: org.id, description: description ?? null, projectId,
      autoApply: autoApply ?? false, terraformVersion: terraformVersion ?? "latest",
      workingDirectory: normalizedWorkingDirectory, sourceName: sourceName ?? null,
      sourceUrl: sourceUrl ?? null, iacBinary: iacBinary ?? org.defaultIacBinary ?? null,
      createdAt: Date.now(),
    });
    const ws = (await db.query.workspaces.findFirst({ where: eq(workspaces.id, id) }))!;
    set.status = 201;
    return { data: await workspaceResource(ws, org.defaultIacBinary, Boolean(user)) };
  })
  .get("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspace_name)) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", principalOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await workspaceResource(ws, org.defaultIacBinary, Boolean(user)) };
  })
  .patch("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, body, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspace_name)) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", principalOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return updateWorkspaceResponse(ws, org.defaultIacBinary, Boolean(user), body, set);
  })
  .delete("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspace_name)) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", principalOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await deleteWorkspaceData(ws.id);
    set.status = 204;
    return;
  })
  .post("/api/v2/organizations/:org_name/workspaces/:workspace_name/actions/safe-delete", async ({ params: { org_name, workspace_name }, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspace_name)) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", principalOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ok = await safeDeleteWorkspace(ws.id);
    if (!ok) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace contains managed resources" }] }; }
    return { data: { status: "ok" } };
  })
  .get("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return { data: await workspaceResource(ws, org?.defaultIacBinary, Boolean(user)) };
  })
  .patch("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, body, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return updateWorkspaceResponse(ws, org?.defaultIacBinary, Boolean(user), body, set);
  })
  .delete("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await deleteWorkspaceData(ws.id);
    set.status = 204;
    return;
  })
  .post("/api/v2/workspaces/:workspace_id/actions/safe-delete", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ok = await safeDeleteWorkspace(ws.id);
    if (!ok) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace contains managed resources" }] }; }
    return { data: { status: "ok" } };
  })
  // --- Tags ---
  .get("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspace_id), orderBy: [asc(workspaceTags.key)] });
    return { data: tags.map(t => tagBindingResource(t)) };
  })
  .get("/api/v2/workspaces/:workspace_id/effective-tag-bindings", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspace_id), orderBy: [asc(workspaceTags.key)] });
    return { data: tags.map(t => tagBindingResource(t, true)) };
  })
  .patch("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params: { workspace_id }, body, user, orgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const data = (body as any)?.data;
    const tags = Array.isArray(data) ? data : (data ? [data] : []);
    const entries = tags.map((t: any) => ({ key: t?.attributes?.key, value: t?.attributes?.value ?? null })).filter((e: any) => e.key && typeof e.key === "string");
    await db.transaction(async tx => {
      await tx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspace_id));
      if (entries.length > 0) {
        await tx.insert(workspaceTags).values(entries.map((e: any) => ({ id: crypto.randomUUID(), workspaceId: workspace_id, key: e.key, value: e.value ?? "" })));
      }
    });
    const updatedTags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspace_id), orderBy: [asc(workspaceTags.key)] });
    return { data: updatedTags.map(t => tagBindingResource(t)) };
  })
  .get("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspace_id) });
    return { data: tags.map(t => ({ id: t.key, type: "tags" })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, body, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const items = (body as any)?.data;
    if (Array.isArray(items)) {
      for (const item of items) {
        const key = item?.attributes?.key ?? item?.id;
        if (key && typeof key === "string") {
          await db.insert(workspaceTags).values({ id: crypto.randomUUID(), workspaceId: workspace_id, key, value: item?.attributes?.value ?? "" }).onConflictDoNothing();
        }
      }
    }
    set.status = 204;
    return;
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, body, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const items = (body as any)?.data;
    if (Array.isArray(items)) {
      const keys = items.map(i => i?.id).filter(Boolean);
      if (keys.length > 0) await db.delete(workspaceTags).where(and(eq(workspaceTags.workspaceId, workspace_id), inArray(workspaceTags.key, keys)));
    }
    set.status = 204;
    return;
  })
  // --- Workspace Variables ---
  .get("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(workspaceVariables.workspaceId, workspace_id);
    const [vars, [{ total }]] = await Promise.all([
      db.query.workspaceVariables.findMany({ where, orderBy: [asc(workspaceVariables.key)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(workspaceVariables).where(where),
    ]);
    return { data: vars.map(workspaceVariableResource), ...pagination(request, number, size, total) };
  })
  .post("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, body, user, orgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "vars" || !validVariableAttributes(attributes)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const varId = `wsvar-${crypto.randomUUID()}`;
    await db.insert(workspaceVariables).values({
      id: varId, workspaceId: workspace_id, key: attributes.key, value: attributes.value ?? "",
      category: attributes.category ?? "terraform", sensitive: attributes.sensitive ?? false,
      hcl: attributes.hcl ?? false, description: attributes.description ?? null,
    });
    set.status = 201;
    return { data: workspaceVariableResource({ id: varId, workspaceId: workspace_id, key: attributes.key, value: attributes.value ?? "", category: attributes.category ?? "terraform", sensitive: attributes.sensitive ?? false, hcl: attributes.hcl ?? false, description: attributes.description ?? null }) };
  })
  .get("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, user, orgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, var_id), eq(workspaceVariables.workspaceId, workspace_id)) });
    if (!variable) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: workspaceVariableResource(variable) };
  })
  .patch("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, body, user, orgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, var_id), eq(workspaceVariables.workspaceId, workspace_id)) });
    if (!variable) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const data = (body as any)?.data;
    const attrs = data?.attributes || {};
    if (data?.type !== "vars" || !validVariableAttributes(attrs, true)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    let sensitive = attrs.sensitive === undefined ? variable.sensitive : attrs.sensitive;
    if (variable.sensitive && sensitive === false && attrs.value === undefined) sensitive = true;
    const updated = {
      key: attrs.key === undefined ? variable.key : attrs.key,
      value: attrs.value === undefined ? variable.value : attrs.value,
      category: attrs.category === undefined ? variable.category : attrs.category,
      sensitive,
      hcl: attrs.hcl === undefined ? variable.hcl : attrs.hcl,
      description: attrs.description === undefined ? variable.description : attrs.description,
    };
    try { await db.update(workspaceVariables).set(updated).where(eq(workspaceVariables.id, var_id)); } catch (error: any) {
      if (error.message?.includes("UNIQUE") || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this workspace" }] };
      }
      throw error;
    }
    return { data: workspaceVariableResource({ ...variable, ...updated }) };
  })
  .delete("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, user, orgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, var_id), eq(workspaceVariables.workspaceId, workspace_id)) });
    if (!variable) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, var_id));
    set.status = 204;
  })
  // --- Lock/Unlock ---
  .post("/api/v2/workspaces/:workspace_id/actions/lock", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (ws.locked) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is already locked" }] }; }
    await db.update(workspaces).set({ locked: true, lockedReason: null }).where(eq(workspaces.id, workspace_id));
    await auditLog("lock", "workspaces", workspace_id, user?.id || null, ws.orgId);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return { data: await workspaceResource({ ...ws, locked: true }, org?.defaultIacBinary, Boolean(user)) };
  })
  .post("/api/v2/workspaces/:workspace_id/actions/unlock", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!ws.locked) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is not locked" }] }; }
    await db.update(workspaces).set({ locked: false, lockedReason: null }).where(eq(workspaces.id, workspace_id));
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return { data: await workspaceResource({ ...ws, locked: false }, org?.defaultIacBinary, Boolean(user)) };
  })
  .post("/api/v2/workspaces/:workspace_id/actions/force-unlock", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, principalOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.update(workspaces).set({ locked: false, lockedReason: null }).where(eq(workspaces.id, workspace_id));
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return { data: await workspaceResource({ ...ws, locked: false }, org?.defaultIacBinary, Boolean(user)) };
  })
  // --- Remote State Consumers ---
  .get("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const consumers = await db.query.remoteStateConsumers.findMany({ where: eq(remoteStateConsumers.workspaceId, workspace_id) });
    return { data: consumers.map(c => ({ id: c.consumerWorkspaceId, type: "workspaces" })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const items = (body as any)?.data;
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) { if (item?.id) await db.insert(remoteStateConsumers).values({ id: `rsc-${crypto.randomUUID()}`, workspaceId: workspace_id, consumerWorkspaceId: item.id }).onConflictDoNothing(); }
    set.status = 204;
  })
  .patch("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(remoteStateConsumers).where(eq(remoteStateConsumers.workspaceId, workspace_id));
    const items = (body as any)?.data;
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) { if (item?.id) await db.insert(remoteStateConsumers).values({ id: `rsc-${crypto.randomUUID()}`, workspaceId: workspace_id, consumerWorkspaceId: item.id }).onConflictDoNothing(); }
    set.status = 204;
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const items = (body as any)?.data;
    if (Array.isArray(items)) { const ids = items.map(i => i?.id).filter(Boolean); if (ids.length > 0) await db.delete(remoteStateConsumers).where(and(eq(remoteStateConsumers.workspaceId, workspace_id), inArray(remoteStateConsumers.consumerWorkspaceId, ids))); }
    set.status = 204;
  })
  // --- Data Retention ---
  .get("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const policy = await db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspace_id) });
    if (!policy) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: policy.id, type: "data-retention-policies", attributes: { "state-versions-count": policy.stateVersionsCount, "auto-destroy-at": policy.autoDestroyAt, "auto-destroy-activity-duration": policy.autoDestroyActivityDuration } } };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    const existing = await db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspace_id) });
    const pid = existing ? existing.id : `drp-${crypto.randomUUID()}`;
    const values = { id: pid, workspaceId: workspace_id, stateVersionsCount: attrs["state-versions-count"] ?? null, autoDestroyAt: attrs["auto-destroy-at"] ?? null, autoDestroyActivityDuration: attrs["auto-destroy-activity-duration"] ?? null, createdAt: Date.now() };
    if (existing) { await db.update(dataRetentionPolicies).set(values).where(eq(dataRetentionPolicies.id, pid)); } else { await db.insert(dataRetentionPolicies).values(values); }
    const gcSummary = await applyDataRetentionGarbageCollection(workspace_id);
    set.status = 201;
    return { data: { id: pid, type: "data-retention-policies", attributes: { "state-versions-count": values.stateVersionsCount, "auto-destroy-at": values.autoDestroyAt, "auto-destroy-activity-duration": values.autoDestroyActivityDuration }, meta: { gc: gcSummary } } };
  })
  .post("/api/v2/workspaces/:workspace_id/actions/gc", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const gcSummary = await applyDataRetentionGarbageCollection(workspace_id);
    return { data: { status: "ok", ...gcSummary } };
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(dataRetentionPolicies).where(eq(dataRetentionPolicies.workspaceId, workspace_id));
    set.status = 204;
  })
  // --- SSH Key assignment ---
  .patch("/api/v2/workspaces/:workspace_id/relationships/ssh-key", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const sshKeyData = (body as any)?.data;
    const sshKeyId = sshKeyData?.id ?? null;
    await db.update(workspaces).set({ sshKeyId }).where(eq(workspaces.id, workspace_id));
    return { data: { id: workspace_id, type: "workspaces", relationships: { "ssh-key": { data: sshKeyId ? { id: sshKeyId, type: "ssh-keys" } : null } } } };
  });

async function updateWorkspaceResponse(
  workspace: typeof workspaces.$inferSelect,
  defaultIacBinary: string | null | undefined,
  canRun: boolean,
  body: unknown,
  set: any,
) {
  const attributes = (body as any)?.data?.attributes || {};
  const rawTagBindings = (body as any)?.data?.relationships?.["tag-bindings"]?.data;
  const tagBindings = rawTagBindings === undefined ? undefined : parseTagBindings(rawTagBindings);
  const { name, description, "auto-apply": autoApply, "terraform-version": terraformVersion, "working-directory": workingDirectory, "source-name": sourceName, "source-url": sourceUrl, "iac-binary": iacBinary, "execution-mode": executionMode } = attributes;
  if (rawTagBindings !== undefined && tagBindings === undefined) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid tag bindings" }] }; }
  if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name))) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] }; }
  if (description !== undefined && description !== null && typeof description !== "string") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] }; }
  if ((sourceName !== undefined && sourceName !== null && typeof sourceName !== "string") || (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== "string")) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "source-name and source-url must be strings or null" }] }; }
  if (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] }; }
  if (executionMode !== undefined && executionMode !== "remote") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only remote execution mode is supported" }] }; }
  if (iacBinary !== undefined && iacBinary !== null && !["tofu", "terraform"].includes(iacBinary)) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] }; }
  let normalizedWorkingDirectory = workspace.workingDirectory;
  if (workingDirectory !== undefined) { try { normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory); } catch (error: any) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error.message }] }; } }
  if (name !== undefined && name !== workspace.name) { const duplicate = await findWorkspaceByName(workspace.orgId, name); if (duplicate && duplicate.id !== workspace.id) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] }; } }
  const projectRel = (body as any)?.data?.relationships?.project?.data;
  let newProjectId = workspace.projectId;
  if (projectRel !== undefined) newProjectId = projectRel ? projectRel.id : null;
  const updated: Partial<typeof workspaces.$inferInsert> = {
    name: name ?? workspace.name, description: description !== undefined ? description : workspace.description, projectId: newProjectId,
    autoApply: autoApply !== undefined ? Boolean(autoApply) : workspace.autoApply,
    autoApplyRunTrigger: attributes["auto-apply-run-trigger"] !== undefined ? Boolean(attributes["auto-apply-run-trigger"]) : workspace.autoApplyRunTrigger,
    fileTriggersEnabled: attributes["file-triggers-enabled"] !== undefined ? Boolean(attributes["file-triggers-enabled"]) : workspace.fileTriggersEnabled,
    triggerPrefixes: attributes["trigger-prefixes"] !== undefined ? attributes["trigger-prefixes"] : workspace.triggerPrefixes,
    triggerPatterns: attributes["trigger-patterns"] !== undefined ? attributes["trigger-patterns"] : workspace.triggerPatterns,
    vcsRepo: attributes["vcs-repo"] !== undefined ? attributes["vcs-repo"] : workspace.vcsRepo,
    queueAllRuns: attributes["queue-all-runs"] !== undefined ? Boolean(attributes["queue-all-runs"]) : workspace.queueAllRuns,
    speculativeEnabled: attributes["speculative-enabled"] !== undefined ? Boolean(attributes["speculative-enabled"]) : workspace.speculativeEnabled,
    allowDestroyPlan: attributes["allow-destroy-plan"] !== undefined ? Boolean(attributes["allow-destroy-plan"]) : workspace.allowDestroyPlan,
    globalRemoteState: attributes["global-remote-state"] !== undefined ? Boolean(attributes["global-remote-state"]) : workspace.globalRemoteState,
    projectRemoteState: attributes["project-remote-state"] !== undefined ? Boolean(attributes["project-remote-state"]) : workspace.projectRemoteState,
    agentPoolId: attributes["agent-pool-id"] !== undefined ? attributes["agent-pool-id"] : workspace.agentPoolId,
    assessmentsEnabled: attributes["assessments-enabled"] !== undefined ? Boolean(attributes["assessments-enabled"]) : workspace.assessmentsEnabled,
    autoDestroyAt: attributes["auto-destroy-at"] !== undefined ? attributes["auto-destroy-at"] : workspace.autoDestroyAt,
    autoDestroyActivityDuration: attributes["auto-destroy-activity-duration"] !== undefined ? attributes["auto-destroy-activity-duration"] : workspace.autoDestroyActivityDuration,
    settingOverwrites: attributes["setting-overwrites"] !== undefined ? attributes["setting-overwrites"] : workspace.settingOverwrites,
    terraformVersion: terraformVersion ?? workspace.terraformVersion, workingDirectory: normalizedWorkingDirectory,
    sourceName: sourceName !== undefined ? sourceName : workspace.sourceName, sourceUrl: sourceUrl !== undefined ? sourceUrl : workspace.sourceUrl,
    iacBinary: iacBinary !== undefined ? iacBinary : workspace.iacBinary,
  };
  await db.update(workspaces).set(updated).where(eq(workspaces.id, workspace.id));
  if (tagBindings) {
    await db.transaction(async tx => {
      await tx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspace.id));
      if (tagBindings.length > 0) await tx.insert(workspaceTags).values(tagBindings.map(b => ({ id: crypto.randomUUID(), workspaceId: workspace.id, ...b })));
    });
  }
  return { data: await workspaceResource({ ...workspace, ...updated }, defaultIacBinary, canRun) };
}
