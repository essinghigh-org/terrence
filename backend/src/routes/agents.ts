import { Elysia } from "elysia";
import { db } from "../db";
import {
  agentPoolAllowedProjects,
  agentPoolAllowedWorkspaces,
  agentPools,
  agents,
  agentPoolTokens,
  configurationVersions,
  organizations,
  projects,
  workspaces,
  type users,
} from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { checkOrganizationPermission } from "../lib/utils";
import { createHash } from "node:crypto";
import { authPlugin } from "../auth";
import {
  appendAgentJobLog,
  authenticateAgent,
  claimAgentJob,
  completeAgentJob,
  findClaimedAgentJob,
  type AgentJobCompletion,
  type ClaimedAgentJob,
} from "../lib/agent-jobs";
import { refetchConfigurationVersion } from "../lib/webhooks";

function getAttrs(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const data = (body as Record<string, unknown>)["data"];
  if (typeof data !== "object" || data === null) return {};
  const attrs = (data as Record<string, unknown>)["attributes"];
  return typeof attrs === "object" && attrs !== null ? attrs as Record<string, unknown> : {};
}

type ScopeRelationship =
  | Readonly<{ value: Readonly<{ provided: boolean; ids: readonly string[] }> }>
  | Readonly<{ error: string }>;

function getRelationships(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const data = (body as Record<string, unknown>)["data"];
  if (typeof data !== "object" || data === null) return {};
  const relationships = (data as Record<string, unknown>)["relationships"];
  return typeof relationships === "object" && relationships !== null
    ? relationships as Record<string, unknown>
    : {};
}

function parseScopeRelationship(
  body: unknown,
  name: "allowed-workspaces" | "allowed-projects",
  type: "workspaces" | "projects",
): ScopeRelationship {
  const relationships = getRelationships(body);
  if (!Object.prototype.hasOwnProperty.call(relationships, name)) {
    return { value: { provided: false, ids: [] } };
  }
  const relationship = relationships[name];
  if (typeof relationship !== "object" || relationship === null) {
    return { error: `${name} relationship must contain a data array` };
  }
  const data = (relationship as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) {
    return { error: `${name} relationship must contain a data array` };
  }
  const ids = new Set<string>();
  for (const item of data) {
    if (typeof item !== "object" || item === null) {
      return { error: `${name} relationship contains an invalid resource identifier` };
    }
    const resource = item as Record<string, unknown>;
    if (resource["type"] !== type || typeof resource["id"] !== "string" || resource["id"] === "") {
      return { error: `${name} relationship must contain ${type} resource identifiers` };
    }
    ids.add(resource["id"]);
  }
  return { value: { provided: true, ids: [...ids] } };
}

type ScopeTarget = Readonly<{ id: string; orgId: string }>;

async function validateScopeTargets(
  orgId: string,
  workspaceIds: readonly string[],
  projectIds: readonly string[],
): Promise<string | undefined> {
  const [workspaceList, projectList] = await Promise.all([
    workspaceIds.length === 0
      ? Promise.resolve<ScopeTarget[]>([])
      : db.select({ id: workspaces.id, orgId: workspaces.orgId })
          .from(workspaces)
          .where(inArray(workspaces.id, [...workspaceIds])),
    projectIds.length === 0
      ? Promise.resolve<ScopeTarget[]>([])
      : db.select({ id: projects.id, orgId: projects.orgId })
          .from(projects)
          .where(inArray(projects.id, [...projectIds])),
  ]);
  if (workspaceList.length !== workspaceIds.length || workspaceList.some((workspace): boolean => workspace.orgId !== orgId)) {
    return "Allowed workspaces must belong to the agent pool organization";
  }
  if (projectList.length !== projectIds.length || projectList.some((project): boolean => project.orgId !== orgId)) {
    return "Allowed projects must belong to the agent pool organization";
  }
  return undefined;
}

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  teamId?: string | null;
  request: Readonly<{ headers: Readonly<{ get(name: string): string | null }> }>;
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
  readonly description: string | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}>;

type DeepReadonly<T> = T extends readonly (infer Value)[]
  ? readonly DeepReadonly<Value>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

