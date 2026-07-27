import { Elysia } from "elysia";
import { db } from "../db";
import { workspaces, workspaceTags, workspaceVariables, organizations, runs, remoteStateConsumers, dataRetentionPolicies, type users } from "../db/schema";
import { eq, and, asc, count, inArray, like, notInArray } from "drizzle-orm";
import { workspaceResource, workspaceVariableResource, tagBindingResource } from "../lib/response";
import { validVariableAttributes } from "../lib/validation";
import { validateVersion, checkOrgPermission, findAuthorizedWorkspace, findWorkspaceByName, pageRequest, pagination, parseTagBindings, auditLog, applyDataRetentionGarbageCollection, safeDeleteWorkspace, deleteWorkspaceData } from "../lib/utils";

import { normalizeWorkingDirectory } from "../workspace";
import { authPlugin } from "../auth";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: DeepReadonly<typeof users.$inferSelect> | null;
  readonly orgId?: string | null;
  readonly request: Readonly<{ readonly url: string }>;
  readonly set: SetObj;
}>;

type WsItem = DeepReadonly<typeof workspaces.$inferSelect>;
type TagItem = DeepReadonly<typeof workspaceTags.$inferSelect>;
type VarItem = DeepReadonly<typeof workspaceVariables.$inferSelect>;

function isUniqueConstraintError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (("message" in err && typeof err.message === "string" && err.message.includes("UNIQUE")) || ("code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE"));
}

