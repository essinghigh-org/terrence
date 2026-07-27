import { Elysia } from "elysia";
import { db } from "../db";
import { agentPools, agents, agentPoolTokens, organizations, type users } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrgPermission } from "../lib/utils";
import { createHash } from "node:crypto";
import { authPlugin } from "../auth";

function getAttrs(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const data = (body as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return {};
  const attrs = (data as Record<string, unknown>).attributes;
  return typeof attrs === "object" && attrs !== null ? attrs as Record<string, unknown> : {};
}

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  set: SetObj;
}>;

type AgentItem = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly ipAddress: string | null;
  readonly version: string | null;
  readonly architecture: string | null;
  readonly lastPingAt: number | null;
}>;

type TokenItem = Readonly<{
  readonly id: string;
  readonly description: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}>;

export const agentRoutes = new Elysia({ name: "agents" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/agent-pools", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pools = await db.query.agentPools.findMany({ where: eq(agentPools.orgId, org.id) });
    const poolData = await Promise.all(pools.map(async (p: Readonly<typeof agentPools.$inferSelect>): Promise<Record<string, unknown>> => { const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, p.id) }); return { id: p.id, type: "agent-pools", attributes: { name: p.name, "organization-scoped": p.organizationScoped, "agent-count": agentList.length } }; }));
    return { data: poolData };
  })
  .post("/api/v2/organizations/:org_name/agent-pools", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const name = typeof attrs.name === "string" ? attrs.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `apool-${crypto.randomUUID()}`;
    const orgScoped = attrs["organization-scoped"] === true;
    await db.insert(agentPools).values({ id, orgId: org.id, name, organizationScoped: orgScoped, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "agent-pools", attributes: { name, "organization-scoped": orgScoped, "agent-count": 0 } } };
  })
  .get("/api/v2/agent-pools/:pool_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, poolId) });
    return { data: { id: pool.id, type: "agent-pools", attributes: { name: pool.name, "organization-scoped": pool.organizationScoped, "agent-count": agentList.length } } };
  })
  .patch("/api/v2/agent-pools/:pool_id", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const updates: Partial<typeof agentPools.$inferInsert> = {};
    if (typeof attrs.name === "string") updates.name = attrs.name;
    if (typeof attrs["organization-scoped"] === "boolean") updates.organizationScoped = attrs["organization-scoped"];
    if (Object.keys(updates).length > 0) await db.update(agentPools).set(updates).where(eq(agentPools.id, poolId));
    const updated = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, poolId) });
    return { data: { id: updated.id, type: "agent-pools", attributes: { name: updated.name, "organization-scoped": updated.organizationScoped, "agent-count": agentList.length } } };
  })
  .delete("/api/v2/agent-pools/:pool_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(agentPools).where(eq(agentPools.id, poolId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Agents ---
  .get("/api/v2/agent-pools/:pool_id/agents", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, poolId) });
    return { data: agentList.map((a: AgentItem): Record<string, unknown> => ({ id: a.id, type: "agents", attributes: { name: a.name, status: a.status, "ip-address": a.ipAddress, version: a.version, architecture: a.architecture, "last-ping-at": a.lastPingAt !== null ? new Date(a.lastPingAt).toISOString() : null }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } })) };
  })
  .post("/api/v2/agent-pools/:pool_id/agents", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const name = typeof attrs.name === "string" ? attrs.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const agentId = `agent-${crypto.randomUUID()}`;
    const now = Date.now();
    const status = typeof attrs.status === "string" ? attrs.status : "idle";
    const ipAddress = typeof attrs["ip-address"] === "string" ? attrs["ip-address"] : null;
    const version = typeof attrs.version === "string" ? attrs.version : null;
    const architecture = typeof attrs.architecture === "string" ? attrs.architecture : null;
    await db.insert(agents).values({ id: agentId, agentPoolId: pool.id, name, status, ipAddress, version, architecture, lastPingAt: now, createdAt: now });
    (set as { status: number }).status = 201;
    return { data: { id: agentId, type: "agents", attributes: { name, status, "ip-address": ipAddress, version, architecture, "last-ping-at": new Date(now).toISOString() }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } } };
  })
  .get("/api/v2/agents/:agent_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const agentId = params["agent_id"] ?? "";
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (agent === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, agent.agentPoolId) });
    if (pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: agent.id, type: "agents", attributes: { name: agent.name, status: agent.status, "ip-address": agent.ipAddress, version: agent.version, architecture: agent.architecture, "last-ping-at": agent.lastPingAt !== null ? new Date(agent.lastPingAt).toISOString() : null }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } } };
  })
  .delete("/api/v2/agents/:agent_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const agentId = params["agent_id"] ?? "";
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (agent === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, agent.agentPoolId) });
    if (pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(agents).where(eq(agents.id, agentId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Agent Pool Tokens ---
  .get("/api/v2/agent-pools/:pool_id/authentication-tokens", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tokenList = await db.query.agentPoolTokens.findMany({ where: eq(agentPoolTokens.agentPoolId, poolId) });
    return { data: tokenList.map((t: TokenItem): Record<string, unknown> => ({ id: t.id, type: "authentication-tokens", attributes: { description: t.description, "created-at": new Date(t.createdAt).toISOString(), "last-used-at": t.lastUsedAt !== null ? new Date(t.lastUsedAt).toISOString() : null } })) };
  })
  .post("/api/v2/agent-pools/:pool_id/authentication-tokens", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const description = typeof attrs.description === "string" ? attrs.description : `Agent token for ${pool.name}`;
    const rawToken = `agent-${crypto.randomUUID().replace(/-/g, "")}`;
    const tokenId = `atok-${crypto.randomUUID()}`;
    await db.insert(agentPoolTokens).values({ id: tokenId, agentPoolId: poolId, token: createHash("sha256").update(rawToken).digest("hex"), description, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id: tokenId, type: "authentication-tokens", attributes: { token: rawToken, description, "created-at": new Date().toISOString() } } };
  });
