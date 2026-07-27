import { Elysia } from "elysia";
import { db } from "../db";
import { agentPools, agents, agentPoolTokens, organizations } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

function getAttrs(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const data = (body as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return {};
  const attrs = (data as Record<string, unknown>).attributes;
  return typeof attrs === "object" && attrs !== null ? attrs as Record<string, unknown> : {};
}

export const agentRoutes = new Elysia({ name: "agents" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/agent-pools", async ({ params: { org_name: orgName }, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === null || org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pools = await db.query.agentPools.findMany({ where: eq(agentPools.orgId, org.id) });
    const poolData = await Promise.all(pools.map(async p => { const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, p.id) }); return { id: p.id, type: "agent-pools", attributes: { name: p.name, "organization-scoped": p.organizationScoped, "agent-count": agentList.length } }; }));
    return { data: poolData };
  })
  .post("/api/v2/organizations/:org_name/agent-pools", async ({ params: { org_name: orgName }, body, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === null || org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const name = typeof attrs.name === "string" ? attrs.name : "";
    if (name === "") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `apool-${crypto.randomUUID()}`;
    const orgScoped = attrs["organization-scoped"] === true;
    await db.insert(agentPools).values({ id, orgId: org.id, name, organizationScoped: orgScoped, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "agent-pools", attributes: { name, "organization-scoped": orgScoped, "agent-count": 0 } } };
  })
  .get("/api/v2/agent-pools/:pool_id", async ({ params: { pool_id: poolId }, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === null || pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, poolId) });
    return { data: { id: pool.id, type: "agent-pools", attributes: { name: pool.name, "organization-scoped": pool.organizationScoped, "agent-count": agentList.length } } };
  })
  .patch("/api/v2/agent-pools/:pool_id", async ({ params: { pool_id: poolId }, body, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === null || pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const updates: Partial<typeof agentPools.$inferInsert> = {};
    if (typeof attrs.name === "string") updates.name = attrs.name;
    if (typeof attrs["organization-scoped"] === "boolean") updates.organizationScoped = attrs["organization-scoped"];
    if (Object.keys(updates).length > 0) await db.update(agentPools).set(updates).where(eq(agentPools.id, poolId));
    const updated = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, poolId) });
    return { data: { id: updated?.id ?? "", type: "agent-pools", attributes: { name: updated?.name ?? "", "organization-scoped": updated?.organizationScoped, "agent-count": agentList.length } } };
  })
  .delete("/api/v2/agent-pools/:pool_id", async ({ params: { pool_id: poolId }, user, orgId: tokenOrgId, set }): Promise<Record<string, never> | undefined> => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === null || pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(agentPools).where(eq(agentPools.id, poolId));
    set.status = 204;
    return undefined;
  })
  // --- Agents ---
  .get("/api/v2/agent-pools/:pool_id/agents", async ({ params: { pool_id: poolId }, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === null || pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, poolId) });
    return { data: agentList.map(a => ({ id: a.id, type: "agents", attributes: { name: a.name, status: a.status, "ip-address": a.ipAddress, version: a.version, architecture: a.architecture, "last-ping-at": a.lastPingAt !== null ? new Date(a.lastPingAt).toISOString() : null }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } })) };
  })
  .post("/api/v2/agent-pools/:pool_id/agents", async ({ params: { pool_id: poolId }, body, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === null || pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const name = typeof attrs.name === "string" ? attrs.name : "";
    if (name === "") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const agentId = `agent-${crypto.randomUUID()}`;
    const now = Date.now();
    await db.insert(agents).values({ id: agentId, agentPoolId: pool.id, name, status: (attrs.status as string) ?? "idle", ipAddress: (attrs["ip-address"] as string | null) ?? null, version: (attrs.version as string | null) ?? null, architecture: (attrs.architecture as string | null) ?? null, lastPingAt: now, createdAt: now });
    set.status = 201;
    return { data: { id: agentId, type: "agents", attributes: { name, status: (attrs.status as string) ?? "idle", "ip-address": (attrs["ip-address"] as string | null) ?? null, version: (attrs.version as string | null) ?? null, architecture: (attrs.architecture as string | null) ?? null, "last-ping-at": new Date(now).toISOString() }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } } };
  })
  .get("/api/v2/agents/:agent_id", async ({ params: { agent_id: agentId }, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (agent === null || agent === undefined) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, agent.agentPoolId) });
    if (pool === null || pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: agent.id, type: "agents", attributes: { name: agent.name, status: agent.status, "ip-address": agent.ipAddress, version: agent.version, architecture: agent.architecture, "last-ping-at": agent.lastPingAt !== null ? new Date(agent.lastPingAt).toISOString() : null }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } } };
  })
  .delete("/api/v2/agents/:agent_id", async ({ params: { agent_id: agentId }, user, orgId: tokenOrgId, set }): Promise<Record<string, never> | undefined> => {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (agent === null || agent === undefined) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, agent.agentPoolId) });
    if (pool === null || pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(agents).where(eq(agents.id, agentId));
    set.status = 204;
    return undefined;
  })
  // --- Agent Pool Tokens ---
  .get("/api/v2/agent-pools/:pool_id/authentication-tokens", async ({ params: { pool_id: poolId }, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === null || pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tokenList = await db.query.agentPoolTokens.findMany({ where: eq(agentPoolTokens.agentPoolId, poolId) });
    return { data: tokenList.map(t => ({ id: t.id, type: "authentication-tokens", attributes: { description: t.description, "created-at": new Date(t.createdAt).toISOString(), "last-used-at": t.lastUsedAt !== null ? new Date(t.lastUsedAt).toISOString() : null } })) };
  })
  .post("/api/v2/agent-pools/:pool_id/authentication-tokens", async ({ params: { pool_id: poolId }, body, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === null || pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const description = (attrs.description as string) ?? `Agent token for ${pool.name}`;
    const rawToken = `agent-${crypto.randomUUID().replace(/-/g, "")}`;
    const tokenId = `atok-${crypto.randomUUID()}`;
    const { createHash } = await import("node:crypto");
    await db.insert(agentPoolTokens).values({ id: tokenId, agentPoolId: poolId, token: createHash("sha256").update(rawToken).digest("hex"), description, createdAt: Date.now() });
    set.status = 201;
    return { data: { id: tokenId, type: "authentication-tokens", attributes: { token: rawToken, description, "created-at": new Date().toISOString() } } };
  });
