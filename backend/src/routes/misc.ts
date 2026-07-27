// @ts-nocheck
import { Elysia } from "elysia";
import { db } from "../db";
import { runTriggers, auditLogs, workspaceVariables, apiTokens, organizations, workspaces } from "../db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { checkOrgPermission, findAuthorizedRun, findAuthorizedWorkspace, pageRequest, pagination, auditLog, applyDataRetentionGarbageCollection } from "../lib/utils";
import { authGuard } from "./auth-guard";

export const miscRoutes = new Elysia({ name: "misc" })
  // --- Webhook Receivers ---
  .post("/api/webhooks/github", async () => ({ data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } }))
  .post("/api/webhooks/gitlab", async () => ({ data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } }))
  .post("/api/webhooks/bitbucket", async () => ({ data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } }))
  // --- Entitlements ---
  .get("/api/v2/entitlements", async () => ({
    data: { id: "entitlements", type: "entitlements", attributes: { agents: true, audit_logging: true, sentinel: true, state_storage: true, teams: true, vcs_integrations: true, run_tasks: true } },
  }))
  // --- Deprecated Global Vars API ---
  .get("/api/v2/vars", async ({ user, orgId: tokenOrgId, set }) => {
    return { data: [] };
  })
  .post("/api/v2/vars", async ({ body, user, orgId: tokenOrgId, set }) => {
    return { data: null };
  })
  .patch("/api/v2/vars/:var_id", async ({ params: { var_id }, body, user, orgId: tokenOrgId, set }) => {
    return { data: null };
  })
  .delete("/api/v2/vars/:var_id", async ({ params: { var_id }, user, orgId: tokenOrgId, set }) => {
    set.status = 204;
  })
  // --- Audit Trails ---
  .get("/api/v2/admin/audit-logs", async ({ user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const logsList = await db.query.auditLogs.findMany({ limit: 100, orderBy: [desc(auditLogs.createdAt)] });
    return { data: logsList.map(al => ({ id: al.id, type: "audit-logs", attributes: { action: al.action, "resource-type": al.resourceType, "resource-id": al.resourceId, details: al.details, "created-at": new Date(al.createdAt).toISOString() } })) };
  })
  .get("/api/v2/organizations/:org_name/audit-logs", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const logsList = await db.query.auditLogs.findMany({ where: eq(auditLogs.orgId, org.id), limit: 100, orderBy: [desc(auditLogs.createdAt)] });
    return { data: logsList.map(al => ({ id: al.id, type: "audit-logs", attributes: { action: al.action, "resource-type": al.resourceType, "resource-id": al.resourceId, details: al.details, "created-at": new Date(al.createdAt).toISOString() } })) };
  })
  .get("/api/v2/organization-audit-trailers", async ({ user, set }) => {
    if (!user) { set.status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    return { data: [] };
  })
  .get("/api/v2/audit-trails", async ({ user, set }) => {
    if (!user) { set.status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    return { data: [] };
  })
  // --- Cost Estimation ---
  .get("/api/v2/runs/:run_id/cost-estimate", async ({ params: { run_id }, user, orgId, set }) => {
    const run = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!run) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: `ce-${run_id}`, type: "cost-estimates", attributes: { status: "finished", "delta-monthly-cost": "0.0", "prior-monthly-cost": "0.0", "proposed-monthly-cost": "0.0", "resources-count": 0, "matched-resources-count": 0, "unmatched-resources-count": 0, "error-message": null } } };
  })
  .get("/api/v2/cost-estimates/:ce_id", async ({ params: { ce_id }, user, orgId, set }) => {
    const runId = ce_id.replace(/^ce-/, "");
    if (!runId) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await findAuthorizedRun(runId, user?.id, orgId);
    if (!run) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ce_id, type: "cost-estimates", attributes: { status: "finished", "delta-monthly-cost": "0.0", "prior-monthly-cost": "0.0", "proposed-monthly-cost": "0.0", "resources-count": 0, "matched-resources-count": 0, "unmatched-resources-count": 0, "error-message": null } } };
  })
  // --- Run Triggers ---
  .get("/api/v2/workspaces/:workspace_id/run-triggers", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "read", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const triggers = await db.query.runTriggers.findMany({ where: eq(runTriggers.workspaceId, workspace_id) });
    return { data: triggers.map(t => ({ id: t.id, type: "run-triggers", attributes: { "created-at": new Date(t.createdAt).toISOString() }, relationships: { "sourceable-workspace": { data: { id: t.sourceWorkspaceId, type: "workspaces" } } } })) };
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "read", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const items = (body as any)?.data;
    if (Array.isArray(items)) { for (const item of items) { const srcId = item?.id ?? item?.attributes?.["source-workspace-id"]; if (srcId) { await db.insert(runTriggers).values({ id: `rt-${crypto.randomUUID()}`, workspaceId: workspace_id, sourceWorkspaceId: srcId }).onConflictDoNothing(); } } }
    set.status = 204;
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "read", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const items = (body as any)?.data;
    if (Array.isArray(items)) { const srcIds = items.map(i => i.id).filter(Boolean); if (srcIds.length > 0) await db.delete(runTriggers).where(and(eq(runTriggers.workspaceId, workspace_id), inArray(runTriggers.sourceWorkspaceId, srcIds))); }
    set.status = 204;
  });