function agentJobResource(details: DeepReadonly<ClaimedAgentJob>): Record<string, unknown> {
  const { job, run, workspace, configuration, inputState, planResult } = details;
  const basePath = `/api/v2/agents/${job.agentId ?? ""}/jobs/${job.id}`;
  return {
    id: job.id,
    type: "agent-jobs",
    attributes: {
      phase: job.phase,
      status: job.status,
      "claimed-at": job.claimedAt === null ? null : new Date(job.claimedAt).toISOString(),
      run: {
        id: run.id,
        message: run.message,
        "terraform-version": run.terraformVersion ?? workspace.terraformVersion,
        "is-destroy": run.isDestroy === true,
        "plan-only": run.planOnly,
        refresh: run.refresh,
        "refresh-only": run.refreshOnly,
        "target-addrs": run.targetAddrs ?? [],
        "replace-addrs": run.replaceAddrs ?? [],
        variables: run.variables ?? [],
      },
      workspace: {
        id: workspace.id,
        name: workspace.name,
        "organization-id": workspace.orgId,
        "working-directory": workspace.workingDirectory,
        "iac-binary": workspace.iacBinary,
      },
      configuration: configuration === null
        ? null
        : {
            id: configuration.id,
            status: configuration.status,
            "download-url": `${basePath}/configuration`,
          },
      "input-state": inputState === null
        ? null
        : {
            id: inputState.id,
            serial: inputState.serial,
            "download-url": `${basePath}/state`,
          },
      "plan-result": planResult,
    },
    relationships: {
      run: { data: { id: run.id, type: "runs" } },
      workspace: { data: { id: workspace.id, type: "workspaces" } },
      "configuration-version": {
        data: configuration === null
          ? null
          : { id: configuration.id, type: "configuration-versions" },
      },
      "agent-pool": { data: { id: job.agentPoolId, type: "agent-pools" } },
      agent: { data: { id: job.agentId, type: "agents" } },
    },
  };
}

function nonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function completionFromBody(body: unknown): AgentJobCompletion | undefined {
  const attrs = getAttrs(body);
  const status = attrs["status"];
  if (status !== "completed" && status !== "errored") return undefined;
  const resourceAdditions = nonNegativeInteger(attrs["resource-additions"]);
  const resourceChanges = nonNegativeInteger(attrs["resource-changes"]);
  const resourceDestructions = nonNegativeInteger(attrs["resource-destructions"]);
  if (resourceAdditions === undefined || resourceChanges === undefined || resourceDestructions === undefined) return undefined;
  const errorMessage = attrs["error-message"] === undefined || attrs["error-message"] === null
    ? null
    : typeof attrs["error-message"] === "string"
      ? attrs["error-message"]
      : undefined;
  const statePayload = attrs["state"] === undefined || attrs["state"] === null
    ? null
    : typeof attrs["state"] === "string"
      ? attrs["state"]
      : undefined;
  const jsonState = attrs["json-state"] === undefined || attrs["json-state"] === null
    ? null
    : typeof attrs["json-state"] === "string"
      ? attrs["json-state"]
      : undefined;
  const jsonStateOutputs = attrs["json-state-outputs"] === undefined || attrs["json-state-outputs"] === null
    ? null
    : typeof attrs["json-state-outputs"] === "string"
      ? attrs["json-state-outputs"]
      : undefined;
  if (
    errorMessage === undefined
    || statePayload === undefined
    || jsonState === undefined
    || jsonStateOutputs === undefined
  ) return undefined;
  for (const json of [statePayload, jsonState, jsonStateOutputs]) {
    if (json === null) continue;
    try {
      JSON.parse(json);
    } catch {
      return undefined;
    }
  }
  const result = typeof attrs["result"] === "object" && attrs["result"] !== null && !Array.isArray(attrs["result"])
    ? attrs["result"] as Record<string, unknown>
    : {};
  return {
    status,
    errorMessage,
    resourceAdditions,
    resourceChanges,
    resourceDestructions,
    statePayload,
    jsonState,
    jsonStateOutputs,
    result,
  };
}

