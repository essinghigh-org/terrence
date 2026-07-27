import { Elysia } from "elysia";
import { db } from "../db";
import { configurationVersions, workspaces, type users } from "../db/schema";
import { eq, count } from "drizzle-orm";
import { checkOrgPermission, findAuthorizedWorkspace, pageRequest, pagination } from "../lib/utils";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { authPlugin } from "../auth";

const rawStorageDir = process.env.STORAGE_DIR;
const storageDir = typeof rawStorageDir === "string" && rawStorageDir !== "" ? rawStorageDir : join(import.meta.dir, "../storage");
const CV_STORAGE_DIR = join(storageDir, "cv");

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  request: Readonly<{ url: string; arrayBuffer: () => Promise<ArrayBuffer> }>;
  set: SetObj;
}>;

export const configurationVersionRoutes = new Elysia({ name: "configurationVersions" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(configurationVersions.workspaceId, workspaceId);
    const [cvs, countRows] = await Promise.all([
      db.query.configurationVersions.findMany({ where, limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(configurationVersions).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: cvs.map((cv: Readonly<{ readonly id: string; readonly speculative: boolean; readonly status: string; readonly source: string; readonly ingressAttributes: unknown }>): Record<string, unknown> => ({ id: cv.id, type: "configuration-versions", attributes: { "auto-queue-runs": false, speculative: cv.speculative, status: cv.status, source: cv.source, "ingress-attributes": cv.ingressAttributes } })), ...pagination(request, number, size, totalCount) };

  })
  .post("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};

    const id = crypto.randomUUID();
    const speculative = typeof attributes.speculative === "boolean" ? attributes.speculative : false;
    const source = typeof attributes.source === "string" ? attributes.source : "tfe-api";
    const autoQueueRuns = typeof attributes["auto-queue-runs"] === "boolean" ? attributes["auto-queue-runs"] : false;
    await db.insert(configurationVersions).values({ id, workspaceId, status: "pending", speculative, source });
    (set as { status: number }).status = 201;
    return { data: { id, type: "configuration-versions", attributes: { "auto-queue-runs": autoQueueRuns, speculative, status: "pending", source, "upload-url": `/api/v2/configuration-versions/${id}/upload`, "download-url": `/api/v2/configuration-versions/${id}/download` } } };
  })
  .get("/api/v2/configuration-versions/:cv_id", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const cvId = params["cv_id"] ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, cv.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: cv.id, type: "configuration-versions", attributes: { "auto-queue-runs": false, speculative: cv.speculative, status: cv.status, source: cv.source, "ingress-attributes": cv.ingressAttributes } } };
  })
  .put("/api/v2/configuration-versions/:cv_id/upload", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const cvId = params["cv_id"] ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tarName = `config-${cvId}.tar.gz`;
    const tarPath = join(CV_STORAGE_DIR, tarName);
    await mkdir(CV_STORAGE_DIR, { recursive: true });
    const buffer = await request.arrayBuffer();
    await writeFile(tarPath, Buffer.from(buffer));
    await db.update(configurationVersions).set({ status: "uploaded" }).where(eq(configurationVersions.id, cvId));
    (set as { status: number }).status = 200;
    return { data: { id: cvId, type: "configuration-versions", attributes: { status: "uploaded" } } };
  })
  .get("/api/v2/configuration-versions/:cv_id/download", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const cvId = params["cv_id"] ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, cv.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    (set.headers as Record<string, string>)["Content-Type"] = "text/plain";
    return "Configuration content not available";
  })
  // --- Config Version Ingress Attributes ---
  .get("/api/v2/configuration-versions/:cv_id/ingress-attributes", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const cvId = params["cv_id"] ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, cv.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ingress = (cv.ingressAttributes ?? {}) as Record<string, unknown>;
    return { data: { id: cv.id, type: "ingress-attributes", attributes: { "commit-sha": ingress["commitSha"] ?? null, "commit-url": ingress["commitUrl"] ?? null, "commit-message": ingress["commitMessage"] ?? null, branch: ingress["branch"] ?? null, tag: ingress["tag"] ?? null, "pull-request-number": ingress["pullRequestNumber"] ?? null, "sender-username": ingress["senderUsername"] ?? null, "clone-url": ingress["cloneUrl"] ?? null, "compare-url": ingress["compareUrl"] ?? null } } };
  });
