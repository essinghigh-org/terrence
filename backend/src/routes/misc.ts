import { Elysia } from "elysia";
import { db } from "../db";
import { runTriggers, auditLogs, organizations, workspaces, type users } from "../db/schema";
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

export const miscRoutes = new Elysia({ name: "misc" })
  .use(authPlugin)
  // --- Webhook Receivers ---
    .post("/api/webhooks/github", async ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): Promise<unknown> => {
    // 1. Validate signature if a secret is configured.
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const signature = request.headers.get("x-hub-signature-256");
    if (typeof secret === "string" && secret.length > 0) {
      if (signature === null) {
        (set as { status: number }).status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Missing signature" }] };
      }

      const payloadString = typeof body === "string" ? body : JSON.stringify(body ?? {});
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadString));
      const hashArray = Array.from(new Uint8Array(signatureBuffer));
      const hashHex = hashArray.map((b: number): string => b.toString(16).padStart(2, "0")).join("");
      const expectedSignature = `sha256=${hashHex}`;

      if (signature !== expectedSignature) {
        console.warn("[terrence] Webhook signature validation failed");
      }
    }

    const eventName = request.headers.get("x-github-event");
    if (eventName === "push" || eventName === "pull_request") {
      console.log(`[terrence] Received GitHub ${eventName} event.`);

      const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const repo = payload.repository as Record<string, unknown> | undefined;
      const repoFullName = typeof repo?.full_name === "string" ? repo.full_name : "";

      let branch = "";
      if (eventName === "push") {
        branch = typeof payload.ref === "string" ? payload.ref.replace("refs/heads/", "") : "";
      } else {
        const pr = payload.pull_request as Record<string, unknown> | undefined;
        const head = pr?.head as Record<string, unknown> | undefined;
        branch = typeof head?.ref === "string" ? head.ref : "";
      }

      if (repoFullName !== "" && branch !== "") {
         void handleGithubWebhook(eventName, payload).catch(console.error);
      }
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
