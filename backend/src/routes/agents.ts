import { Elysia } from "elysia";
import { db } from "../db";
import { agentPools, agents, agentPoolTokens, organizations } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

export const agentRoutes = new Elysia({ name: "agents" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/agent-pools", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pools = await db.query.agentPools.findMany({ where: eq(agentPools.orgId, org.id) });
    const poolData = await Promise.all(pools.map(async p => { const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, p.id) }); return { id: p.id, type: "agent-pools", attributes: { name: p.name, "organization-scoped": p.organizationScoped, "agent-count": agentList.length } }; }));
    return { data: poolData };
  })
  .post("/api/v2/organizations/:org_name/agent-pools", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.name) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `apool-${crypto.randomUUID()}`;
    await db.insert(agentPools).values({ id, orgId: org.id, name: attrs.name, organizationScoped: attrs["organization-scoped"] ?? true, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "agent-pools", attributes: { name: attrs.name, "organization-scoped": attrs["organization-scoped"] ?? true, "agent-count": 0 } } };
  })
  .get("/api/v2/agent-pools/:pool_id", async ({ params: { pool_id }, user, orgId: tokenOrgId, set }) => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, pool_id) });
    return { data: { id: pool.id, type: "agent-pools", attributes: { name: pool.name, "organization-scoped": pool.organizationScoped, "agent-count": agentList.length } } };
  })
  .patch("/api/v2/agent-pools/:pool_id", async ({ params: { pool_id }, body, user, orgId: tokenOrgId, set }) => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof agentPools.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["organization-scoped"] === "boolean") updates.organizationScoped = attributes["organization-scoped"];
    if (Object.keys(updates).length > 0) await db.update(agentPools).set(updates).where(eq(agentPools.id, pool_id));
    const updated = (await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) }))!;
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, pool_id) });
    return { data: { id: updated.id, type: "agent-pools", attributes: { name: updated.name, "organization-scoped": updated.organizationScoped, "agent-count": agentList.length } } };
  })
  .delete("/api/v2/agent-pools/:pool_id", async ({ params: { pool_id }, user, orgId: tokenOrgId, set }) => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(agentPools).where(eq(agentPools.id, pool_id));
    set.status = 204;
  })
  // --- Agents ---
  .get("/api/v2/agent-pools/:pool_id/agents", async ({ params: { pool_id }, user, orgId: tokenOrgId, set }) => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, pool_id) });
    return { data: agentList.map(a => ({ id: a.id, type: "agents", attributes: { name: a.name, status: a.status, "ip-address": a.ipAddress, version: a.version, architecture: a.architecture, "last-ping-at": a.lastPingAt ? new Date(a.lastPingAt).toISOString() : null }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } })) };
  })
  .post("/api/v2/agent-pools/:pool_id/agents", async ({ params: { pool_id }, body, user, orgId: tokenOrgId, set }) => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.name) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const agentId = `agent-${crypto.randomUUID()}`;
    const now = Date.now();
    await db.insert(agents).values({ id: agentId, agentPoolId: pool.id, name: attrs.name, status: attrs.status ?? "idle", ipAddress: attrs["ip-address"] ?? null, version: attrs.version ?? null, architecture: attrs.architecture ?? null, lastPingAt: now, createdAt: now });
    set.status = 201;
    return { data: { id: agentId, type: "agents", attributes: { name: attrs.name, status: attrs.status ?? "idle", "ip-address": attrs["ip-address"] ?? null, version: attrs.version ?? null, architecture: attrs.architecture ?? null, "last-ping-at": new Date(now).toISOString() }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } } };
  })
  .get("/api/v2/agents/:agent_id", async ({ params: { agent_id }, user, orgId: tokenOrgId, set }) => {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agent_id) });
    if (!agent) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, agent.agentPoolId) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: agent.id, type: "agents", attributes: { name: agent.name, status: agent.status, "ip-address": agent.ipAddress, version: agent.version, architecture: agent.architecture, "last-ping-at": agent.lastPingAt ? new Date(agent.lastPingAt).toISOString() : null }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } } };
  })
  .delete("/api/v2/agents/:agent_id", async ({ params: { agent_id }, user, orgId: tokenOrgId, set }) => {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agent_id) });
    if (!agent) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, agent.agentPoolId) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(agents).where(eq(agents.id, agent_id));
    set.status = 204;
  })
  // --- Agent Pool Tokens ---
  .get("/api/v2/agent-pools/:pool_id/authentication-tokens", async ({ params: { pool_id }, user, orgId: tokenOrgId, set }) => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tokenList = await db.query.agentPoolTokens.findMany({ where: eq(agentPoolTokens.agentPoolId, pool_id) });
    return { data: tokenList.map(t => ({ id: t.id, type: "authentication-tokens", attributes: { description: t.description, "created-at": new Date(t.createdAt).toISOString(), "last-used-at": t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : null } })) };
  })
  .post("/api/v2/agent-pools/:pool_id/authentication-tokens", async ({ params: { pool_id }, body, user, orgId: tokenOrgId, set }) => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    const description = attrs.description ?? `Agent token for ${pool.name}`;
    const rawToken = `agent-${crypto.randomUUID().replace(/-/g, "")}`;
    const tokenId = `atok-${crypto.randomUUID()}`;
    const { createHash } = await import("node:crypto");
    await db.insert(agentPoolTokens).values({ id: tokenId, agentPoolId: pool_id, token: createHash("sha256").update(rawToken).digest("hex"), description, createdAt: Date.now() });
    set.status = 201;
    return { data: { id: tokenId, type: "authentication-tokens", attributes: { token: rawToken, description, "created-at": new Date().toISOString() } } };
  });