async function canRegisterAgent(
  pool: Readonly<typeof agentPools.$inferSelect>,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  request: ParamCtx["request"],
): Promise<boolean> {
  if (await checkOrganizationPermission(pool.orgId, userId, tokenOrgId, tokenTeamId, "manage-agent-pools")) return true;
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer agent-") !== true) return false;
  const tokenHash = createHash("sha256").update(authorization.slice(7)).digest("hex");
  const token = await db.query.agentPoolTokens.findFirst({
    where: and(eq(agentPoolTokens.agentPoolId, pool.id), eq(agentPoolTokens.token, tokenHash)),
  });
  if (token === undefined) return false;
  await db.update(agentPoolTokens).set({ lastUsedAt: Date.now() }).where(eq(agentPoolTokens.id, token.id));
  return true;
}

async function agentPoolResource(
  pool: Readonly<typeof agentPools.$inferSelect>,
): Promise<Record<string, unknown>> {
  const [agentList, workspaceList, allowedWorkspaceList, allowedProjectList] = await Promise.all([
    db.query.agents.findMany({ where: eq(agents.agentPoolId, pool.id) }),
    db.query.workspaces.findMany({ where: eq(workspaces.agentPoolId, pool.id) }),
    db.query.agentPoolAllowedWorkspaces.findMany({
      where: eq(agentPoolAllowedWorkspaces.agentPoolId, pool.id),
    }),
    db.query.agentPoolAllowedProjects.findMany({
      where: eq(agentPoolAllowedProjects.agentPoolId, pool.id),
    }),
  ]);
  return {
    id: pool.id,
    type: "agent-pools",
    attributes: {
      name: pool.name,
      "created-at": new Date(pool.createdAt).toISOString(),
      "organization-scoped": pool.organizationScoped,
      "agent-count": agentList.length,
    },
    relationships: {
      agents: {
        links: { related: `/api/v2/agent-pools/${pool.id}/agents` },
      },
      "authentication-tokens": {
        links: { related: `/api/v2/agent-pools/${pool.id}/authentication-tokens` },
      },
      workspaces: {
        data: workspaceList
          .map((workspace: Readonly<{ readonly id: string }>): string => workspace.id)
          .sort()
          .map((id): Record<string, string> => ({ id, type: "workspaces" })),
      },
      "allowed-workspaces": {
        data: allowedWorkspaceList
          .map((relationship): string => relationship.workspaceId)
          .sort()
          .map((id): Record<string, string> => ({ id, type: "workspaces" })),
      },
      "allowed-projects": {
        data: allowedProjectList
          .map((relationship): string => relationship.projectId)
          .sort()
          .map((id): Record<string, string> => ({ id, type: "projects" })),
      },
    },
    links: { self: `/api/v2/agent-pools/${pool.id}` },
  };
}

