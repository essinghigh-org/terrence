import { Elysia } from "elysia";
import { db } from "../db";
import { configurationVersions, runs, type users } from "../db/schema";
import { eq, count, desc, and, inArray, notInArray } from "drizzle-orm";
import { apiURL, signedApiURL, validSignedApiURL, FINAL_RUN_STATUSES, findAuthorizedWorkspace, pageRequest, pagination , type DeepReadonly } from "../lib/utils";
import { join } from "path";
import { mkdir, rm, writeFile } from "fs/promises";
import { authPlugin } from "../auth";

const rawStorageDir = process.env.STORAGE_DIR;
const storageDir = typeof rawStorageDir === "string" && rawStorageDir !== "" ? rawStorageDir : join(import.meta.dir, "../storage");
const CV_STORAGE_DIR = join(storageDir, "cv");

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Request;
  set: SetObj;
}>;

type ConfigurationVersion = typeof configurationVersions.$inferSelect;

function hasIngressData(cv: DeepReadonly<ConfigurationVersion>): boolean {
  const ingress = (cv.ingressAttributes ?? {}) as Record<string, unknown>;
  return Object.values(ingress).some(
    (value): boolean =>
      (typeof value === "string" && value !== "")
      || typeof value === "number"
      || typeof value === "boolean",
  );
}

function configurationVersionResource(cv: DeepReadonly<ConfigurationVersion>, request: Readonly<{ url: string }>): Record<string, unknown> {
  // The upload URL is signed (PUT) because the Terraform CLI uploads config
  // archives WITHOUT an Authorization header, exactly like state versions.
  const uploadUrl = signedApiURL(request, `/api/v2/configuration-versions/${cv.id}/upload`, "PUT");
  const downloadUrl = apiURL(request, `/api/v2/configuration-versions/${cv.id}/download`);
  return {
    id: cv.id,
    type: "configuration-versions",
    attributes: {
      "auto-queue-runs": cv.autoQueueRuns,
      speculative: cv.speculative,
      provisional: cv.provisional,
      status: cv.status,
      source: cv.source,
      "ingress-attributes": cv.ingressAttributes,
      "status-timestamps": {
        "uploaded-at": cv.statusTimestamps?.uploadedAt ?? null,
        "archived-at": cv.statusTimestamps?.archivedAt ?? null,
      },
      error: cv.error,
      "error-message": cv.errorMessage,
      "upload-url": uploadUrl,
      "download-url": downloadUrl,
    },
    relationships: {
      "ingress-attributes": {
        data: hasIngressData(cv)
          ? { id: cv.id, type: "ingress-attributes" }
          : null,
        links: { related: `/api/v2/configuration-versions/${cv.id}/ingress-attributes` },
      },
    },
    links: {
      self: `/api/v2/configuration-versions/${cv.id}`,
      download: `/api/v2/configuration-versions/${cv.id}/download`,
    },
  };
}

