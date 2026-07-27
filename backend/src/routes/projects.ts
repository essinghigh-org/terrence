import { Elysia } from "elysia";
import { db } from "../db";
import { projects, projectTags, organizations } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { projectTagBindingResource } from "../lib/response";
import { checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

export const projectRoutes = new Elysia({ name: "projects" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/projects", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    let projList = await db.query.projects.findMany({ where: eq(projects.orgId, org.id) });
    if (projList.length === 0) {
      const defaultId = `prj-${crypto.randomUUID()}`;
      await db.insert(projects).values({ id: defaultId, orgId: org.id, name: "Default Project", description: "Default Project for Organization", createdAt: Date.now() });
      projList = await db.query.projects.findMany({ where: eq(projects.orgId, org.id) });
    }
    return { data: projList.map(p => ({ id: p.id, type: "projects", attributes: { name: p.name, description: p.description, "default-execution-mode": p.defaultExecutionMode } })) };
  })
  .post("/api/v2/organizations/:org_name/projects", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `prj-${crypto.randomUUID()}`;
    const newProj = { id, orgId: org.id, name: attributes.name, description: attributes.description ?? null, defaultExecutionMode: attributes["default-execution-mode"] ?? "remote", createdAt: Date.now() };
    await db.insert(projects).values(newProj);
    set.status = 201;
    return { data: { id, type: "projects", attributes: { name: newProj.name, description: newProj.description, "default-execution-mode": newProj.defaultExecutionMode } } };
  })
  .get("/api/v2/projects/:project_id", async ({ params: { project_id }, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: project.id, type: "projects", attributes: { name: project.name, description: project.description, "default-execution-mode": project.defaultExecutionMode } } };
  })
  .patch("/api/v2/projects/:project_id", async ({ params: { project_id }, body, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof projects.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = attributes.description;
    if (typeof attributes["default-execution-mode"] === "string") updates.defaultExecutionMode = attributes["default-execution-mode"];
    if (Object.keys(updates).length > 0) await db.update(projects).set(updates).where(eq(projects.id, project_id));
    const updated = (await db.query.projects.findFirst({ where: eq(projects.id, project_id) }))!;
    return { data: { id: updated.id, type: "projects", attributes: { name: updated.name, description: updated.description, "default-execution-mode": updated.defaultExecutionMode } } };
  })
  .delete("/api/v2/projects/:project_id", async ({ params: { project_id }, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(projects).where(eq(projects.id, project_id));
    set.status = 204;
  })
  // --- Project Tag Bindings ---
  .get("/api/v2/projects/:project_id/tag-bindings", async ({ params: { project_id }, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.projectTags.findMany({ where: eq(projectTags.projectId, project_id) });
    return { data: tags.map(t => projectTagBindingResource(t)) };
  })
  .get("/api/v2/projects/:project_id/effective-tag-bindings", async ({ params: { project_id }, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tags = await db.query.projectTags.findMany({ where: eq(projectTags.projectId, project_id) });
    return { data: tags.map(t => projectTagBindingResource(t)) };
  })
  .post("/api/v2/projects/:project_id/tag-bindings", async ({ params: { project_id }, body, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const items = (body as any)?.data;
    const tagList = Array.isArray(items) ? items : [items];
    const entries = tagList.map((item: any) => ({ key: item?.attributes?.key, value: item?.attributes?.value ?? null })).filter((e: any) => e.key && typeof e.key === "string");
    const keys = entries.map((e: any) => e.key);
    const existingTags = await db.query.projectTags.findMany({ where: and(eq(projectTags.projectId, project_id), inArray(projectTags.key, keys)) });
    const existingKeys = new Set(existingTags.map(t => t.key));
    for (const et of existingTags) { const entry = entries.find((e: any) => e.key === et.key); if (entry && entry.value !== et.value) await db.update(projectTags).set({ value: entry.value }).where(eq(projectTags.id, et.id)); }
    const newEntries = entries.filter((e: any) => !existingKeys.has(e.key));
    if (newEntries.length > 0) await db.insert(projectTags).values(newEntries.map((e: any) => ({ id: `ptag-${crypto.randomUUID()}`, projectId: project_id, key: e.key, value: e.value })));
    const allTags = await db.query.projectTags.findMany({ where: and(eq(projectTags.projectId, project_id), inArray(projectTags.key, keys)) });
    const created = allTags.map(pt => projectTagBindingResource(pt));
    set.status = 201;
    return { data: created.length === 1 ? created[0] : created };
  })
  .delete("/api/v2/projects/:project_id/tag-bindings", async ({ params: { project_id }, body, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const items = (body as any)?.data;
    const tagList = Array.isArray(items) ? items : [items];
    const keys = tagList.map((i: any) => i?.attributes?.key || i?.key).filter(Boolean);
    if (keys.length > 0) await db.delete(projectTags).where(and(eq(projectTags.projectId, project_id), inArray(projectTags.key, keys)));
    set.status = 204;
  });