export const agentRoutes = new Elysia({ name: "agents" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/agent-pools", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pools = await db.query.agentPools.findMany({ where: eq(agentPools.orgId, org.id) });
    const poolData = await Promise.all(pools.map(agentPoolResource));
    return { data: poolData };
  })
  .post("/api/v2/organizations/:org_name/agent-pools", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const name = typeof attrs["name"] === "string" ? attrs["name"] : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    if (attrs["organization-scoped"] !== undefined && typeof attrs["organization-scoped"] !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "organization-scoped must be a boolean" }] };
    }
    const allowedWorkspacesResult = parseScopeRelationship(body, "allowed-workspaces", "workspaces");
    if ("error" in allowedWorkspacesResult) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: allowedWorkspacesResult.error }] };
    }
    const allowedProjectsResult = parseScopeRelationship(body, "allowed-projects", "projects");
    if ("error" in allowedProjectsResult) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: allowedProjectsResult.error }] };
    }
    const allowedWorkspaces = allowedWorkspacesResult.value;
    const allowedProjects = allowedProjectsResult.value;
    const scopeError = await validateScopeTargets(org.id, allowedWorkspaces.ids, allowedProjects.ids);
    if (scopeError !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: scopeError }] };
    }
    const id = `apool-${crypto.randomUUID()}`;
    const orgScoped = attrs["organization-scoped"] !== false;
    await db.transaction(async (tx): Promise<void> => {
      await tx.insert(agentPools).values({ id, orgId: org.id, name, organizationScoped: orgScoped, createdAt: Date.now() });
      if (allowedWorkspaces.ids.length > 0) {
        await tx.insert(agentPoolAllowedWorkspaces).values(allowedWorkspaces.ids.map((workspaceId): typeof agentPoolAllowedWorkspaces.$inferInsert => ({
          id: `apws-${crypto.randomUUID()}`,
          agentPoolId: id,
          workspaceId,
        })));
      }
      if (allowedProjects.ids.length > 0) {
        await tx.insert(agentPoolAllowedProjects).values(allowedProjects.ids.map((projectId): typeof agentPoolAllowedProjects.$inferInsert => ({
          id: `apprj-${crypto.randomUUID()}`,
          agentPoolId: id,
          projectId,
        })));
      }
    });
    const created = await db.query.agentPools.findFirst({ where: eq(agentPools.id, id) });
    if (created === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    (set as { status: number }).status = 201;
    return { data: await agentPoolResource(created) };
  })
  .get("/api/v2/agent-pools/:pool_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await agentPoolResource(pool) };
  })
  .patch("/api/v2/agent-pools/:pool_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    if (attrs["organization-scoped"] !== undefined && typeof attrs["organization-scoped"] !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "organization-scoped must be a boolean" }] };
    }
    const allowedWorkspacesResult = parseScopeRelationship(body, "allowed-workspaces", "workspaces");
    if ("error" in allowedWorkspacesResult) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: allowedWorkspacesResult.error }] };
    }
    const allowedProjectsResult = parseScopeRelationship(body, "allowed-projects", "projects");
    if ("error" in allowedProjectsResult) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: allowedProjectsResult.error }] };
    }
    const allowedWorkspaces = allowedWorkspacesResult.value;
    const allowedProjects = allowedProjectsResult.value;
    const [existingAllowedWorkspaces, existingAllowedProjects, assignedWorkspaces, defaultProjects] = await Promise.all([
      db.query.agentPoolAllowedWorkspaces.findMany({
        where: eq(agentPoolAllowedWorkspaces.agentPoolId, poolId),
      }),
      db.query.agentPoolAllowedProjects.findMany({
        where: eq(agentPoolAllowedProjects.agentPoolId, poolId),
      }),
      db.query.workspaces.findMany({ where: eq(workspaces.agentPoolId, poolId) }),
      db.query.projects.findMany({ where: eq(projects.defaultAgentPoolId, poolId) }),
    ]);
    const allowedWorkspaceIds = allowedWorkspaces.provided
      ? allowedWorkspaces.ids
      : existingAllowedWorkspaces.map((relationship): string => relationship.workspaceId);
    const allowedProjectIds = allowedProjects.provided
      ? allowedProjects.ids
      : existingAllowedProjects.map((relationship): string => relationship.projectId);
    const scopeError = await validateScopeTargets(pool.orgId, allowedWorkspaceIds, allowedProjectIds);
    if (scopeError !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: scopeError }] };
    }
    const organizationScoped = typeof attrs["organization-scoped"] === "boolean"
      ? attrs["organization-scoped"]
      : pool.organizationScoped !== false;
    if (!organizationScoped) {
      const workspaceIds = new Set(allowedWorkspaceIds);
      const projectIds = new Set(allowedProjectIds);
      const hasDisallowedWorkspace = assignedWorkspaces.some((workspace): boolean =>
        !workspaceIds.has(workspace.id)
        && (workspace.projectId === null || !projectIds.has(workspace.projectId)));
      const hasDisallowedProjectDefault = defaultProjects.some((project): boolean => !projectIds.has(project.id));
      if (hasDisallowedWorkspace || hasDisallowedProjectDefault) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Agent pool scope must include its assigned workspaces and project defaults" }] };
      }
    }
    const updates: Partial<typeof agentPools.$inferInsert> = {};
    if (typeof attrs["name"] === "string") updates.name = attrs["name"];
    if (typeof attrs["organization-scoped"] === "boolean") updates.organizationScoped = attrs["organization-scoped"];
    await db.transaction(async (tx): Promise<void> => {
      if (Object.keys(updates).length > 0) await tx.update(agentPools).set(updates).where(eq(agentPools.id, poolId));
      if (allowedWorkspaces.provided) {
        await tx.delete(agentPoolAllowedWorkspaces).where(eq(agentPoolAllowedWorkspaces.agentPoolId, poolId));
        if (allowedWorkspaces.ids.length > 0) {
          await tx.insert(agentPoolAllowedWorkspaces).values(allowedWorkspaces.ids.map((workspaceId): typeof agentPoolAllowedWorkspaces.$inferInsert => ({
            id: `apws-${crypto.randomUUID()}`,
            agentPoolId: poolId,
            workspaceId,
          })));
        }
      }
      if (allowedProjects.provided) {
        await tx.delete(agentPoolAllowedProjects).where(eq(agentPoolAllowedProjects.agentPoolId, poolId));
        if (allowedProjects.ids.length > 0) {
          await tx.insert(agentPoolAllowedProjects).values(allowedProjects.ids.map((projectId): typeof agentPoolAllowedProjects.$inferInsert => ({
            id: `apprj-${crypto.randomUUID()}`,
            agentPoolId: poolId,
            projectId,
          })));
        }
      }
    });
    const updated = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await agentPoolResource(updated) };
  })
  .delete("/api/v2/agent-pools/:pool_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(agentPools).where(eq(agentPools.id, poolId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Agents ---
  .get("/api/v2/agent-pools/:pool_id/agents", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const agentList = await db.query.agents.findMany({ where: eq(agents.agentPoolId, poolId) });
    return { data: agentList.map((a: AgentItem): Record<string, unknown> => ({ id: a.id, type: "agents", attributes: { name: a.name, status: a.status, "ip-address": a.ipAddress, version: a.version, architecture: a.architecture, "last-ping-at": a.lastPingAt !== null ? new Date(a.lastPingAt).toISOString() : null }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } })) };
  })
  .post("/api/v2/agent-pools/:pool_id/agents", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, request, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await canRegisterAgent(pool, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, request))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const name = typeof attrs["name"] === "string" ? attrs["name"] : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const agentId = `agent-${crypto.randomUUID()}`;
    const now = Date.now();
    const status = typeof attrs["status"] === "string" ? attrs["status"] : "idle";
    const ipAddress = typeof attrs["ip-address"] === "string" ? attrs["ip-address"] : null;
    const version = typeof attrs["version"] === "string" ? attrs["version"] : null;
    const architecture = typeof attrs["architecture"] === "string" ? attrs["architecture"] : null;
    await db.insert(agents).values({ id: agentId, agentPoolId: pool.id, name, status, ipAddress, version, architecture, lastPingAt: now, createdAt: now });
    (set as { status: number }).status = 201;
    return { data: { id: agentId, type: "agents", attributes: { name, status, "ip-address": ipAddress, version, architecture, "last-ping-at": new Date(now).toISOString() }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } } };
  })
  .get("/api/v2/agents/:agent_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const agentId = params["agent_id"] ?? "";
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (agent === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, agent.agentPoolId) });
    if (pool === undefined || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: agent.id, type: "agents", attributes: { name: agent.name, status: agent.status, "ip-address": agent.ipAddress, version: agent.version, architecture: agent.architecture, "last-ping-at": agent.lastPingAt !== null ? new Date(agent.lastPingAt).toISOString() : null }, relationships: { "agent-pool": { data: { id: pool.id, type: "agent-pools" } } } } };
  })
  .delete("/api/v2/agents/:agent_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const agentId = params["agent_id"] ?? "";
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (agent === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, agent.agentPoolId) });
    if (pool === undefined || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(agents).where(eq(agents.id, agentId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Agent execution protocol ---
  .post("/api/v2/agents/:agent_id/jobs/poll", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const agentId = params["agent_id"] ?? "";
    const agent = await authenticateAgent(agentId, request.headers.get("authorization"));
    if (agent === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const job = await claimAgentJob(agent);
    if (job === undefined) {
      (set as { status: number }).status = 204;
      return {};
    }
    return { data: agentJobResource(job) };
  })
  .post("/api/v2/agents/:agent_id/jobs/:job_id/logs", async ({ params, body, request, set }: ParamCtx): Promise<unknown> => {
    const agentId = params["agent_id"] ?? "";
    const jobId = params["job_id"] ?? "";
    const agent = await authenticateAgent(agentId, request.headers.get("authorization"));
    if (agent === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const attrs = getAttrs(body);
    const outputText = typeof attrs["output-text"] === "string" ? attrs["output-text"] : "";
    if (outputText === "" || outputText.length > 1_048_576) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "output-text must contain between 1 and 1048576 characters" }] };
    }
    if (!(await appendAgentJobLog(agent.id, jobId, outputText))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    (set as { status: number }).status = 201;
    return {
      data: {
        id: `log-${crypto.randomUUID()}`,
        type: "agent-job-logs",
        attributes: { "output-text": outputText },
      },
    };
  })
  .post("/api/v2/agents/:agent_id/jobs/:job_id/complete", async ({ params, body, request, set }: ParamCtx): Promise<unknown> => {
    const agentId = params["agent_id"] ?? "";
    const jobId = params["job_id"] ?? "";
    const agent = await authenticateAgent(agentId, request.headers.get("authorization"));
    if (agent === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const completion = completionFromBody(body);
    if (completion === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid agent job result" }] };
    }
    const completed = await completeAgentJob(agent.id, jobId, completion);
    if (completed === undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Agent job is not claimed by this agent" }] };
    }
    return {
      data: {
        id: completed.job.id,
        type: "agent-jobs",
        attributes: {
          status: completed.job.status,
          "run-status": completed.runStatus,
          "completed-at": completed.job.completedAt === null
            ? null
            : new Date(completed.job.completedAt).toISOString(),
        },
        relationships: {
          run: { data: { id: completed.job.runId, type: "runs" } },
          agent: { data: { id: agent.id, type: "agents" } },
        },
      },
    };
  })
  .get("/api/v2/agents/:agent_id/jobs/:job_id/configuration", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const agentId = params["agent_id"] ?? "";
    const jobId = params["job_id"] ?? "";
    const agent = await authenticateAgent(agentId, request.headers.get("authorization"));
    if (agent === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const job = await findClaimedAgentJob(agent.id, jobId);
    if (job?.configuration === null || job === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    let configuration = job.configuration;
    if (
      configuration.archivePath === null
      || ["backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(configuration.status)
      || !(await Bun.file(configuration.archivePath).exists())
    ) {
      if (!(await refetchConfigurationVersion(configuration.id))) {
        (set as { status: number }).status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
      }
      const refreshed = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, configuration.id),
      });
      if (refreshed === undefined) {
        (set as { status: number }).status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
      }
      configuration = refreshed;
    }
    if (
      configuration.archivePath === null
      || ["backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(configuration.status)
      || !(await Bun.file(configuration.archivePath).exists())
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    (set.headers as Record<string, string>)["Content-Type"] = "application/gzip";
    return Bun.file(configuration.archivePath);
  })
  .get("/api/v2/agents/:agent_id/jobs/:job_id/state", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const agentId = params["agent_id"] ?? "";
    const jobId = params["job_id"] ?? "";
    const agent = await authenticateAgent(agentId, request.headers.get("authorization"));
    if (agent === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const job = await findClaimedAgentJob(agent.id, jobId);
    if (job?.inputState?.statePayload === null || job?.inputState?.statePayload === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    (set.headers as Record<string, string>)["Content-Type"] = "application/json";
    return job.inputState.statePayload;
  })
  // --- Agent Pool Tokens ---
  .get("/api/v2/agent-pools/:pool_id/authentication-tokens", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tokenList = await db.query.agentPoolTokens.findMany({ where: eq(agentPoolTokens.agentPoolId, poolId) });
    return { data: tokenList.map((t: TokenItem): Record<string, unknown> => ({ id: t.id, type: "authentication-tokens", attributes: { description: t.description, "created-at": new Date(t.createdAt).toISOString(), "last-used-at": t.lastUsedAt !== null ? new Date(t.lastUsedAt).toISOString() : null } })) };
  })
  .post("/api/v2/agent-pools/:pool_id/authentication-tokens", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const poolId = params["pool_id"] ?? "";
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, poolId) });
    if (pool === undefined || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId ?? null, tokenTeamId ?? null, "manage-agent-pools"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const description = typeof attrs["description"] === "string" ? attrs["description"] : `Agent token for ${pool.name}`;
    const rawToken = `agent-${crypto.randomUUID().replace(/-/g, "")}`;
    const tokenId = `atok-${crypto.randomUUID()}`;
    await db.insert(agentPoolTokens).values({ id: tokenId, agentPoolId: poolId, token: createHash("sha256").update(rawToken).digest("hex"), description, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id: tokenId, type: "authentication-tokens", attributes: { token: rawToken, description, "created-at": new Date().toISOString() } } };
  });
