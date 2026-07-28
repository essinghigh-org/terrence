import { Elysia } from "elysia";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../db";
import { runTriggers, auditLogs, githubWebhookDeliveries, organizations, workspaces, type users } from "../db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { checkOrgPermission, findAuthorizedRun } from "../lib/utils";
import { handleGithubWebhook } from "../lib/webhooks";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  set: SetObj;
}>;

async function processGithubDelivery(deliveryId: string | null, eventName: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  try {
    await handleGithubWebhook(eventName, payload);
    if (deliveryId !== null) {
      await db.update(githubWebhookDeliveries)
        .set({ status: "processed", processedAt: Date.now() })
        .where(eq(githubWebhookDeliveries.id, deliveryId));
    }
  } catch (error) {
    if (deliveryId !== null) await db.delete(githubWebhookDeliveries).where(eq(githubWebhookDeliveries.id, deliveryId));
    console.error(error);
  }
}

export const miscRoutes = new Elysia({ name: "misc" })
  .use(authPlugin)
  // --- Webhook Receivers ---
    .post("/api/webhooks/github", async ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): Promise<unknown> => {
    const secret = process.env["GITHUB_WEBHOOK_SECRET"];
    const signature = request.headers.get("x-hub-signature-256");
    const rawBody = typeof body === "string" ? body : "";
    if (typeof secret === "string" && secret.length > 0) {
      if (signature === null) {
        (set as { status: number }).status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Missing signature" }] };
      }

      const expectedSignature = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
      const providedSignature = Buffer.from(signature);
      if (providedSignature.length !== expectedSignature.length || !timingSafeEqual(providedSignature, expectedSignature)) {
        (set as { status: number }).status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid signature" }] };
      }
    }

    const eventName = request.headers.get("x-github-event");
    if (eventName !== null) {
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed !== null && typeof parsed === "object") payload = parsed as Record<string, unknown>;
      } catch {}
      const deliveryHeader = request.headers.get("x-github-delivery");
      const deliveryId = deliveryHeader !== null && deliveryHeader !== "" ? deliveryHeader : null;
      if (deliveryId !== null) {
        const claimed = await db.insert(githubWebhookDeliveries)
          .values({ id: deliveryId, status: "processing", receivedAt: Date.now() })
          .onConflictDoNothing()
          .returning({ id: githubWebhookDeliveries.id });
        if (claimed.length === 0) {
          return { data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } };
        }
      }

      if (eventName === "push" || eventName === "pull_request") {
        console.log(`[terrence] Received GitHub ${eventName} event.`);
      }
      void processGithubDelivery(deliveryId, eventName, payload);
    }

    return { data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } };
  })
  .post("/api/webhooks/gitlab", (): unknown => ({ data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } }))
  .post("/api/webhooks/bitbucket", (): unknown => ({ data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } }))
  // --- Entitlements ---
  .get("/api/v2/entitlements", (): unknown => ({
    data: { id: "entitlements", type: "entitlements", attributes: { agents: true, audit_logging: true, sentinel: true, state_storage: true, teams: true, vcs_integrations: true, run_tasks: true } },
  }))
  // --- Deprecated Global Vars API ---
  .get("/api/v2/vars", (): unknown => {
    return { data: [] };
  })
  .post("/api/v2/vars", (): unknown => {
    return { data: null };
  })
  .patch("/api/v2/vars/:var_id", (): unknown => {
    return { data: null };
  })
  .delete("/api/v2/vars/:var_id", ({ set }: ParamCtx): Record<string, never> => {
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Audit Trails ---
  .get("/api/v2/admin/audit-logs", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const logsList = await db.query.auditLogs.findMany({ limit: 100, orderBy: [desc(auditLogs.createdAt)] });
    return { data: logsList.map((al: Readonly<typeof auditLogs.$inferSelect>): Record<string, unknown> => ({ id: al.id, type: "audit-logs", attributes: { action: al.action, "resource-type": al.resourceType, "resource-id": al.resourceId, details: al.details, "created-at": new Date(al.createdAt).toISOString() } })) };
  })
  .get("/api/v2/organizations/:org_name/audit-logs", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const logsList = await db.query.auditLogs.findMany({ where: eq(auditLogs.orgId, org.id), limit: 100, orderBy: [desc(auditLogs.createdAt)] });
    return { data: logsList.map((al: Readonly<typeof auditLogs.$inferSelect>): Record<string, unknown> => ({ id: al.id, type: "audit-logs", attributes: { action: al.action, "resource-type": al.resourceType, "resource-id": al.resourceId, details: al.details, "created-at": new Date(al.createdAt).toISOString() } })) };
  })
  .get("/api/v2/organization-audit-trailers", ({ user, set }: ParamCtx): unknown => {
    if (user === null || user === undefined) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    return { data: [] };
  })
  .get("/api/v2/audit-trails", ({ user, set }: ParamCtx): unknown => {
    if (user === null || user === undefined) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    return { data: [] };
  })
  // --- Cost Estimation ---
  .get("/api/v2/runs/:run_id/cost-estimate", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const run = await findAuthorizedRun(runId, user?.id, orgId);
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: `ce-${runId}`, type: "cost-estimates", attributes: { status: "finished", "delta-monthly-cost": "0.0", "prior-monthly-cost": "0.0", "proposed-monthly-cost": "0.0", "resources-count": 0, "matched-resources-count": 0, "unmatched-resources-count": 0, "error-message": null } } };
  })
  .get("/api/v2/cost-estimates/:ce_id", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const ceId = params["ce_id"] ?? "";
    const runId = ceId.replace(/^ce-/, "");
    if (runId === "") { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await findAuthorizedRun(runId, user?.id, orgId);
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ceId, type: "cost-estimates", attributes: { status: "finished", "delta-monthly-cost": "0.0", "prior-monthly-cost": "0.0", "proposed-monthly-cost": "0.0", "resources-count": 0, "matched-resources-count": 0, "unmatched-resources-count": 0, "error-message": null } } };
  })
  // --- Run Triggers ---
  .get("/api/v2/workspaces/:workspace_id/run-triggers", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const triggers = await db.query.runTriggers.findMany({ where: eq(runTriggers.workspaceId, workspaceId) });
    return { data: triggers.map((t: Readonly<typeof runTriggers.$inferSelect>): Record<string, unknown> => ({ id: t.id, type: "run-triggers", attributes: { "created-at": new Date(t.createdAt).toISOString() }, relationships: { "sourceable-workspace": { data: { id: t.sourceWorkspaceId, type: "workspaces" } } } })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item !== null && typeof item === "object") {
          const i = item as Record<string, unknown>;
          const attrs = typeof i.attributes === "object" && i.attributes !== null ? (i.attributes as Record<string, unknown>) : undefined;
          const srcId = typeof i.id === "string" ? i.id : (typeof attrs?.["source-workspace-id"] === "string" ? attrs["source-workspace-id"] : "");
          if (srcId !== "") {
            await db.insert(runTriggers).values({ id: `rt-${crypto.randomUUID()}`, workspaceId, sourceWorkspaceId: srcId }).onConflictDoNothing();
          }
        }
      }
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      const srcIds = items.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== "");
      if (srcIds.length > 0) {
        await db.delete(runTriggers).where(and(eq(runTriggers.workspaceId, workspaceId), inArray(runTriggers.sourceWorkspaceId, srcIds)));
      }
    }
    (set as { status: number }).status = 204;
    return {};
  });
