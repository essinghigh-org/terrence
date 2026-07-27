import { Elysia } from "elysia";
import { db } from "../db";
import { configurationVersions, workspaces, organizations } from "../db/schema";
import { eq, and, desc, asc, count, inArray } from "drizzle-orm";
import { checkOrgPermission, findAuthorizedWorkspace, pageRequest, pagination } from "../lib/utils";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { authPlugin } from "../auth";

const CV_STORAGE_DIR = join(process.env.STORAGE_DIR || join(import.meta.dir, "../storage"), "cv");

export const configurationVersionRoutes = new Elysia({ name: "configurationVersions" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(configurationVersions.workspaceId, workspace_id);
    const [cvs, [{ total }]] = await Promise.all([
      db.query.configurationVersions.findMany({ where, limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(configurationVersions).where(where),
    ]);
    return { data: cvs.map(cv => ({ id: cv.id, type: "configuration-versions", attributes: { "auto-queue-runs": false, speculative: cv.speculative ?? false, status: cv.status ?? "uploaded", source: cv.source ?? "tfe-api", "ingress-attributes": cv.ingressAttributes ?? null } })), ...pagination(request, number, size, total) };
  })
  .post("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params: { workspace_id }, body, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body as any;
    const attributes = payload?.data?.attributes || {};
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.insert(configurationVersions).values({ id, workspaceId: workspace_id, status: "pending", speculative: attributes.speculative ?? false, source: attributes.source ?? "tfe-api" });
    set.status = 201;
    return { data: { id, type: "configuration-versions", attributes: { "auto-queue-runs": attributes["auto-queue-runs"] ?? false, speculative: attributes.speculative ?? false, status: "pending", source: attributes.source ?? "tfe-api", "upload-url": `/api/v2/configuration-versions/${id}/upload`, "download-url": `/api/v2/configuration-versions/${id}/download` } } };
  })
  .get("/api/v2/configuration-versions/:cv_id", async ({ params: { cv_id }, user, orgId, request, set }) => {
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cv_id) });
    if (!cv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, cv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: cv.id, type: "configuration-versions", attributes: { "auto-queue-runs": false, speculative: cv.speculative ?? false, status: cv.status ?? "uploaded", source: cv.source ?? "tfe-api", "ingress-attributes": cv.ingressAttributes ?? null } } };
  })
  .put("/api/v2/configuration-versions/:cv_id/upload", async ({ params: { cv_id }, body, request, set }) => {
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cv_id) });
    if (!cv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tarName = `config-${cv_id}.tar.gz`;
    const tarPath = join(CV_STORAGE_DIR, tarName);
    await mkdir(CV_STORAGE_DIR, { recursive: true });
    const buffer = await request.arrayBuffer();
    await writeFile(tarPath, Buffer.from(buffer));
    await db.update(configurationVersions).set({ status: "uploaded" }).where(eq(configurationVersions.id, cv_id));
    set.status = 200;
    return { data: { id: cv_id, type: "configuration-versions", attributes: { status: "uploaded" } } };
  })
  .get("/api/v2/configuration-versions/:cv_id/download", async ({ params: { cv_id }, user, orgId, set }) => {
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cv_id) });
    if (!cv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, cv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    set.headers["Content-Type"] = "text/plain";
    return "Configuration content not available";
  })
  // --- Config Version Ingress Attributes ---
  .get("/api/v2/configuration-versions/:cv_id/ingress-attributes", async ({ params: { cv_id }, user, orgId: tokenOrgId, set }) => {
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cv_id) });
    if (!cv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, cv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ingress = cv.ingressAttributes || {};
    return { data: { id: cv.id, type: "ingress-attributes", attributes: { "commit-sha": ingress.commitSha ?? null, "commit-url": ingress.commitUrl ?? null, "commit-message": ingress.commitMessage ?? null, branch: ingress.branch ?? null, tag: ingress.tag ?? null, "pull-request-number": ingress.pullRequestNumber ?? null, "sender-username": ingress.senderUsername ?? null, "clone-url": ingress.cloneUrl ?? null, "compare-url": ingress.compareUrl ?? null } } };
  });