export const workspaceRoutes = new Elysia({ name: "workspaces" })

  .use(authPlugin)
  // --- Organization Workspaces ---
  .get("/api/v2/organizations/:org_name/workspaces", async ({ params, user, orgId: principalOrgId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const searchParams = new URL(request.url).searchParams;
    const csv = (name: string): string[] => [...new Set(searchParams.get(name)?.split(",").filter(Boolean) ?? [])];
    const conditions: unknown[] = [eq(workspaces.orgId, org.id)];
    const search = searchParams.get("search[name]")?.trim() ?? searchParams.get("q")?.trim();
    if (search !== undefined && search !== "") conditions.push(like(workspaces.name, `%${search}%`));
    const tags = csv("search[tags]");
    if (tags.length > 0) {
      const taggedWsIds = (await db.query.workspaceTags.findMany({
        where: and(inArray(workspaceTags.key, tags)),
        columns: { workspaceId: true },
      })).map((t: Readonly<{ workspaceId: string }>): string => t.workspaceId);
      conditions.push(inArray(workspaces.id, [...new Set(taggedWsIds)]));
    }
    const excludeTags = searchParams.get("search[exclude-tags]")?.trim();
    if (excludeTags !== undefined && excludeTags !== "") {
      const excludedIds = (await db.query.workspaceTags.findMany({
        where: eq(workspaceTags.key, excludeTags),
        columns: { workspaceId: true },
      })).map((t: Readonly<{ workspaceId: string }>): string => t.workspaceId);
      conditions.push(notInArray(workspaces.id, [...new Set(excludedIds)]));
    }
    const projectIds = csv("filter[project][id]");
    if (projectIds.length > 0) conditions.push(inArray(workspaces.projectId, projectIds));
    const currentRunStatuses = csv("filter[current-run][status]");
    if (currentRunStatuses.length > 0) {
      const matchingWsIds = (await db.query.runs.findMany({
        where: and(inArray(runs.status, currentRunStatuses)),
        columns: { workspaceId: true },
      })).map((r: Readonly<{ workspaceId: string }>): string => r.workspaceId);
      conditions.push(inArray(workspaces.id, [...new Set(matchingWsIds)]));
    }
    const where = and(...(conditions as Parameters<typeof and>));
    const [wsList, countRows] = await Promise.all([
      db.query.workspaces.findMany({ where, orderBy: [asc(workspaces.name)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(workspaces).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    const data = await Promise.all(wsList.map(async (w: WsItem): Promise<Record<string, unknown>> => workspaceResource(w, org.defaultIacBinary, Boolean(user))));
    return { data, ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/organizations/:org_name/workspaces", async ({ params, body, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    const description = attributes.description;
    const autoApply = typeof attributes["auto-apply"] === "boolean" ? attributes["auto-apply"] : false;
    const terraformVersion = attributes["terraform-version"];
    const workingDirectory = attributes["working-directory"];
    const sourceName = typeof attributes["source-name"] === "string" ? attributes["source-name"] : null;
    const sourceUrl = typeof attributes["source-url"] === "string" ? attributes["source-url"] : null;
    const iacBinary = attributes["iac-binary"];
    const executionMode = attributes["execution-mode"];
    if (name === "" || !/^[A-Za-z0-9_-]+$/.test(name)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] };
    }
    if ((await findWorkspaceByName(org.id, name)) !== undefined) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] };
    }
    if (description !== undefined && description !== null && typeof description !== "string") {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] };
    }
    if (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] };
    }
    if (executionMode !== undefined && executionMode !== "remote") {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only remote execution mode is supported" }] };
    }
    if (iacBinary !== undefined && iacBinary !== null && typeof iacBinary === "string" && !["tofu", "terraform"].includes(iacBinary)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] };
    }
    let normalizedWorkingDirectory: string | null = null;
    if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory === "string") {
      try { normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory); } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Invalid working directory";
        (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: msg }] };
      }
    }
    const id = crypto.randomUUID();
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const projRel = typeof rels.project === "object" && rels.project !== null ? (rels.project as Record<string, unknown>) : {};
    const projData = typeof projRel.data === "object" && projRel.data !== null ? (projRel.data as Record<string, unknown>) : {};
    const projectId = typeof projData.id === "string" ? projData.id : null;
    const finalDesc = typeof description === "string" ? description : null;
    const finalTfVer = typeof terraformVersion === "string" ? terraformVersion : "latest";
    const finalIac = typeof iacBinary === "string" ? iacBinary : (org.defaultIacBinary ?? null);
    await db.insert(workspaces).values({
      id, name, orgId: org.id, description: finalDesc, projectId,
      autoApply, terraformVersion: finalTfVer,
      workingDirectory: normalizedWorkingDirectory, sourceName,
      sourceUrl, iacBinary: finalIac,
      createdAt: Date.now(),
    });
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    (set as { status: number }).status = 201;
    return { data: await workspaceResource(ws, org.defaultIacBinary, Boolean(user)) };
  })
  .get("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const workspaceName = params["workspace_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", principalOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await workspaceResource(ws, org.defaultIacBinary, Boolean(user)) };
  })
  .patch("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params, body, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const workspaceName = params["workspace_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", principalOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return updateWorkspaceResponse(ws, org.defaultIacBinary, Boolean(user), body, set);
  })
  .delete("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params["org_name"] ?? "";
    const workspaceName = params["workspace_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", principalOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await deleteWorkspaceData(ws.id);
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/organizations/:org_name/workspaces/:workspace_name/actions/safe-delete", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const workspaceName = params["workspace_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", principalOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ok = await safeDeleteWorkspace(ws.id);
    if (!ok) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace contains managed resources" }] }; }
    return { data: { status: "ok" } };
  })
  .get("/api/v2/workspaces/:workspace_id", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return { data: await workspaceResource(ws, org?.defaultIacBinary, Boolean(user)) };
  })
  .patch("/api/v2/workspaces/:workspace_id", async ({ params, body, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return updateWorkspaceResponse(ws, org?.defaultIacBinary, Boolean(user), body, set);
  })
  .delete("/api/v2/workspaces/:workspace_id", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await deleteWorkspaceData(ws.id);
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/workspaces/:workspace_id/actions/safe-delete", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ok = await safeDeleteWorkspace(ws.id);
    if (!ok) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace contains managed resources" }] }; }
    return { data: { status: "ok" } };
  })
  // --- Tags ---
  .get("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId), orderBy: [asc(workspaceTags.key)] });
    return { data: tags.map((t: TagItem): Record<string, unknown> => tagBindingResource(t)) };
  })
  .get("/api/v2/workspaces/:workspace_id/effective-tag-bindings", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId), orderBy: [asc(workspaceTags.key)] });
    return { data: tags.map((t: TagItem): Record<string, unknown> => tagBindingResource(t, true)) };
  })
  .patch("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data;
    const tags = Array.isArray(data) ? data : (data !== null && data !== undefined ? [data] : []);
    const entries = tags.map((t: unknown): { key: string; value: string } => {
      const item = t !== null && typeof t === "object" ? (t as Record<string, unknown>) : {};
      const attrs = typeof item.attributes === "object" && item.attributes !== null ? (item.attributes as Record<string, unknown>) : {};
      const key = typeof attrs.key === "string" ? attrs.key : "";
      const value = typeof attrs.value === "string" ? attrs.value : "";
      return { key, value };
    }).filter((e: Readonly<{ readonly key: string; readonly value: string }>): boolean => e.key !== "");
    await db.transaction(async (tx: unknown): Promise<void> => {
      const dbTx = tx as typeof db;
      await dbTx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspaceId));
      if (entries.length > 0) {
        await dbTx.insert(workspaceTags).values(entries.map((e: Readonly<{ readonly key: string; readonly value: string }>): { id: string; workspaceId: string; key: string; value: string } => ({ id: crypto.randomUUID(), workspaceId, key: e.key, value: e.value })));
      }
    });

    const updatedTags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId), orderBy: [asc(workspaceTags.key)] });
    return { data: updatedTags.map((t: TagItem): Record<string, unknown> => tagBindingResource(t)) };
  })
  .get("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId) });
    return { data: tags.map((t: TagItem): Record<string, string> => ({ id: t.key, type: "tags" })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params, body, user, orgId: principalOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item !== null && typeof item === "object") {
          const itemObj = item as Record<string, unknown>;
          const attrs = typeof itemObj.attributes === "object" && itemObj.attributes !== null ? (itemObj.attributes as Record<string, unknown>) : {};
          const keyVal = attrs.key ?? itemObj.id;
          const key = typeof keyVal === "string" ? keyVal : "";
          const value = typeof attrs.value === "string" ? attrs.value : "";
          if (key !== "") {
            await db.insert(workspaceTags).values({ id: crypto.randomUUID(), workspaceId, key, value }).onConflictDoNothing();
          }
        }
      }
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params, body, user, orgId: principalOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      const keys = items.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== "");
      if (keys.length > 0) await db.delete(workspaceTags).where(and(eq(workspaceTags.workspaceId, workspaceId), inArray(workspaceTags.key, keys)));
    }
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Workspace Variables ---
  .get("/api/v2/workspaces/:workspace_id/vars", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(workspaceVariables.workspaceId, workspaceId);
    const [vars, countRows] = await Promise.all([
      db.query.workspaceVariables.findMany({ where, orderBy: [asc(workspaceVariables.key)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(workspaceVariables).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: vars.map((v: VarItem): Record<string, unknown> => workspaceVariableResource(v)), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/workspaces/:workspace_id/vars", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    if (data?.type !== "vars" || !validVariableAttributes(attributes)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    const varId = `wsvar-${crypto.randomUUID()}`;
    const key = typeof attributes.key === "string" ? attributes.key : "";
    const value = typeof attributes.value === "string" ? attributes.value : "";
    const category = typeof attributes.category === "string" ? attributes.category : "terraform";
    const sensitive = typeof attributes.sensitive === "boolean" ? attributes.sensitive : false;
    const hcl = typeof attributes.hcl === "boolean" ? attributes.hcl : false;
    const description = typeof attributes.description === "string" ? attributes.description : null;
    await db.insert(workspaceVariables).values({ id: varId, workspaceId, key, value, category, sensitive, hcl, description });
    (set as { status: number }).status = 201;
    return { data: workspaceVariableResource({ id: varId, workspaceId, key, value, category, sensitive, hcl, description }) };
  })
  .get("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const varId = params["var_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)) });
    if (variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: workspaceVariableResource(variable) };
  })
  .patch("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const varId = params["var_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)) });
    if (variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    if (data?.type !== "vars" || !validVariableAttributes(attrs, true)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }
    let sensitive = typeof attrs.sensitive === "boolean" ? attrs.sensitive : (variable.sensitive ?? false);
    if ((variable.sensitive ?? false) && !sensitive && attrs.value === undefined) sensitive = true;
    const key = typeof attrs.key === "string" ? attrs.key : variable.key;
    const value = typeof attrs.value === "string" ? attrs.value : variable.value;
    const category = typeof attrs.category === "string" ? attrs.category : variable.category;
    const hcl = typeof attrs.hcl === "boolean" ? attrs.hcl : (variable.hcl ?? false);
    const description = typeof attrs.description === "string" ? attrs.description : variable.description;
    const updated = { key, value, category, sensitive, hcl, description };
    try {
      await db.update(workspaceVariables).set(updated).where(eq(workspaceVariables.id, varId));
    } catch (error: unknown) {
      const isUnique: boolean = isUniqueConstraintError(error);
      if (isUnique) {
        (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this workspace" }] };
      }
      throw error;
    }
    return { data: workspaceVariableResource({ ...variable, ...updated }) };
  })
  .delete("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params, user, orgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const varId = params["var_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const variable = await db.query.workspaceVariables.findFirst({ where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)) });
    if (variable === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, varId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Lock/Unlock ---
  .post("/api/v2/workspaces/:workspace_id/actions/lock", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {

    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (ws.locked === true) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is already locked" }] }; }

    await db.update(workspaces).set({ locked: true, lockedReason: null }).where(eq(workspaces.id, workspaceId));
    await auditLog("lock", "workspaces", workspaceId, user?.id ?? null, ws.orgId);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return { data: await workspaceResource({ ...ws, locked: true }, org?.defaultIacBinary, Boolean(user)) };
  })

  .post("/api/v2/workspaces/:workspace_id/actions/unlock", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (ws.locked !== true) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is not locked" }] }; }
    await db.update(workspaces).set({ locked: false, lockedReason: null }).where(eq(workspaces.id, workspaceId));
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return { data: await workspaceResource({ ...ws, locked: false }, org?.defaultIacBinary, Boolean(user)) };
  })
  .post("/api/v2/workspaces/:workspace_id/actions/force-unlock", async ({ params, user, orgId: principalOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, principalOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.update(workspaces).set({ locked: false, lockedReason: null }).where(eq(workspaces.id, workspaceId));
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ws.orgId) });
    return { data: await workspaceResource({ ...ws, locked: false }, org?.defaultIacBinary, Boolean(user)) };
  })
  // --- Remote State Consumers ---
  .get("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const consumers = await db.query.remoteStateConsumers.findMany({ where: eq(remoteStateConsumers.workspaceId, workspaceId) });
    return { data: consumers.map((c: Readonly<{ consumerWorkspaceId: string }>): Record<string, string> => ({ id: c.consumerWorkspaceId, type: "workspaces" })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    const list = Array.isArray(items) ? items : (items !== null && items !== undefined ? [items] : []);
    for (const item of list) {
      if (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
        const consumerWorkspaceId = (item as Record<string, unknown>).id as string;
        await db.insert(remoteStateConsumers).values({ id: `rsc-${crypto.randomUUID()}`, workspaceId, consumerWorkspaceId }).onConflictDoNothing();
      }
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .patch("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(remoteStateConsumers).where(eq(remoteStateConsumers.workspaceId, workspaceId));
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    const list = Array.isArray(items) ? items : (items !== null && items !== undefined ? [items] : []);
    for (const item of list) {
      if (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
        const consumerWorkspaceId = (item as Record<string, unknown>).id as string;
        await db.insert(remoteStateConsumers).values({ id: `rsc-${crypto.randomUUID()}`, workspaceId, consumerWorkspaceId }).onConflictDoNothing();
      }
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      const ids = items.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== "");
      if (ids.length > 0) await db.delete(remoteStateConsumers).where(and(eq(remoteStateConsumers.workspaceId, workspaceId), inArray(remoteStateConsumers.consumerWorkspaceId, ids)));
    }
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Data Retention ---
  .get("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const policy = await db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspaceId) });
    if (policy === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: policy.id, type: "data-retention-policies", attributes: { "state-versions-count": policy.stateVersionsCount, "auto-destroy-at": policy.autoDestroyAt, "auto-destroy-activity-duration": policy.autoDestroyActivityDuration } } };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const existing = await db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspaceId) });
    const pid = existing?.id ?? `drp-${crypto.randomUUID()}`;
    const stateVersionsCount = typeof attrs["state-versions-count"] === "number" ? attrs["state-versions-count"] : null;
    const autoDestroyAt = typeof attrs["auto-destroy-at"] === "string" ? attrs["auto-destroy-at"] : null;
    const autoDestroyActivityDuration = typeof attrs["auto-destroy-activity-duration"] === "string" ? attrs["auto-destroy-activity-duration"] : null;
    const values = { id: pid, workspaceId, stateVersionsCount, autoDestroyAt, autoDestroyActivityDuration, createdAt: Date.now() };
    if (existing !== undefined) { await db.update(dataRetentionPolicies).set(values).where(eq(dataRetentionPolicies.id, pid)); } else { await db.insert(dataRetentionPolicies).values(values); }
    const gcSummary = await applyDataRetentionGarbageCollection(workspaceId);
    (set as { status: number }).status = 201;
    return { data: { id: pid, type: "data-retention-policies", attributes: { "state-versions-count": values.stateVersionsCount, "auto-destroy-at": values.autoDestroyAt, "auto-destroy-activity-duration": values.autoDestroyActivityDuration }, meta: { gc: gcSummary } } };
  })
  .post("/api/v2/workspaces/:workspace_id/actions/gc", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const gcSummary = await applyDataRetentionGarbageCollection(workspaceId);
    return { data: { status: "ok", ...gcSummary } };
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(dataRetentionPolicies).where(eq(dataRetentionPolicies.workspaceId, workspaceId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- SSH Key assignment ---
  .patch("/api/v2/workspaces/:workspace_id/relationships/ssh-key", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const sshKeyData = payload.data as Record<string, unknown> | undefined;
    const sshKeyId = typeof sshKeyData?.id === "string" ? sshKeyData.id : null;
    await db.update(workspaces).set({ sshKeyId }).where(eq(workspaces.id, workspaceId));
    return { data: { id: workspaceId, type: "workspaces", relationships: { "ssh-key": { data: sshKeyId !== null ? { id: sshKeyId, type: "ssh-keys" } : null } } } };
  });

async function updateWorkspaceResponse(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  defaultIacBinary: string | null | undefined,
  canRun: boolean,
  body: unknown,
  set: SetObj,
): Promise<unknown> {
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload.data as Record<string, unknown> | undefined;
  const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
  const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
  const rawTagBindings = rels["tag-bindings"] as Record<string, unknown> | undefined;
  const tagBindingsData = rawTagBindings !== undefined ? rawTagBindings.data : undefined;
  const tagBindings = tagBindingsData === undefined ? undefined : parseTagBindings(tagBindingsData);
  const name = typeof attributes.name === "string" ? attributes.name : undefined;
  const description = attributes.description;
  const autoApply = typeof attributes["auto-apply"] === "boolean" ? attributes["auto-apply"] : undefined;
  const terraformVersion = typeof attributes["terraform-version"] === "string" ? attributes["terraform-version"] : undefined;
  const workingDirectory = attributes["working-directory"];
  const sourceName = attributes["source-name"];
  const sourceUrl = attributes["source-url"];
  const iacBinary = attributes["iac-binary"];
  const executionMode = attributes["execution-mode"];

  if (tagBindingsData !== undefined && tagBindings === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid tag bindings" }] }; }
  if (name !== undefined && !/^[A-Za-z0-9_-]+$/.test(name)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] }; }
  if (description !== undefined && description !== null && typeof description !== "string") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] }; }
  if ((sourceName !== undefined && sourceName !== null && typeof sourceName !== "string") || (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== "string")) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "source-name and source-url must be strings or null" }] }; }
  if (terraformVersion !== undefined && !validateVersion(terraformVersion)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] }; }
  if (executionMode !== undefined && executionMode !== "remote") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only remote execution mode is supported" }] }; }
  if (iacBinary !== undefined && iacBinary !== null && typeof iacBinary === "string" && !["tofu", "terraform"].includes(iacBinary)) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] }; }

  let normalizedWorkingDirectory = workspace.workingDirectory;
  if (workingDirectory !== undefined && typeof workingDirectory === "string") {
    try { normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory); } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Invalid working directory";
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: msg }] };
    }
  }

  if (name !== undefined && name !== workspace.name) {
    const duplicate = await findWorkspaceByName(workspace.orgId, name);
    if (duplicate !== undefined && duplicate.id !== workspace.id) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] }; }
  }

  const projectRel = rels.project as Record<string, unknown> | undefined;
  let newProjectId = workspace.projectId;
  if (projectRel !== undefined) {
    const projData = typeof projectRel.data === "object" && projectRel.data !== null ? (projectRel.data as Record<string, unknown>) : null;
    newProjectId = typeof projData?.id === "string" ? projData.id : null;
  }

  const updated: Partial<typeof workspaces.$inferInsert> = {
    name: name ?? workspace.name,
    description: typeof description === "string" ? description : (description === null ? null : workspace.description),
    projectId: newProjectId,
    autoApply: autoApply ?? workspace.autoApply,
    autoApplyRunTrigger: typeof attributes["auto-apply-run-trigger"] === "boolean" ? attributes["auto-apply-run-trigger"] : workspace.autoApplyRunTrigger,
    fileTriggersEnabled: typeof attributes["file-triggers-enabled"] === "boolean" ? attributes["file-triggers-enabled"] : workspace.fileTriggersEnabled,
    triggerPrefixes: Array.isArray(attributes["trigger-prefixes"]) ? (attributes["trigger-prefixes"] as string[]) : workspace.triggerPrefixes,
    triggerPatterns: Array.isArray(attributes["trigger-patterns"]) ? (attributes["trigger-patterns"] as string[]) : workspace.triggerPatterns,
    vcsRepo: typeof attributes["vcs-repo"] === "string" ? attributes["vcs-repo"] : workspace.vcsRepo,
    queueAllRuns: typeof attributes["queue-all-runs"] === "boolean" ? attributes["queue-all-runs"] : workspace.queueAllRuns,
    speculativeEnabled: typeof attributes["speculative-enabled"] === "boolean" ? attributes["speculative-enabled"] : workspace.speculativeEnabled,
    allowDestroyPlan: typeof attributes["allow-destroy-plan"] === "boolean" ? attributes["allow-destroy-plan"] : workspace.allowDestroyPlan,
    globalRemoteState: typeof attributes["global-remote-state"] === "boolean" ? attributes["global-remote-state"] : workspace.globalRemoteState,
    projectRemoteState: typeof attributes["project-remote-state"] === "boolean" ? attributes["project-remote-state"] : workspace.projectRemoteState,
    agentPoolId: typeof attributes["agent-pool-id"] === "string" ? attributes["agent-pool-id"] : workspace.agentPoolId,
    assessmentsEnabled: typeof attributes["assessments-enabled"] === "boolean" ? attributes["assessments-enabled"] : workspace.assessmentsEnabled,
    autoDestroyAt: typeof attributes["auto-destroy-at"] === "string" ? attributes["auto-destroy-at"] : workspace.autoDestroyAt,
    autoDestroyActivityDuration: typeof attributes["auto-destroy-activity-duration"] === "string" ? attributes["auto-destroy-activity-duration"] : workspace.autoDestroyActivityDuration,
    settingOverwrites: typeof attributes["setting-overwrites"] === "object" && attributes["setting-overwrites"] !== null ? (attributes["setting-overwrites"] as Record<string, unknown>) : workspace.settingOverwrites,
    terraformVersion: terraformVersion ?? workspace.terraformVersion,
    workingDirectory: normalizedWorkingDirectory,
    sourceName: typeof sourceName === "string" ? sourceName : (sourceName === null ? null : workspace.sourceName),
    sourceUrl: typeof sourceUrl === "string" ? sourceUrl : (sourceUrl === null ? null : workspace.sourceUrl),
    iacBinary: typeof iacBinary === "string" ? iacBinary : (iacBinary === null ? null : workspace.iacBinary),
  };

  await db.update(workspaces).set(updated).where(eq(workspaces.id, workspace.id));
  if (tagBindings !== undefined) {
    await db.transaction(async (tx: unknown): Promise<void> => {
      const dbTx = tx as typeof db;
      await dbTx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspace.id));
      if (tagBindings.length > 0) {
        await dbTx.insert(workspaceTags).values(tagBindings.map((b: Readonly<{ key: string; value: string }>): { id: string; workspaceId: string; key: string; value: string } => ({ id: crypto.randomUUID(), workspaceId: workspace.id, ...b })));
      }
    });
  }
  return { data: await workspaceResource({ ...workspace, ...updated }, defaultIacBinary, canRun) };
}
