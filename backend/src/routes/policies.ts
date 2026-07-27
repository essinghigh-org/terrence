import { Elysia } from "elysia";
import { db } from "../db";
import { policySets, policySetWorkspaces, policySetProjects, policySetExclusions, policySetParameters, policies, policyChecks, runs, workspaces, organizations, type users } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: Readonly<typeof users.$inferSelect> | null;
  readonly orgId?: string | null;
  readonly set: SetObj;
}>;

type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type PsItem = DeepReadonly<typeof policySets.$inferSelect>;
type LinkProjItem = Readonly<{ readonly projectId: string }>;
type LinkExclItem = Readonly<{ readonly workspaceId: string }>;
type PolItem = DeepReadonly<typeof policies.$inferSelect>;
type PcItem = DeepReadonly<typeof policyChecks.$inferSelect>;
type ParamItem = DeepReadonly<typeof policySetParameters.$inferSelect>;


export const policyRoutes = new Elysia({ name: "policies" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/policy-sets", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const psList = await db.query.policySets.findMany({ where: eq(policySets.orgId, org.id) });
    const data = await Promise.all(psList.map(async (ps: PsItem): Promise<Record<string, unknown>> => {
      const [projLinks, exclLinks] = await Promise.all([
        db.query.policySetProjects.findMany({ where: eq(policySetProjects.policySetId, ps.id) }),
        db.query.policySetExclusions.findMany({ where: eq(policySetExclusions.policySetId, ps.id) }),
      ]);
      return { id: ps.id, type: "policy-sets", attributes: { name: ps.name, description: ps.description, kind: ps.kind, global: ps.global, overridable: ps.overridable, "agent-enabled": ps.agentEnabled ?? false, "policy-tool-version": ps.policyToolVersion, "policies-path": ps.policiesPath, "vcs-repo": ps.vcsRepo }, relationships: { projects: { data: projLinks.map((l: LinkProjItem): Record<string, string> => ({ id: l.projectId, type: "projects" })) }, "workspace-exclusions": { data: exclLinks.map((l: LinkExclItem): Record<string, string> => ({ id: l.workspaceId, type: "workspaces" })) } } };
    }));
    return { data };
  })
  .post("/api/v2/organizations/:org_name/policy-sets", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `polset-${crypto.randomUUID()}`;
    const description = typeof attributes.description === "string" ? attributes.description : null;
    const kind = typeof attributes.kind === "string" ? attributes.kind : "sentinel";
    const global = typeof attributes.global === "boolean" ? attributes.global : false;
    const overridable = typeof attributes.overridable === "boolean" ? attributes.overridable : true;
    const agentEnabled = typeof attributes["agent-enabled"] === "boolean" ? attributes["agent-enabled"] : false;
    const policyToolVersion = typeof attributes["policy-tool-version"] === "string" ? attributes["policy-tool-version"] : null;
    const policiesPath = typeof attributes["policies-path"] === "string" ? attributes["policies-path"] : null;
    const vcsRepo = typeof attributes["vcs-repo"] === "string" ? attributes["vcs-repo"] : null;
    await db.insert(policySets).values({ id, orgId: org.id, name, description, kind, global, overridable, agentEnabled, policyToolVersion, policiesPath, vcsRepo, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "policy-sets", attributes: { name, description, kind, global, overridable, "agent-enabled": agentEnabled, "policy-tool-version": policyToolVersion, "policies-path": policiesPath, "vcs-repo": vcsRepo } } };
  })
  .get("/api/v2/policy-sets/:policy_set_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [projLinks, exclLinks] = await Promise.all([
      db.query.policySetProjects.findMany({ where: eq(policySetProjects.policySetId, policySetId) }),
      db.query.policySetExclusions.findMany({ where: eq(policySetExclusions.policySetId, policySetId) }),
    ]);
    return { data: { id: ps.id, type: "policy-sets", attributes: { name: ps.name, description: ps.description, kind: ps.kind, global: ps.global, overridable: ps.overridable, "agent-enabled": ps.agentEnabled ?? false, "policy-tool-version": ps.policyToolVersion, "policies-path": ps.policiesPath, "vcs-repo": ps.vcsRepo }, relationships: { projects: { data: projLinks.map((l: LinkProjItem): Record<string, string> => ({ id: l.projectId, type: "projects" })) }, "workspace-exclusions": { data: exclLinks.map((l: LinkExclItem): Record<string, string> => ({ id: l.workspaceId, type: "workspaces" })) } } } };
  })
  .patch("/api/v2/policy-sets/:policy_set_id", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof policySets.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = typeof attributes.description === "string" ? attributes.description : null;
    if (typeof attributes.kind === "string") updates.kind = attributes.kind;
    if (typeof attributes.global === "boolean") updates.global = attributes.global;
    if (typeof attributes.overridable === "boolean") updates.overridable = attributes.overridable;
    if (typeof attributes["agent-enabled"] === "boolean") updates.agentEnabled = attributes["agent-enabled"];
    if (attributes["policy-tool-version"] !== undefined) updates.policyToolVersion = typeof attributes["policy-tool-version"] === "string" ? attributes["policy-tool-version"] : null;
    if (attributes["policies-path"] !== undefined) updates.policiesPath = typeof attributes["policies-path"] === "string" ? attributes["policies-path"] : null;
    if (attributes["vcs-repo"] !== undefined) updates.vcsRepo = typeof attributes["vcs-repo"] === "string" ? attributes["vcs-repo"] : null;
    if (Object.keys(updates).length > 0) await db.update(policySets).set(updates).where(eq(policySets.id, policySetId));
    const updated = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "policy-sets", attributes: { name: updated.name, description: updated.description, kind: updated.kind, global: updated.global, overridable: updated.overridable, "agent-enabled": updated.agentEnabled ?? false, "policy-tool-version": updated.policyToolVersion, "policies-path": updated.policiesPath, "vcs-repo": updated.vcsRepo } } };
  })
  .delete("/api/v2/policy-sets/:policy_set_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(policySets).where(eq(policySets.id, policySetId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Policy Set Relationships ---
  .post("/api/v2/policy-sets/:policy_set_id/relationships/workspaces", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const wsItems = payload.data;
    if (Array.isArray(wsItems)) { for (const item of wsItems) { if (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") { const wsId = (item as Record<string, unknown>).id as string; await db.insert(policySetWorkspaces).values({ id: `psw-${crypto.randomUUID()}`, policySetId, workspaceId: wsId }).onConflictDoNothing(); } } }
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/policy-sets/:policy_set_id/relationships/projects", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const projItems = payload.data;
    if (Array.isArray(projItems)) { for (const item of projItems) { if (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") { const projId = (item as Record<string, unknown>).id as string; await db.insert(policySetProjects).values({ id: `pspj-${crypto.randomUUID()}`, policySetId, projectId: projId }).onConflictDoNothing(); } } }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/projects", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const projItems = payload.data;
    if (Array.isArray(projItems)) { const projIds = projItems.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== ""); if (projIds.length > 0) await db.delete(policySetProjects).where(and(eq(policySetProjects.policySetId, policySetId), inArray(policySetProjects.projectId, projIds))); }
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/policy-sets/:policy_set_id/relationships/workspace-exclusions", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const wsItems = payload.data;
    if (Array.isArray(wsItems)) { for (const item of wsItems) { if (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") { const wsId = (item as Record<string, unknown>).id as string; await db.insert(policySetExclusions).values({ id: `psex-${crypto.randomUUID()}`, policySetId, workspaceId: wsId }).onConflictDoNothing(); } } }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/workspace-exclusions", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const wsItems = payload.data;
    if (Array.isArray(wsItems)) { const wsIds = wsItems.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== ""); if (wsIds.length > 0) await db.delete(policySetExclusions).where(and(eq(policySetExclusions.policySetId, policySetId), inArray(policySetExclusions.workspaceId, wsIds))); }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/workspaces", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const wsItems = payload.data;
    if (Array.isArray(wsItems)) { const wsIds = wsItems.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== ""); if (wsIds.length > 0) await db.delete(policySetWorkspaces).where(and(eq(policySetWorkspaces.policySetId, policySetId), inArray(policySetWorkspaces.workspaceId, wsIds))); }
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Policies ---
  .get("/api/v2/policy-sets/:policy_set_id/policies", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const polList = await db.query.policies.findMany({ where: eq(policies.policySetId, policySetId) });
    return { data: polList.map((p: PolItem): Record<string, unknown> => ({ id: p.id, type: "policies", attributes: { name: p.name, description: p.description, "enforcement-level": p.enforcementLevel, query: p.query } })) };
  })
  .post("/api/v2/policy-sets/:policy_set_id/policies", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `pol-${crypto.randomUUID()}`;
    const description = typeof attributes.description === "string" ? attributes.description : null;
    const enforcementLevel = typeof attributes["enforcement-level"] === "string" ? attributes["enforcement-level"] : "soft-mandatory";
    const query = typeof attributes.query === "string" ? attributes.query : null;
    await db.insert(policies).values({ id, policySetId, name, description, enforcementLevel, query, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "policies", attributes: { name, description, "enforcement-level": enforcementLevel, query } } };
  })
  .get("/api/v2/policies/:policy_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const policyId = params["policy_id"] ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: pol.id, type: "policies", attributes: { name: pol.name, description: pol.description, "enforcement-level": pol.enforcementLevel, query: pol.query } } };
  })
  .patch("/api/v2/policies/:policy_id", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const policyId = params["policy_id"] ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof policies.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = typeof attributes.description === "string" ? attributes.description : null;
    if (typeof attributes["enforcement-level"] === "string") updates.enforcementLevel = attributes["enforcement-level"];
    if (attributes.query !== undefined) updates.query = typeof attributes.query === "string" ? attributes.query : null;
    if (Object.keys(updates).length > 0) await db.update(policies).set(updates).where(eq(policies.id, policyId));
    const updated = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "policies", attributes: { name: updated.name, description: updated.description, "enforcement-level": updated.enforcementLevel, query: updated.query } } };
  })
  .delete("/api/v2/policies/:policy_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policyId = params["policy_id"] ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(policies).where(eq(policies.id, policyId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Policy Checks ---
  .get("/api/v2/runs/:run_id/policy-checks", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pcList = await db.query.policyChecks.findMany({ where: eq(policyChecks.runId, runId) });
    return { data: pcList.map((pc: PcItem): Record<string, unknown> => ({ id: pc.id, type: "policy-checks", attributes: { status: pc.status, result: pc.result, "created-at": new Date(pc.createdAt).toISOString() } })) };
  })
  .get("/api/v2/policy-checks/:check_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const checkId = params["check_id"] ?? "";
    const pc = await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, checkId) });
    if (pc === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, pc.runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: pc.id, type: "policy-checks", attributes: { status: pc.status, result: pc.result, "created-at": new Date(pc.createdAt).toISOString() } } };
  })
  .post("/api/v2/policy-checks/:check_id/actions/override", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const checkId = params["check_id"] ?? "";
    const pc = await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, checkId) });
    if (pc === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, pc.runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "owner", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.update(policyChecks).set({ status: "overridden" }).where(eq(policyChecks.id, checkId));
    return { data: { id: pc.id, type: "policy-checks", attributes: { status: "overridden", result: pc.result } } };
  })
  // --- Policy Set Parameters ---
  .get("/api/v2/policy-sets/:policy_set_id/parameters", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const paramsList = await db.query.policySetParameters.findMany({ where: eq(policySetParameters.policySetId, policySetId) });
    return { data: paramsList.map((p: ParamItem): Record<string, unknown> => ({ id: p.id, type: "vars", attributes: { key: p.key, value: p.sensitive === true ? null : p.value, sensitive: p.sensitive, hcl: p.hcl } })) };
  })
  .post("/api/v2/policy-sets/:policy_set_id/parameters", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params["policy_set_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const key = typeof attrs.key === "string" ? attrs.key : "";
    if (key === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `psparam-${crypto.randomUUID()}`;
    const value = typeof attrs.value === "string" ? attrs.value : "";
    const sensitive = typeof attrs.sensitive === "boolean" ? attrs.sensitive : false;
    const hcl = typeof attrs.hcl === "boolean" ? attrs.hcl : false;
    await db.insert(policySetParameters).values({ id, policySetId, key, value, sensitive, hcl });
    (set as { status: number }).status = 201;
    return { data: { id, type: "vars", attributes: { key, value: sensitive ? null : value, sensitive, hcl } } };
  })
  .patch("/api/v2/policy-sets/:policy_set_id/parameters/:param_id", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params["policy_set_id"] ?? "";
    const paramId = params["param_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const param = await db.query.policySetParameters.findFirst({ where: and(eq(policySetParameters.id, paramId), eq(policySetParameters.policySetId, policySetId)) });
    if (param === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof policySetParameters.$inferInsert> = {};
    if (typeof attrs.key === "string") updates.key = attrs.key;
    if (typeof attrs.value === "string") updates.value = attrs.value;
    if (typeof attrs.sensitive === "boolean") updates.sensitive = attrs.sensitive;
    if (typeof attrs.hcl === "boolean") updates.hcl = attrs.hcl;
    if (Object.keys(updates).length > 0) await db.update(policySetParameters).set(updates).where(eq(policySetParameters.id, paramId));
    const updated = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, paramId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "vars", attributes: { key: updated.key, value: updated.sensitive === true ? null : updated.value, sensitive: updated.sensitive, hcl: updated.hcl } } };
  })
  .delete("/api/v2/policy-sets/:policy_set_id/parameters/:param_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params["policy_set_id"] ?? "";
    const paramId = params["param_id"] ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const param = await db.query.policySetParameters.findFirst({ where: and(eq(policySetParameters.id, paramId), eq(policySetParameters.policySetId, policySetId)) });
    if (param === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(policySetParameters).where(eq(policySetParameters.id, paramId));
    (set as { status: number }).status = 204;
    return {};
  });