export const configurationVersionRoutes = new Elysia({ name: "configurationVersions" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(configurationVersions.workspaceId, workspaceId);
    const [cvs, countRows] = await Promise.all([
      db.query.configurationVersions.findMany({ where, orderBy: [desc(configurationVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(configurationVersions).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: cvs.map((cv: DeepReadonly<ConfigurationVersion>): Record<string, unknown> => configurationVersionResource(cv, request)), ...pagination(request, number, size, totalCount) };

  })
  .post("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "plan");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};

    const id = crypto.randomUUID();
    const speculative = typeof attributes.speculative === "boolean" ? attributes.speculative : false;
    const provisional = typeof attributes.provisional === "boolean" ? attributes.provisional : false;
    // The Terraform/OpenTofu CLI does not send a source attribute; detect it
    // from the User-Agent so CLI-driven runs show "Triggered via CLI" like TFE.
    let source = typeof attributes.source === "string" ? attributes.source : "";
    if (source === "") {
      const agent = request.headers.get("user-agent") ?? "";
      source = /^(?:terraform|tofu|terragrunt)\//i.test(agent.trim()) ? "tfe-cli" : "tfe-api";
    }
    const rawAutoQueueRuns = attributes["auto-queue-runs"];
    if (rawAutoQueueRuns !== undefined && typeof rawAutoQueueRuns !== "boolean") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "auto-queue-runs must be boolean" }] };
    }
    const autoQueueRuns = rawAutoQueueRuns ?? true;
    const createdAt = Date.now();
    const cv: ConfigurationVersion = {
      id,
      workspaceId,
      status: "pending",
      autoQueueRuns,
      archivePath: null,
      speculative,
      provisional,
      source,
      ingressAttributes: null,
      statusTimestamps: null,
      error: null,
      errorMessage: null,
      softDeletedAt: null,
      createdAt,
    };
    await db.insert(configurationVersions).values(cv);
    (set as { status: number }).status = 201;
    return { data: configurationVersionResource(cv, request) };
  })
  .get("/api/v2/configuration-versions/:cv_id", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const cvId = params.cv_id ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId, teamId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: configurationVersionResource(cv, request) };
  })
  .put("/api/v2/configuration-versions/:cv_id/upload", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const cvId = params.cv_id ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    const path = `/api/v2/configuration-versions/${cvId}/upload`;
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId, teamId, "plan");
    // The Terraform CLI uploads WITHOUT an Authorization header, using the
    // signed upload URL from the configuration-version response instead.
    if (ws === undefined && !validSignedApiURL(request, path, "PUT")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (cv.status !== "pending" || cv.archivePath !== null) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Configuration content was already uploaded" }] };
    }
    const tarName = `config-${cvId}.tar.gz`;
    const tarPath = join(CV_STORAGE_DIR, tarName);
    await mkdir(CV_STORAGE_DIR, { recursive: true });
    let buffer: Uint8Array;
    try {
      buffer = body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : ArrayBuffer.isView(body)
          ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          : body instanceof Blob
            ? new Uint8Array(await body.arrayBuffer())
            : new Uint8Array(await request.arrayBuffer());
    } catch {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Could not read configuration archive body" }] };
    }
    if (buffer.byteLength === 0) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Configuration archive is empty" }] };
    }
    if (buffer.byteLength > 100 * 1024 * 1024) {
      (set as { status: number }).status = 413; return { errors: [{ status: "413", title: "Payload Too Large", detail: "Configuration archive exceeds 100 MiB maximum" }] };
    }
    await writeFile(tarPath, buffer, { mode: 0o600 });
    const uploadedAt = new Date().toISOString();
    await db.update(configurationVersions).set({
      archivePath: tarPath,
      status: "uploaded",
      statusTimestamps: { ...(cv.statusTimestamps ?? {}), uploadedAt },
    }).where(eq(configurationVersions.id, cvId));
    (set as { status: number }).status = 200;
    return { data: { id: cvId, type: "configuration-versions", attributes: { status: "uploaded" } } };
  })
  .get("/api/v2/configuration-versions/:cv_id/download", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const cvId = params.cv_id ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId, teamId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (
      cv.archivePath === null
      || ["backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(cv.status)
      || !(await Bun.file(cv.archivePath).exists())
    ) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    (set.headers as Record<string, string>)["Content-Type"] = "application/gzip";
    return Bun.file(cv.archivePath);
  })
  .post("/api/v2/configuration-versions/:cv_id/actions/soft_delete_backing_data", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const cvId = params.cv_id ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId, teamId, "admin");
    if (ws === undefined) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const current = await db.query.configurationVersions.findFirst({
      where: and(
        eq(configurationVersions.workspaceId, cv.workspaceId),
        inArray(configurationVersions.status, ["uploaded", "archived"]),
      ),
      orderBy: [desc(configurationVersions.createdAt)],
      columns: { id: true },
    });
    const activeRun = await db.query.runs.findFirst({
      where: and(
        eq(runs.configurationVersionId, cv.id),
        notInArray(runs.status, FINAL_RUN_STATUSES),
      ),
      columns: { id: true },
    });
    if (!["uploaded", "archived"].includes(cv.status) || current?.id === cv.id || activeRun !== undefined) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    await db.update(configurationVersions).set({
      status: "backing_data_soft_deleted",
      softDeletedAt: Date.now(),
    }).where(eq(configurationVersions.id, cv.id));
    return {};
  })
  .post("/api/v2/configuration-versions/:cv_id/actions/restore_backing_data", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const cvId = params.cv_id ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId, teamId, "admin");
    if (ws === undefined) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (cv.status !== "backing_data_soft_deleted" || cv.archivePath === null || !(await Bun.file(cv.archivePath).exists())) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    await db.update(configurationVersions).set({ status: "uploaded", softDeletedAt: null }).where(eq(configurationVersions.id, cv.id));
    return {};
  })
  .post("/api/v2/configuration-versions/:cv_id/actions/permanently_delete_backing_data", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const cvId = params.cv_id ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId, teamId, "admin");
    if (ws === undefined) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (cv.status !== "backing_data_soft_deleted") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    if (cv.archivePath !== null) await rm(cv.archivePath, { force: true });
    await db.update(configurationVersions).set({
      archivePath: null,
      status: "backing_data_permanently_deleted",
    }).where(eq(configurationVersions.id, cv.id));
    return {};
  })
  // --- Config Version Ingress Attributes ---
  .get("/api/v2/configuration-versions/:cv_id/ingress-attributes", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const cvId = params.cv_id ?? "";
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    if (cv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await findAuthorizedWorkspace(cv.workspaceId, user?.id, tokenOrgId, teamId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!hasIngressData(cv)) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ingress = (cv.ingressAttributes ?? {}) as Record<string, unknown>;
    return { data: { id: cv.id, type: "ingress-attributes", attributes: { "commit-sha": ingress.commitSha ?? null, "commit-url": ingress.commitUrl ?? null, "commit-message": ingress.commitMessage ?? null, branch: ingress.branch ?? null, tag: ingress.tag ?? null, "pull-request-number": ingress.pullRequestNumber ?? null, "sender-username": ingress.senderUsername ?? null, "clone-url": ingress.cloneUrl ?? null, "compare-url": ingress.compareUrl ?? null } } };
  });
