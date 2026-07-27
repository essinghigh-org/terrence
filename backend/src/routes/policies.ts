import { Elysia } from "elysia";
import { db } from "../db";
import { policySets, policySetWorkspaces, policySetProjects, policySetExclusions, policySetParameters, policies, policyChecks, runs, workspaces, organizations } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

export const policyRoutes = new Elysia({ name: "policies" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/policy-sets", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const psList = await db.query.policySets.findMany({ where: eq(policySets.orgId, org.id) });
    const data = await Promise.all(psList.map(async ps => {
      const [projLinks, exclLinks] = await Promise.all([
        db.query.policySetProjects.findMany({ where: eq(policySetProjects.policySetId, ps.id) }),
        db.query.policySetExclusions.findMany({ where: eq(policySetExclusions.policySetId, ps.id) }),
      ]);
      return { id: ps.id, type: "policy-sets", attributes: { name: ps.name, description: ps.description, kind: ps.kind, global: ps.global, overridable: ps.overridable, "agent-enabled": Boolean(ps.agentEnabled), "policy-tool-version": ps.policyToolVersion ?? null, "policies-path": ps.policiesPath ?? null, "vcs-repo": ps.vcsRepo ?? null }, relationships: { projects: { data: projLinks.map(l => ({ id: l.projectId, type: "projects" })) }, "workspace-exclusions": { data: exclLinks.map(l => ({ id: l.workspaceId, type: "workspaces" })) } } };
    }));
    return { data };
  })
  .post("/api/v2/organizations/:org_name/policy-sets", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `polset-${crypto.randomUUID()}`;
    await db.insert(policySets).values({ id, orgId: org.id, name: attributes.name, description: attributes.description ?? null, kind: attributes.kind ?? "sentinel", global: attributes.global ?? false, overridable: attributes.overridable ?? true, agentEnabled: attributes["agent-enabled"] ?? false, policyToolVersion: attributes["policy-tool-version"] ?? null, policiesPath: attributes["policies-path"] ?? null, vcsRepo: attributes["vcs-repo"] ?? null, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "policy-sets", attributes: { name: attributes.name, description: attributes.description ?? null, kind: attributes.kind ?? "sentinel", global: attributes.global ?? false, overridable: attributes.overridable ?? true, "agent-enabled": Boolean(attributes["agent-enabled"] ?? false), "policy-tool-version": attributes["policy-tool-version"] ?? null, "policies-path": attributes["policies-path"] ?? null, "vcs-repo": attributes["vcs-repo"] ?? null } } };
  })
  .get("/api/v2/policy-sets/:policy_set_id", async ({ params: { policy_set_id }, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [projLinks, exclLinks] = await Promise.all([
      db.query.policySetProjects.findMany({ where: eq(policySetProjects.policySetId, policy_set_id) }),
      db.query.policySetExclusions.findMany({ where: eq(policySetExclusions.policySetId, policy_set_id) }),
    ]);
    return { data: { id: ps.id, type: "policy-sets", attributes: { name: ps.name, description: ps.description, kind: ps.kind, global: ps.global, overridable: ps.overridable, "agent-enabled": Boolean(ps.agentEnabled), "policy-tool-version": ps.policyToolVersion ?? null, "policies-path": ps.policiesPath ?? null, "vcs-repo": ps.vcsRepo ?? null }, relationships: { projects: { data: projLinks.map(l => ({ id: l.projectId, type: "projects" })) }, "workspace-exclusions": { data: exclLinks.map(l => ({ id: l.workspaceId, type: "workspaces" })) } } } };
  })
  .patch("/api/v2/policy-sets/:policy_set_id", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof policySets.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = attributes.description;
    if (typeof attributes.kind === "string") updates.kind = attributes.kind;
    if (typeof attributes.global === "boolean") updates.global = attributes.global;
    if (typeof attributes.overridable === "boolean") updates.overridable = attributes.overridable;
    if (typeof attributes["agent-enabled"] === "boolean") updates.agentEnabled = attributes["agent-enabled"];
    if (attributes["policy-tool-version"] !== undefined) updates.policyToolVersion = attributes["policy-tool-version"];
    if (attributes["policies-path"] !== undefined) updates.policiesPath = attributes["policies-path"];
    if (attributes["vcs-repo"] !== undefined) updates.vcsRepo = attributes["vcs-repo"];
    if (Object.keys(updates).length > 0) await db.update(policySets).set(updates).where(eq(policySets.id, policy_set_id));
    const updated = (await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) }))!;
    return { data: { id: updated.id, type: "policy-sets", attributes: { name: updated.name, description: updated.description, kind: updated.kind, global: updated.global, overridable: updated.overridable, "agent-enabled": Boolean(updated.agentEnabled), "policy-tool-version": updated.policyToolVersion ?? null, "policies-path": updated.policiesPath ?? null, "vcs-repo": updated.vcsRepo ?? null } } };
  })
  .delete("/api/v2/policy-sets/:policy_set_id", async ({ params: { policy_set_id }, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(policySets).where(eq(policySets.id, policy_set_id));
    set.status = 204;
  })
  // --- Policy Set Relationships ---
  .post("/api/v2/policy-sets/:policy_set_id/relationships/workspaces", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const wsItems = (body as any)?.data;
    if (Array.isArray(wsItems)) { for (const item of wsItems) { if (item?.id) await db.insert(policySetWorkspaces).values({ id: `psw-${crypto.randomUUID()}`, policySetId: policy_set_id, workspaceId: item.id }).onConflictDoNothing(); } }
    set.status = 204;
  })
  .post("/api/v2/policy-sets/:policy_set_id/relationships/projects", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const projItems = (body as any)?.data;
    if (Array.isArray(projItems)) { for (const item of projItems) { if (item?.id) await db.insert(policySetProjects).values({ id: `pspj-${crypto.randomUUID()}`, policySetId: policy_set_id, projectId: item.id }).onConflictDoNothing(); } }
    set.status = 204;
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/projects", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const projItems = (body as any)?.data;
    if (Array.isArray(projItems)) { const projIds = projItems.map(i => i.id).filter(Boolean); if (projIds.length > 0) await db.delete(policySetProjects).where(and(eq(policySetProjects.policySetId, policy_set_id), inArray(policySetProjects.projectId, projIds))); }
    set.status = 204;
  })
  .post("/api/v2/policy-sets/:policy_set_id/relationships/workspace-exclusions", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const wsItems = (body as any)?.data;
    if (Array.isArray(wsItems)) { for (const item of wsItems) { if (item?.id) await db.insert(policySetExclusions).values({ id: `psex-${crypto.randomUUID()}`, policySetId: policy_set_id, workspaceId: item.id }).onConflictDoNothing(); } }
    set.status = 204;
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/workspace-exclusions", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const wsItems = (body as any)?.data;
    if (Array.isArray(wsItems)) { const wsIds = wsItems.map(i => i.id).filter(Boolean); if (wsIds.length > 0) await db.delete(policySetExclusions).where(and(eq(policySetExclusions.policySetId, policy_set_id), inArray(policySetExclusions.workspaceId, wsIds))); }
    set.status = 204;
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/workspaces", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const wsItems = (body as any)?.data;
    if (Array.isArray(wsItems)) { const wsIds = wsItems.map(i => i.id).filter(Boolean); if (wsIds.length > 0) await db.delete(policySetWorkspaces).where(and(eq(policySetWorkspaces.policySetId, policy_set_id), inArray(policySetWorkspaces.workspaceId, wsIds))); }
    set.status = 204;
  })
  // --- Policies ---
  .get("/api/v2/policy-sets/:policy_set_id/policies", async ({ params: { policy_set_id }, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const polList = await db.query.policies.findMany({ where: eq(policies.policySetId, policy_set_id) });
    return { data: polList.map(p => ({ id: p.id, type: "policies", attributes: { name: p.name, description: p.description, "enforcement-level": p.enforcementLevel, query: p.query } })) };
  })
  .post("/api/v2/policy-sets/:policy_set_id/policies", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `pol-${crypto.randomUUID()}`;
    await db.insert(policies).values({ id, policySetId: policy_set_id, name: attributes.name, description: attributes.description ?? null, enforcementLevel: attributes["enforcement-level"] ?? "soft-mandatory", query: attributes.query ?? null, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "policies", attributes: { name: attributes.name, description: attributes.description ?? null, "enforcement-level": attributes["enforcement-level"] ?? "soft-mandatory", query: attributes.query ?? null } } };
  })
  .get("/api/v2/policies/:policy_id", async ({ params: { policy_id }, user, orgId: tokenOrgId, set }) => {
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policy_id) });
    if (!pol) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: pol.id, type: "policies", attributes: { name: pol.name, description: pol.description, "enforcement-level": pol.enforcementLevel, query: pol.query } } };
  })
  .patch("/api/v2/policies/:policy_id", async ({ params: { policy_id }, body, user, orgId: tokenOrgId, set }) => {
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policy_id) });
    if (!pol) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof policies.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = attributes.description;
    if (typeof attributes["enforcement-level"] === "string") updates.enforcementLevel = attributes["enforcement-level"];
    if (attributes.query !== undefined) updates.query = attributes.query;
    if (Object.keys(updates).length > 0) await db.update(policies).set(updates).where(eq(policies.id, policy_id));
    const updated = (await db.query.policies.findFirst({ where: eq(policies.id, policy_id) }))!;
    return { data: { id: updated.id, type: "policies", attributes: { name: updated.name, description: updated.description, "enforcement-level": updated.enforcementLevel, query: updated.query } } };
  })
  .delete("/api/v2/policies/:policy_id", async ({ params: { policy_id }, user, orgId: tokenOrgId, set }) => {
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policy_id) });
    if (!pol) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(policies).where(eq(policies.id, policy_id));
    set.status = 204;
  })
  // --- Policy Checks ---
  .get("/api/v2/runs/:run_id/policy-checks", async ({ params: { run_id }, user, orgId: tokenOrgId, set }) => {
    const run = await db.query.runs.findFirst({ where: eq(runs.id, run_id) });
    if (!run) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pcList = await db.query.policyChecks.findMany({ where: eq(policyChecks.runId, run_id) });
    return { data: pcList.map(pc => ({ id: pc.id, type: "policy-checks", attributes: { status: pc.status, result: pc.result, "created-at": new Date(pc.createdAt).toISOString() } })) };
  })
  .get("/api/v2/policy-checks/:check_id", async ({ params: { check_id }, user, orgId: tokenOrgId, set }) => {
    const pc = await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, check_id) });
    if (!pc) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, pc.runId) });
    if (!run) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: pc.id, type: "policy-checks", attributes: { status: pc.status, result: pc.result, "created-at": new Date(pc.createdAt).toISOString() } } };
  })
  .post("/api/v2/policy-checks/:check_id/actions/override", async ({ params: { check_id }, user, orgId: tokenOrgId, set }) => {
    const pc = await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, check_id) });
    if (!pc) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, pc.runId) });
    if (!run) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "owner", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.update(policyChecks).set({ status: "overridden" }).where(eq(policyChecks.id, check_id));
    return { data: { id: pc.id, type: "policy-checks", attributes: { status: "overridden", result: pc.result } } };
  })
  // --- Policy Set Parameters ---
  .get("/api/v2/policy-sets/:policy_set_id/parameters", async ({ params: { policy_set_id }, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const paramsList = await db.query.policySetParameters.findMany({ where: eq(policySetParameters.policySetId, policy_set_id) });
    return { data: paramsList.map(p => ({ id: p.id, type: "vars", attributes: { key: p.key, value: p.sensitive ? null : p.value, sensitive: p.sensitive, hcl: p.hcl } })) };
  })
  .post("/api/v2/policy-sets/:policy_set_id/parameters", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.key) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `psparam-${crypto.randomUUID()}`;
    await db.insert(policySetParameters).values({ id, policySetId: policy_set_id, key: attrs.key, value: attrs.value ?? "", sensitive: attrs.sensitive ?? false, hcl: attrs.hcl ?? false });
    set.status = 201;
    return { data: { id, type: "vars", attributes: { key: attrs.key, value: attrs.sensitive ? null : (attrs.value ?? ""), sensitive: attrs.sensitive ?? false, hcl: attrs.hcl ?? false } } };
  })
  .patch("/api/v2/policy-sets/:policy_set_id/parameters/:param_id", async ({ params: { policy_set_id, param_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const param = await db.query.policySetParameters.findFirst({ where: and(eq(policySetParameters.id, param_id), eq(policySetParameters.policySetId, policy_set_id)) });
    if (!param) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof policySetParameters.$inferInsert> = {};
    if (attrs.key !== undefined) updates.key = attrs.key;
    if (attrs.value !== undefined) updates.value = attrs.value;
    if (attrs.sensitive !== undefined) updates.sensitive = attrs.sensitive;
    if (attrs.hcl !== undefined) updates.hcl = attrs.hcl;
    if (Object.keys(updates).length > 0) await db.update(policySetParameters).set(updates).where(eq(policySetParameters.id, param_id));
    const updated = (await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, param_id) }))!;
    return { data: { id: updated.id, type: "vars", attributes: { key: updated.key, value: updated.sensitive ? null : updated.value, sensitive: updated.sensitive, hcl: updated.hcl } } };
  })
  .delete("/api/v2/policy-sets/:policy_set_id/parameters/:param_id", async ({ params: { policy_set_id, param_id }, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const param = await db.query.policySetParameters.findFirst({ where: and(eq(policySetParameters.id, param_id), eq(policySetParameters.policySetId, policy_set_id)) });
    if (!param) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(policySetParameters).where(eq(policySetParameters.id, param_id));
    set.status = 204;
  });
