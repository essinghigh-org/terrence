import { Elysia } from "elysia";
import { db } from "../db";
import { projects, projectTags, organizations, type users } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { projectTagBindingResource } from "../lib/response";
import { checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  set: SetObj;
}>;

type ProjItem = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly defaultExecutionMode: string;
}>;

type TagEntry = Readonly<{
  readonly key: string;
  readonly value: string | null;
}>;

export const projectRoutes = new Elysia({ name: "projects" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/projects", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    let projList = await db.query.projects.findMany({ where: eq(projects.orgId, org.id) });
    if (projList.length === 0) {
      const defaultId = `prj-${crypto.randomUUID()}`;
      await db.insert(projects).values({ id: defaultId, orgId: org.id, name: "Default Project", description: "Default Project for Organization", createdAt: Date.now() });
      projList = await db.query.projects.findMany({ where: eq(projects.orgId, org.id) });
    }
    return { data: projList.map((p: ProjItem): Record<string, unknown> => ({ id: p.id, type: "projects", attributes: { name: p.name, description: p.description, "default-execution-mode": p.defaultExecutionMode } })) };
  })
  .post("/api/v2/organizations/:org_name/projects", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `prj-${crypto.randomUUID()}`;
    const description = typeof attributes.description === "string" ? attributes.description : null;
    const defaultExecutionMode = typeof attributes["default-execution-mode"] === "string" ? attributes["default-execution-mode"] : "remote";
    const newProj = { id, orgId: org.id, name, description, defaultExecutionMode, createdAt: Date.now() };
    await db.insert(projects).values(newProj);
    (set as { status: number }).status = 201;
    return { data: { id, type: "projects", attributes: { name: newProj.name, description: newProj.description, "default-execution-mode": newProj.defaultExecutionMode } } };
  })
  .get("/api/v2/projects/:project_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params["project_id"] ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: project.id, type: "projects", attributes: { name: project.name, description: project.description, "default-execution-mode": project.defaultExecutionMode } } };
  })
  .patch("/api/v2/projects/:project_id", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params["project_id"] ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof projects.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = typeof attributes.description === "string" ? attributes.description : null;
    if (typeof attributes["default-execution-mode"] === "string") updates.defaultExecutionMode = attributes["default-execution-mode"];
    if (Object.keys(updates).length > 0) await db.update(projects).set(updates).where(eq(projects.id, projectId));
    const updated = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "projects", attributes: { name: updated.name, description: updated.description, "default-execution-mode": updated.defaultExecutionMode } } };
  })
  .delete("/api/v2/projects/:project_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const projectId = params["project_id"] ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(projects).where(eq(projects.id, projectId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Project Tag Bindings ---
  .get("/api/v2/projects/:project_id/tag-bindings", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params["project_id"] ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.projectTags.findMany({ where: eq(projectTags.projectId, projectId) });
    return { data: tags.map((t: Readonly<typeof projectTags.$inferSelect>): Record<string, unknown> => projectTagBindingResource(t)) };
  })
  .get("/api/v2/projects/:project_id/effective-tag-bindings", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params["project_id"] ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.projectTags.findMany({ where: eq(projectTags.projectId, projectId) });
    return { data: tags.map((t: Readonly<typeof projectTags.$inferSelect>): Record<string, unknown> => projectTagBindingResource(t)) };
  })
  .post("/api/v2/projects/:project_id/tag-bindings", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params["project_id"] ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
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
  .delete("/api/v2/projects/:project_id/tag-bindings", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const projectId = params["project_id"] ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
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
