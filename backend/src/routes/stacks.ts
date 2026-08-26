import { Elysia } from "elysia";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { agentPools, durableJobs, githubAppInstallations, oauthClients, oauthTokens, organizations, projects, stackAgentJobs, stackRecords, stackStateLocks, stacks } from "../db/schema";
import { checkOrganizationPermission, pageRequest, pagination, signedApiURL, validSignedApiURL, type DeepReadonly } from "../lib/utils";
import { isValidTagsRegex } from "../lib/vcs-repo";
import { cachedOrgByName } from "../lib/cached-lookups";
import { enqueueDurableJob } from "../lib/durable-jobs";
import { isStackStoragePath } from "../lib/stack-worker";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: DeepReadonly<typeof import("../db/schema").users.$inferSelect> | null;
  readonly orgId?: string | null;
  readonly teamId?: string | null;
  readonly request: Readonly<{ readonly url: string; readonly headers: Readonly<{ get(name: string): string | null }>; readonly arrayBuffer: () => Promise<ArrayBuffer> }>;
  readonly set: SetObj;
}>;

type StackItem = Readonly<typeof stacks.$inferSelect>;
type StackRecordItem = Readonly<typeof stackRecords.$inferSelect>;

function recordFencingToken(record: StackRecordItem): number | undefined {
  const value = (record.payload ?? {})["fencing-token"] ?? (record.payload ?? {}).fencingToken;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

const STACK_STORAGE_DIR = join(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "stacks");

function stackResource(stack: StackItem, _projectName: string | null): Record<string, unknown> {
  const vcsRepo: Record<string, unknown> = {};
  if (stack.vcsIdentifier !== null || stack.vcsServiceProvider !== null || stack.vcsRepositoryHttpUrl !== null) {
    vcsRepo.identifier = stack.vcsIdentifier;
    vcsRepo.branch = stack.vcsBranch ?? "";
    vcsRepo["tags-regex"] = stack.vcsTagsRegex;
    vcsRepo["sparse-checkout-pattern"] = stack.vcsSparseCheckoutPattern ?? "";
    vcsRepo["display-identifier"] = stack.vcsDisplayIdentifier ?? stack.vcsIdentifier;
    vcsRepo["repository-http-url"] = stack.vcsRepositoryHttpUrl;
    vcsRepo["service-provider"] = stack.vcsServiceProvider;
    vcsRepo["trigger-disabled"] = stack.triggerDisabled;
    if (stack.vcsOAuthTokenId !== null) vcsRepo["oauth-token-id"] = stack.vcsOAuthTokenId;
    if (stack.vcsGhaInstallationId !== null) vcsRepo["github-app-installation-id"] = stack.vcsGhaInstallationId;
  }
  const relationships: Record<string, unknown> = {};
  if (stack.projectId !== null) {
    relationships.project = { data: { id: stack.projectId, type: "projects" } };
  }
  relationships["agent-pool"] = { data: stack.agentPoolId === null ? null : { id: stack.agentPoolId, type: "agent-pools" } };
  relationships["stack-configurations"] = { links: { related: `/api/v2/stacks/${stack.id}/stack-configurations` } };
  relationships["stack-configuration-summaries"] = { links: { related: `/api/v2/stacks/${stack.id}/stack-configuration-summaries` } };
  relationships["stack-deployments"] = { links: { related: `/api/v2/stacks/${stack.id}/stack-deployments` } };
  relationships["stack-states"] = { links: { related: `/api/v2/stacks/${stack.id}/stack-states` } };
  return {
    id: stack.id,
    type: "stacks",
    attributes: {
      name: stack.name,
      description: stack.description ?? "",
      "speculative-enabled": stack.speculativeEnabled,
      "trigger-disabled": stack.triggerDisabled,
      "debugging-mode": stack.debuggingMode,
      "execution-mode": stack.executionMode,
      "working-directory": stack.workingDirectory,
      "trigger-patterns": Array.isArray(stack.triggerPatterns) ? stack.triggerPatterns : [],
      "linked-stack-connections": { "upstream-count": 0, "downstream-count": 0, "inputs-count": 0, "outputs-count": 0 },
      "created-at": new Date(stack.createdAt).toISOString(),
      "updated-at": new Date(stack.updatedAt).toISOString(),
      ...(Object.keys(vcsRepo).length > 0 ? { "vcs-repo": vcsRepo } : {}),
    },
    relationships,
  };
}

type StackVcsAttributes = Readonly<{
  vcsIdentifier: string | null;
  vcsServiceProvider: string | null;
  vcsBranch: string | null;
  vcsTagsRegex: string | null;
  vcsDisplayIdentifier: string | null;
  vcsRepositoryHttpUrl: string | null;
  vcsSparseCheckoutPattern: string | null;
  vcsOAuthTokenId: string | null;
  vcsGhaInstallationId: string | null;
  triggerDisabled: boolean;
}>;

function stackVcsRepoAttributes(attributes: Record<string, unknown>): StackVcsAttributes {
  const vcs = attributes["vcs-repo"];
  if (vcs === null || typeof vcs !== "object" || Array.isArray(vcs)) {
    return {
      vcsIdentifier: null, vcsServiceProvider: null, vcsBranch: null, vcsTagsRegex: null,
      vcsDisplayIdentifier: null, vcsRepositoryHttpUrl: null, vcsSparseCheckoutPattern: null,
      vcsOAuthTokenId: null, vcsGhaInstallationId: null, triggerDisabled: attributes["trigger-disabled"] === true,
    };
  }
  const repo = vcs as Record<string, unknown>;
  const identifier = typeof repo.identifier === "string" ? repo.identifier.trim() : "";
  const branch = typeof repo.branch === "string" ? repo.branch : "";
  const serviceProvider = typeof repo["service-provider"] === "string"
    ? repo["service-provider"]
    : typeof attributes["service-provider"] === "string" ? attributes["service-provider"] : "";
  const tagsRegex = typeof repo["tags-regex"] === "string" ? repo["tags-regex"] : "";
  const displayIdentifier = typeof repo["display-identifier"] === "string" ? repo["display-identifier"] : "";
  const repositoryHttpUrl = typeof repo["repository-http-url"] === "string" ? repo["repository-http-url"] : "";
  const sparseCheckoutPattern = typeof repo["sparse-checkout-pattern"] === "string" ? repo["sparse-checkout-pattern"] : "";
  const oauthTokenId = typeof repo["oauth-token-id"] === "string" ? repo["oauth-token-id"] : "";
  const ghaId = typeof repo["github-app-installation-id"] === "string" ? repo["github-app-installation-id"] : "";
  return {
    vcsIdentifier: identifier === "" ? null : identifier,
    vcsServiceProvider: serviceProvider === "" ? null : serviceProvider,
    vcsBranch: branch === "" ? null : branch,
    vcsTagsRegex: tagsRegex === "" ? null : tagsRegex,
    vcsDisplayIdentifier: displayIdentifier === "" ? null : displayIdentifier,
    vcsRepositoryHttpUrl: repositoryHttpUrl === "" ? null : repositoryHttpUrl,
    vcsSparseCheckoutPattern: sparseCheckoutPattern === "" ? null : sparseCheckoutPattern,
    vcsOAuthTokenId: oauthTokenId === "" ? null : oauthTokenId,
    vcsGhaInstallationId: ghaId === "" ? null : ghaId,
    triggerDisabled: repo["trigger-disabled"] === true || attributes["trigger-disabled"] === true,
  };
}

const stackServiceProviders = new Set(["github", "github_enterprise", "gitlab_hosted", "gitlab_community_edition", "gitlab_enterprise_edition", "ado_server"]);

async function validStackVcs(vcs: StackVcsAttributes, orgId: string): Promise<string | null> {
  if (vcs.vcsServiceProvider !== null && !stackServiceProviders.has(vcs.vcsServiceProvider)) return "Invalid Stack VCS service provider";
  if (vcs.vcsRepositoryHttpUrl !== null) {
    try {
      const protocol = new URL(vcs.vcsRepositoryHttpUrl).protocol;
      if (protocol !== "http:" && protocol !== "https:") return "Invalid Stack repository-http-url";
    } catch {
      return "Invalid Stack repository-http-url";
    }
  }
  if (vcs.vcsTagsRegex !== null) {
    if (!isValidTagsRegex(vcs.vcsTagsRegex)) return "Invalid Stack VCS tags-regex";
  }
  if (vcs.vcsOAuthTokenId !== null && vcs.vcsGhaInstallationId !== null) return "oauth-token-id and github-app-installation-id are mutually exclusive";
  if (vcs.vcsOAuthTokenId !== null) {
    const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, vcs.vcsOAuthTokenId) });
    const client = token === undefined
      ? undefined
      : await db.query.oauthClients.findFirst({ where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, orgId)) });
    if (client === undefined) return "OAuth token is not registered in this organization";
  }
  if (vcs.vcsGhaInstallationId !== null) {
    const installation = await db.query.githubAppInstallations.findFirst({ where: and(eq(githubAppInstallations.id, vcs.vcsGhaInstallationId), eq(githubAppInstallations.orgId, orgId)) });
    if (installation === undefined) return "GitHub App installation is not registered in this organization";
  }
  return null;
}

async function enqueueStackConfiguration(configuration: StackRecordItem): Promise<void> {
  await enqueueDurableJob("stack-configuration", { configurationId: configuration.id }, { dedupeKey: configuration.id });
}

async function stackDetails(stackId: string): Promise<{ stack: StackItem; orgName: string; projectName: string | null } | undefined> {
  const stack = await db.query.stacks.findFirst({ where: eq(stacks.id, stackId) });
  if (stack === undefined) return undefined;
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, stack.orgId) });
  const projectName = stack.projectId === null
    ? null
    : (await db.query.projects.findFirst({ where: eq(projects.id, stack.projectId) }))?.name ?? null;
  return { stack, orgName: org?.name ?? stack.orgId, projectName };
}

function recordDate(value: unknown): string | null {
  return typeof value === "number" ? new Date(value).toISOString() : null;
}

function stackRecordResource(record: StackRecordItem): Record<string, unknown> {
  const payload = record.payload ?? {};
  const approval = typeof payload.approvalId === "string" ? { id: payload.approvalId, type: "stack-approvals" } : null;
  const timestamps = {
    "created-at": recordDate(record.createdAt),
    "updated-at": recordDate(record.updatedAt),
  };
  if (record.recordType === "stack-configurations") {
    return {
      id: record.id,
      type: record.recordType,
      attributes: {
        status: record.status,
        "sequence-number": payload["sequence-number"] ?? 1,
        ...timestamps,
        speculative: payload.speculative === true,
        components: Array.isArray(payload.components) ? payload.components : [],
        deployments: Array.isArray(payload.deployments) ? payload.deployments : [],
      },
      relationships: {
        stack: { data: { id: record.stackId, type: "stacks" } },
        "stack-diagnostics": { links: { related: `/api/v2/stack-configurations/${record.id}/stack-diagnostics` } },
        "stack-deployment-groups": { links: { related: `/api/v2/stack-configurations/${record.id}/stack-deployment-groups` } },
      },
      links: { self: `/api/v2/stack-configurations/${record.id}`, "json-schemas": `/api/v2/stack-configurations/${record.id}/json-schemas` },
      meta: { beta: false },
    };
  }
  if (record.recordType === "stack-deployment-groups") {
    return {
      id: record.id,
      type: record.recordType,
      attributes: { status: record.status, ...timestamps, name: record.name, "deployment-group-config": payload["deployment-group-config"] ?? { "auto-approve-checks": [] } },
      relationships: {
        "stack-configuration": { data: record.parentId === null ? null : { id: record.parentId, type: "stack-configurations" } },
        "stack-approvals": { data: approval === null ? [] : [approval] },
        "stack-deployment-runs": { links: { related: `/api/v2/stack-deployment-groups/${record.id}/stack-deployment-runs` } },
      },
      links: { self: `/api/v2/stack-deployment-groups/${record.id}`, "stack-deployment-group-summaries": record.parentId === null ? null : `/api/v2/stack-configurations/${record.parentId}/stack-deployment-group-summaries` },
    };
  }
  if (record.recordType === "stack-deployment-runs") {
    return {
      id: record.id,
      type: record.recordType,
      attributes: { status: record.status, deployment: record.name, ...timestamps, "plan-mode": payload["plan-mode"] ?? "normal", component: payload.component ?? null, "component-index": payload.componentIndex ?? 0, cycle: payload.cycle ?? 0, destroy: payload.destroy === true, "lock-acquired": payload.lockAcquired === true, error: payload.error ?? null },
      relationships: {
        "stack-deployment-group": { data: record.parentId === null ? null : { id: record.parentId, type: "stack-deployment-groups" } },
        "stack-configuration": { data: typeof payload.configurationId === "string" ? { id: payload.configurationId, type: "stack-configurations" } : null },
        "stack-deployment-steps": { links: { related: `/api/v2/stack-deployment-runs/${record.id}/stack-deployment-steps` } },
        "stack-approval": { data: approval },
      },
      links: { self: `/api/v2/stack-deployment-runs/${record.id}` },
    };
  }
  if (record.recordType === "stack-deployment-steps") {
    return {
      id: record.id,
      type: record.recordType,
      attributes: { status: record.status, "operation-type": payload["operation-type"] ?? "plan", phase: payload.phase ?? null, "component-index": payload.componentIndex ?? 0, "requires-state-lock": payload["requires-state-lock"] === true, "has-changes": payload["has-changes"] === true || payload.hasChanges === true, "deferred-changes": payload["deferred-changes"] === true || payload.deferredChanges === true, output: payload.output ?? null, ...timestamps },
      relationships: {
        "stack-deployment-run": { data: record.parentId === null ? null : { id: record.parentId, type: "stack-deployment-runs" } },
        "stack-diagnostics": { links: { related: `/api/v2/stack-deployment-steps/${record.id}/stack-diagnostics` }, meta: { count: 0 } },
        "stack-approval": { data: approval },
      },
      links: { self: `/api/v2/stack-deployment-steps/${record.id}`, "plan-description": `/api/v2/stack-deployment-steps/${record.id}/artifacts?name=plan-description` },
    };
  }
  if (record.recordType === "stack-states") {
    return {
      id: record.id,
      type: record.recordType,
      attributes: {
        generation: payload.generation ?? 1,
        status: record.status,
        deployment: record.name,
        components: Array.isArray(payload.components) ? payload.components : [],
        "is-current": payload["is-current"] !== false,
        "resource-instance-count": payload["resource-instance-count"] ?? 0,
      },
      relationships: { stack: { data: { id: record.stackId, type: "stacks" } }, "stack-deployment-run": { data: typeof payload.runId === "string" ? { id: payload.runId, type: "stack-deployment-runs" } : null } },
      links: { self: `/api/v2/stack-states/${record.id}`, description: `/api/v2/stack-states/${record.id}/description` },
    };
  }
  if (record.recordType === "stack-diagnostics") {
    return {
      id: record.id,
      type: record.recordType,
      attributes: { severity: payload.severity ?? "error", summary: payload.summary ?? "", detail: payload.detail ?? "", diags: payload.diags ?? null, acknowledged: payload.acknowledged === true, "acknowledged-at": payload["acknowledged-at"] ?? null, "created-at": recordDate(record.createdAt) },
      relationships: { "stack-configuration": { data: record.parentId === null ? null : { id: record.parentId, type: "stack-configurations" } } },
      links: { self: `/api/v2/stack-diagnostics/${record.id}` },
    };
  }
  if (record.recordType === "stack-approvals") {
    return { id: record.id, type: record.recordType, attributes: { reason: payload.reason ?? null, "created-at": recordDate(record.createdAt) }, relationships: { user: { data: typeof payload.userId === "string" ? { id: payload.userId, type: "users" } : null } } };
  }
  return { id: record.id, type: record.recordType, attributes: { ...payload, ...timestamps } };
}

async function authorizedStackRecord(recordId: string, user: ParamCtx["user"], tokenOrgId: string | null | undefined, teamId: string | null | undefined, expectedType?: string): Promise<{ record: StackRecordItem; details: NonNullable<Awaited<ReturnType<typeof stackDetails>>> } | undefined> {
  const record = await db.query.stackRecords.findFirst({ where: eq(stackRecords.id, recordId) });
  if (record === undefined || (expectedType !== undefined && record.recordType !== expectedType)) return undefined;
  const details = await stackDetails(record.stackId);
  if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) return undefined;
  return { record, details };
}

function pagedStackRecords(records: StackRecordItem[], request: ParamCtx["request"]): { data: Record<string, unknown>[]; pagination: Record<string, unknown> } {
  const { number, size } = pageRequest(request);
  return { data: records.slice((number - 1) * size, number * size).map(stackRecordResource), pagination: pagination(request, number, size, records.length) };
}

async function approveStackRecord(record: StackRecordItem, userId: string | null, reason: string | null): Promise<void> {
  const approvalId = `sa-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();
  const runIds: string[] = [];
  await db.transaction(async (tx): Promise<void> => {
    await tx.insert(stackRecords).values({
      id: approvalId,
      stackId: record.stackId,
      parentId: record.id,
      recordType: "stack-approvals",
      name: null,
      status: "approved",
      payload: { reason, userId },
      createdAt: now,
      updatedAt: now,
    });
    const approvedRecord = await tx.update(stackRecords).set({
      status: "approved",
      payload: { ...(record.payload ?? {}), approvalId },
      updatedAt: now,
    }).where(and(eq(stackRecords.id, record.id), notInArray(stackRecords.status, ["succeeded", "failed", "canceled"]))).returning({ id: stackRecords.id });
    if (approvedRecord.length === 0) return;
    if (record.recordType === "stack-deployment-groups") {
      const runs = await tx.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, record.id), eq(stackRecords.recordType, "stack-deployment-runs")) });
      for (const run of runs) {
        if (["succeeded", "failed", "canceled"].includes(run.status)) continue;
        const approved = await tx.update(stackRecords).set({ status: "approved", updatedAt: now }).where(and(eq(stackRecords.id, run.id), notInArray(stackRecords.status, ["succeeded", "failed", "canceled"]))).returning({ id: stackRecords.id });
        if (approved.length === 1) runIds.push(run.id);
      }
    } else if (record.recordType === "stack-deployment-runs" && !["succeeded", "failed", "canceled"].includes(record.status)) {
      runIds.push(record.id);
    }
  });
  for (const runId of runIds) await enqueueDurableJob("stack-deployment", { runId }, { dedupeKey: `stack-run:${runId}:approval:${approvalId}` });
}

async function createStackConfigurationRecord(stack: StackItem, source: string, attributes: Record<string, unknown>): Promise<StackRecordItem | undefined> {
  return db.transaction(async (tx): Promise<StackRecordItem | undefined> => {
    const configurations = await tx.select().from(stackRecords).where(and(eq(stackRecords.stackId, stack.id), eq(stackRecords.recordType, "stack-configurations"))).orderBy(desc(stackRecords.createdAt));
    const latest = configurations[0];
    if (source === "reuse" && (latest === undefined || ["pending", "preparing"].includes(latest.status))) return undefined;
    const latestPayload = latest?.payload ?? {};
    const sequence = configurations.length === 0 ? 1 : Number(latestPayload["sequence-number"] ?? configurations.length) + 1;
    const record: typeof stackRecords.$inferInsert = {
      id: `stc-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      stackId: stack.id,
      parentId: null,
      recordType: "stack-configurations",
      name: null,
      status: "pending",
      payload: {
        source,
        "sequence-number": sequence,
        speculative: attributes.speculative === true,
        "destroy-all": attributes["destroy-all"] === true,
        components: [],
        archivePath: source === "reuse" && typeof latestPayload.archivePath === "string" ? latestPayload.archivePath : null,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await tx.insert(stackRecords).values(record);
    return record as StackRecordItem;
  });
}

export const stackRoutes = new Elysia({ name: "stacks" })
  .use(authPlugin)
  .post("/api/v2/stacks", async ({ body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data;
    if (data === null || typeof data !== "object") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data is required" }] }; }
    const attributes = (data as Record<string, unknown>).attributes;
    const attrs = attributes !== null && typeof attributes === "object" ? attributes as Record<string, unknown> : {};
    const relationships = (data as Record<string, unknown>).relationships;
    const rels = relationships !== null && typeof relationships === "object" ? relationships as Record<string, unknown> : {};
    const name = typeof attrs.name === "string" ? attrs.name.trim() : "";
    const description = typeof attrs.description === "string" ? attrs.description : "";
    const projectData = (rels.project as { data?: { id?: unknown } } | undefined)?.data;
    const projectId = typeof projectData?.id === "string" ? projectData.id : "";
    const agentPoolData = (rels["agent-pool"] as { data?: { id?: unknown } } | undefined)?.data;
    const agentPoolId = typeof agentPoolData?.id === "string" ? agentPoolData.id : undefined;
    const workingDirectory = typeof attrs["working-directory"] === "string" ? attrs["working-directory"] : undefined;
    const executionMode = attrs["execution-mode"] === undefined ? (agentPoolId === undefined ? "remote" : "agent") : attrs["execution-mode"];
    const speculative = attrs["speculative-enabled"] === true;
    const triggerPatterns = Array.isArray(attrs["trigger-patterns"]) ? (attrs["trigger-patterns"] as unknown[]).filter((item): item is string => typeof item === "string") : [];
    if (name === "" || projectId === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "name and project are required" }] }; }
    if (executionMode !== "remote" && executionMode !== "agent") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "execution-mode must be remote or agent" }] }; }
    if (executionMode === "agent" && agentPoolId === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent execution requires an agent-pool relationship" }] }; }
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (agentPoolId !== undefined) {
      const pool = await db.query.agentPools.findFirst({
        where: and(eq(agentPools.id, agentPoolId), eq(agentPools.orgId, project.orgId)),
      });
      if (pool === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    }
    const vcs = stackVcsRepoAttributes(attrs);
    const vcsError = await validStackVcs(vcs, project.orgId);
    if (vcsError !== null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: vcsError }] }; }
    const id = `st-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Date.now();
    const row: typeof stacks.$inferInsert = {
      id, orgId: project.orgId, projectId, agentPoolId: agentPoolId ?? null, executionMode, name, description: description === "" ? null : description,
      speculativeEnabled: speculative, triggerDisabled: vcs.triggerDisabled, debuggingMode: attrs["debugging-mode"] === true,
      workingDirectory: workingDirectory ?? null, triggerPatterns,
      vcsIdentifier: vcs.vcsIdentifier, vcsServiceProvider: vcs.vcsServiceProvider, vcsBranch: vcs.vcsBranch,
      vcsTagsRegex: vcs.vcsTagsRegex, vcsDisplayIdentifier: vcs.vcsDisplayIdentifier,
      vcsRepositoryHttpUrl: vcs.vcsRepositoryHttpUrl, vcsSparseCheckoutPattern: vcs.vcsSparseCheckoutPattern,
      vcsOAuthTokenId: vcs.vcsOAuthTokenId, vcsGhaInstallationId: vcs.vcsGhaInstallationId,
      createdAt: now, updatedAt: now,
    };
    await db.insert(stacks).values(row);
    (set as { status: number }).status = 201;
    return { data: stackResource(row as StackItem, project.name) };
  })
  .get("/api/v2/stacks/:stack_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: stackResource(details.stack, details.projectName) };
  })
  .get("/api/v2/organizations/:org_name/stacks", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const rows = await db.query.stacks.findMany({ where: eq(stacks.orgId, org.id) });
    return { data: rows.map((stack): Record<string, unknown> => stackResource(stack, null)) };
  })
  .get("/api/v2/stacks/:stack_id/stack-configuration-summaries", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const configurations = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, details.stack.id), eq(stackRecords.recordType, "stack-configurations")), orderBy: [desc(stackRecords.createdAt)] });
    const summaries = configurations.map((configuration): Record<string, unknown> => ({
      id: `scs-${configuration.id.slice(4)}`,
      type: "stack-configuration-summaries",
      attributes: { "sequence-number": (configuration.payload ?? {})["sequence-number"] ?? 1, status: configuration.status, "status-counts": { [configuration.status]: 1 } },
      relationships: { "stack-configuration": { data: { id: configuration.id, type: "stack-configurations" } } },
    }));
    const { number, size } = pageRequest(request);
    return { data: summaries.slice((number - 1) * size, number * size), ...pagination(request, number, size, summaries.length) };
  })
  .post("/api/v2/stacks/:stack_id/stack-configurations", async ({ params, body, request, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const source = new URL(request.url).searchParams.get("source") ?? "manual";
    if (!(source === "manual" || source === "fetch" || source === "reuse")) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "source must be manual, fetch, or reuse" }] };
    }
    if (source === "fetch" && details.stack.vcsIdentifier === null) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "fetch requires a VCS-backed stack" }] };
    }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data;
    const attrs = data !== null && typeof data === "object" && (data as Record<string, unknown>).attributes !== null && typeof (data as Record<string, unknown>).attributes === "object"
      ? (data as Record<string, unknown>).attributes as Record<string, unknown>
      : {};
    for (const key of ["speculative", "destroy-all"] as const) {
      if (attrs[key] !== undefined && typeof attrs[key] !== "boolean") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `${key} must be a boolean` }] };
      }
    }
    if (source === "manual" && details.stack.vcsIdentifier !== null && attrs.speculative !== true) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "manual configurations for VCS-backed stacks must be speculative" }] };
    }
    const configuration = await createStackConfigurationRecord(details.stack, source, attrs);
    if (configuration === undefined) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "reuse requires a previous stack configuration" }] };
    }
    if (source === "fetch" || source === "reuse") await enqueueStackConfiguration(configuration);
    (set as { status: number }).status = 200;
    return { data: stackRecordResource(configuration) };
  })
  .get("/api/v2/stacks/:stack_id/stack-configurations", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, details.stack.id), eq(stackRecords.recordType, "stack-configurations")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_configuration_id ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-deployment-group-summaries", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_configuration_id ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const groups = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-groups")), orderBy: [desc(stackRecords.createdAt)] });
    const summaries = groups.map((group): Record<string, unknown> => ({ id: `sdgs-${group.id.slice(4)}`, type: "stack-deployment-group-summaries", attributes: { name: group.name, status: group.status, "status-counts": { [group.status]: 1 } }, relationships: { "stack-deployment-group": { data: { id: group.id, type: "stack-deployment-groups" } } } }));
    const { number, size } = pageRequest(request);
    return { data: summaries.slice((number - 1) * size, number * size), ...pagination(request, number, size, summaries.length) };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-diagnostics", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_configuration_id ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-diagnostics")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/upload-url", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_configuration_id ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { "source-upload-url": signedApiURL(request, `/api/v2/stack-configurations/${authorized.record.id}/upload`, "PUT") }, links: { self: `/api/v2/stack-configurations/${authorized.record.id}/upload-url` } };
  })
  .put("/api/v2/stack-configurations/:stack_configuration_id/upload", async ({ params, body, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const recordId = params.stack_configuration_id ?? "";
    const authorized = await authorizedStackRecord(recordId, user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined && !validSignedApiURL(request, `/api/v2/stack-configurations/${recordId}/upload`, "PUT")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const record = authorized?.record ?? await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, recordId), eq(stackRecords.recordType, "stack-configurations")) });
    if (record === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const recordPayload = record.payload ?? {};
    const existingPath = typeof recordPayload.archivePath === "string" ? recordPayload.archivePath : null;
    if (record.status !== "pending" || existingPath !== null) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict" }] }; }
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 100 * 1024 * 1024) {
      (set as { status: number }).status = 413;
      return { errors: [{ status: "413", title: "Payload Too Large" }] };
    }
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Configuration archive is empty" }] }; }
    if (bytes.byteLength > 100 * 1024 * 1024) { (set as { status: number }).status = 413; return { errors: [{ status: "413", title: "Payload Too Large" }] }; }
    const claimed = await db.update(stackRecords).set({ status: "uploading", updatedAt: Date.now() }).where(and(eq(stackRecords.id, record.id), eq(stackRecords.status, "pending"))).returning({ id: stackRecords.id });
    if (claimed.length !== 1) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict" }] }; }
    await mkdir(STACK_STORAGE_DIR, { recursive: true });
    const archivePath = join(STACK_STORAGE_DIR, `${record.id}.tar.gz`);
    try {
      await writeFile(archivePath, bytes, { mode: 0o600 });
      await db.update(stackRecords).set({ status: "ready", payload: { ...recordPayload, archivePath }, updatedAt: Date.now() }).where(eq(stackRecords.id, record.id));
      await enqueueStackConfiguration({ ...record, status: "ready", payload: { ...recordPayload, archivePath } });
    } catch (error: unknown) {
      await db.update(stackRecords).set({ status: "pending", updatedAt: Date.now() }).where(and(eq(stackRecords.id, record.id), eq(stackRecords.status, "uploading")));
      throw error;
    }
    return { data: { id: record.id, type: "stack-configurations", attributes: { status: "ready" } } };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/source-bundle", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_configuration_id ?? "", user, tokenOrgId, teamId, "stack-configurations");
    const archivePath = authorized === undefined ? null : (() => {
      const payload = authorized.record.payload ?? {};
      return typeof payload.archivePath === "string" ? payload.archivePath : null;
    })();
    if (authorized === undefined || archivePath === null || !isStackStoragePath(archivePath) || !(await Bun.file(archivePath).exists())) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const location = signedApiURL(request, `/api/v2/stack-configurations/${authorized.record.id}/source-bundle/download`, "GET");
    (set.headers as Record<string, string>) .Location = location;
    (set as { status: number }).status = 302;
    return {};
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/source-bundle/download", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const record = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, params.stack_configuration_id ?? ""), eq(stackRecords.recordType, "stack-configurations")) });
    const details = record === undefined ? undefined : await stackDetails(record.stackId);
    if (record === undefined || details === undefined || (!(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects")) && !validSignedApiURL(request, `/api/v2/stack-configurations/${record.id}/source-bundle/download`, "GET"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const recordPayload = record.payload ?? {};
    const archivePath = typeof recordPayload.archivePath === "string" ? recordPayload.archivePath : null;
    if (archivePath === null || !isStackStoragePath(archivePath) || !(await Bun.file(archivePath).exists())) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    (set.headers as Record<string, string>)["Content-Type"] = "application/gzip";
    return Bun.file(archivePath);
  })
  .get("/api/v2/stacks/:stack_id/stack-deployments", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const groups = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, details.stack.id), eq(stackRecords.recordType, "stack-deployment-groups")), orderBy: [desc(stackRecords.createdAt)] });
    const seen = new Set<string>();
    const deployments = groups.flatMap((group): Record<string, unknown>[] => {
      const name = group.name ?? group.id;
      if (seen.has(name)) return [];
      seen.add(name);
      const run = (group.payload ?? {}).latestRunId;
      return [{ id: `${details.stack.id}-std-${name}`, type: "stack-deployments", attributes: { name }, relationships: { stack: { data: { id: details.stack.id, type: "stacks" } }, "latest-deployment-run": { data: typeof run === "string" ? { id: run, type: "stack-deployment-runs" } : null } }, links: { self: `/api/v2/stacks/${details.stack.id}/stack-deployments/${encodeURIComponent(name)}`, "stack-deployment-runs": `/api/v2/stacks/${details.stack.id}/stack-deployments/${encodeURIComponent(name)}/stack-deployment-runs` } }];
    });
    const { number, size } = pageRequest(request);
    return { data: deployments.slice((number - 1) * size, number * size), ...pagination(request, number, size, deployments.length) };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-deployment-groups", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_configuration_id ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-groups")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-deployment-groups/:stack_deployment_group_name", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_configuration_id ?? "", user, tokenOrgId, teamId, "stack-configurations");
    const group = authorized === undefined ? undefined : await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-groups"), eq(stackRecords.name, params.stack_deployment_group_name ?? "")) });
    if (group === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(group) };
  })
  .get("/api/v2/stack-deployment-groups/:stack_deployment_group_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_group_id ?? "", user, tokenOrgId, teamId, "stack-deployment-groups");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-deployment-runs", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_configuration_id ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = (await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, authorized.record.stackId), eq(stackRecords.recordType, "stack-deployment-runs")), orderBy: [desc(stackRecords.createdAt)] })).filter((record) => (record.payload ?? {}).configurationId === authorized.record.id);
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-deployment-groups/:stack_deployment_group_id/stack-deployment-runs", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_group_id ?? "", user, tokenOrgId, teamId, "stack-deployment-groups");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-runs")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-deployment-runs/:stack_deployment_run_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_run_id ?? "", user, tokenOrgId, teamId, "stack-deployment-runs");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-deployment-runs/:stack_deployment_run_id/stack-deployment-steps", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_run_id ?? "", user, tokenOrgId, teamId, "stack-deployment-runs");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-steps")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-deployment-steps/:stack_deployment_step_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_step_id ?? "", user, tokenOrgId, teamId, "stack-deployment-steps");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-deployment-steps/:stack_deployment_step_id/stack-diagnostics", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_step_id ?? "", user, tokenOrgId, teamId, "stack-deployment-steps");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-diagnostics")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-deployment-steps/:stack_deployment_step_id/artifacts", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_step_id ?? "", user, tokenOrgId, teamId, "stack-deployment-steps");
    const name = new URL(request.url).searchParams.get("name") ?? "";
    if (authorized === undefined || !["plan-description", "plan-debug-log", "apply-description", "apply-debug-log"].includes(name)) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const artifact = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-artifacts"), eq(stackRecords.name, name)) });
    const path = (artifact?.payload ?? {}).path;
    if (typeof path !== "string" || !isStackStoragePath(path) || !(await Bun.file(path).exists())) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return new Response(Bun.file(path), { headers: { "Content-Type": "application/octet-stream" } });
  })
  .get("/api/v2/stack-approvals/:stack_approval_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_approval_id ?? "", user, tokenOrgId, teamId, "stack-approvals");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .post("/api/v2/stack-deployment-groups/:stack_deployment_group_id/approve-all-plans", async ({ params, user, body, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_group_id ?? "", user, tokenOrgId, teamId, "stack-deployment-groups");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    await approveStackRecord(authorized.record, user?.id ?? null, typeof payload.reason === "string" ? payload.reason : null);
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stack-deployment-groups/:stack_deployment_group_id/rerun", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_group_id ?? "", user, tokenOrgId, teamId, "stack-deployment-groups");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const now = Date.now();
    await db.update(stackRecords).set({ status: "pending", updatedAt: now }).where(eq(stackRecords.id, authorized.record.id));
    const runs = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-runs")) });
    for (const run of runs) {
      if (!["failed", "canceled"].includes(run.status)) continue;
      const step = (await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, run.id), eq(stackRecords.recordType, "stack-deployment-steps")), orderBy: [desc(stackRecords.createdAt)] }))[0];
      await db.update(stackRecords).set({ status: "planning", updatedAt: now }).where(eq(stackRecords.id, run.id));
      if (step !== undefined) await db.update(stackRecords).set({ status: "queued", payload: { ...(step.payload ?? {}), error: null }, updatedAt: now }).where(eq(stackRecords.id, step.id));
      await enqueueDurableJob("stack-deployment", { runId: run.id }, { dedupeKey: `stack-run:${run.id}:rerun:${now}` });
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stack-deployment-runs/:stack_deployment_run_id/approve-all-plans", async ({ params, user, body, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_run_id ?? "", user, tokenOrgId, teamId, "stack-deployment-runs");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    await approveStackRecord(authorized.record, user?.id ?? null, typeof payload.reason === "string" ? payload.reason : null);
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stack-deployment-runs/:stack_deployment_run_id/cancel", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_run_id ?? "", user, tokenOrgId, teamId, "stack-deployment-runs");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const canceled = await db.transaction(async (tx): Promise<boolean> => {
      const now = Date.now();
      const updated = await tx.update(stackRecords).set({ status: "canceled", updatedAt: now }).where(and(eq(stackRecords.id, authorized.record.id), notInArray(stackRecords.status, ["succeeded", "failed", "canceled"]))).returning({ id: stackRecords.id });
      if (updated.length === 0) return false;
      const fencingToken = recordFencingToken(authorized.record);
      await tx.update(stackAgentJobs).set({ status: "canceled", agentId: null, completedAt: now, updatedAt: now }).where(and(eq(stackAgentJobs.deploymentRunId, authorized.record.id), notInArray(stackAgentJobs.status, ["completed", "errored", "canceled"])));
      await tx.update(durableJobs).set({ status: "canceled", updatedAt: now }).where(and(eq(durableJobs.kind, "stack-deployment"), eq(durableJobs.dedupeKey, `stack-run:${authorized.record.id}`), notInArray(durableJobs.status, ["succeeded", "failed", "canceled"])));
      await tx.update(stackStateLocks).set({ runId: null, leaseExpiresAt: null, releasedAt: now, updatedAt: now }).where(and(
        eq(stackStateLocks.runId, authorized.record.id),
        ...(fencingToken === undefined ? [] : [eq(stackStateLocks.fencingToken, fencingToken)]),
      ));
      return true;
    });
    if (!canceled) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "deployment run is already terminal" }] }; }
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stack-deployment-steps/:stack_deployment_step_id/advance", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_deployment_step_id ?? "", user, tokenOrgId, teamId, "stack-deployment-steps");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.update(stackRecords).set({ status: "completed", updatedAt: Date.now() }).where(eq(stackRecords.id, authorized.record.id));
    if (authorized.record.parentId !== null) await enqueueDurableJob("stack-deployment", { runId: authorized.record.parentId }, { dedupeKey: `stack-run:${authorized.record.parentId}:advance:${authorized.record.id}` });
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/stacks/:stack_id/stack-states", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, details.stack.id), eq(stackRecords.recordType, "stack-states")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack_states/:stack_state_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_state_id ?? "", user, tokenOrgId, teamId, "stack-states");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-states/:stack_state_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_state_id ?? "", user, tokenOrgId, teamId, "stack-states");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-states/:stack_state_id/description", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params.stack_state_id ?? "", user, tokenOrgId, teamId, "stack-states");
    const path = (authorized?.record.payload ?? {}).descriptionPath;
    if (authorized === undefined || typeof path !== "string" || !isStackStoragePath(path) || !(await Bun.file(path).exists())) { (set as { status: number }).status = 204; return {}; }
    const location = signedApiURL(request, `/api/v2/stack-states/${authorized.record.id}/description/download`, "GET");
    (set.headers as Record<string, string>).Location = location;
    (set as { status: number }).status = 307;
    return {};
  })
  .get("/api/v2/stack-states/:stack_state_id/description/download", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const record = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, params.stack_state_id ?? ""), eq(stackRecords.recordType, "stack-states")) });
    const details = record === undefined ? undefined : await stackDetails(record.stackId);
    if (record === undefined || details === undefined || (!(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects")) && !validSignedApiURL(request, `/api/v2/stack-states/${record.id}/description/download`, "GET"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const path = (record.payload ?? {}).descriptionPath;
    if (typeof path !== "string" || !isStackStoragePath(path) || !(await Bun.file(path).exists())) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return Bun.file(path);
  })
  .patch("/api/v2/stacks/:stack_id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const raw = body;
    const payload = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const data = payload.data;
    const attrs = (data !== null && typeof data === "object" ? (data as Record<string, unknown>).attributes : null);
    const attributes = attrs !== null && typeof attrs === "object" ? attrs as Record<string, unknown> : {};
    const relationships = data !== null && typeof data === "object" && (data as Record<string, unknown>).relationships !== null && typeof (data as Record<string, unknown>).relationships === "object"
      ? (data as Record<string, unknown>).relationships as Record<string, unknown>
      : {};
    const updates: Partial<typeof stacks.$inferInsert> = { updatedAt: Date.now() };
    if (typeof attributes.name === "string" && attributes.name.trim() !== "") updates.name = attributes.name.trim();
    if (typeof attributes.description === "string") updates.description = attributes.description;
    if (typeof attributes["speculative-enabled"] === "boolean") updates.speculativeEnabled = attributes["speculative-enabled"];
    if (typeof attributes["working-directory"] === "string") updates.workingDirectory = attributes["working-directory"];
    if (Array.isArray(attributes["trigger-patterns"])) updates.triggerPatterns = (attributes["trigger-patterns"] as unknown[]).filter((item): item is string => typeof item === "string");
    // vcs-repo updates replace the stored VCS attributes (empty/null clears).
    // A present-but-malformed vcs-repo is a client error, not a silent clear.
    if (attributes["vcs-repo"] !== undefined) {
      const vcs = attributes["vcs-repo"];
      if (vcs !== null && (typeof vcs !== "object" || Array.isArray(vcs))) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "vcs-repo must be an object or null" }] };
      }
      const v = stackVcsRepoAttributes(attributes);
      const vcsError = await validStackVcs(v, details.stack.orgId);
      if (vcsError !== null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: vcsError }] }; }
      updates.vcsIdentifier = v.vcsIdentifier;
      updates.vcsServiceProvider = v.vcsServiceProvider;
      updates.vcsBranch = v.vcsBranch;
      updates.vcsTagsRegex = v.vcsTagsRegex;
      updates.vcsDisplayIdentifier = v.vcsDisplayIdentifier;
      updates.vcsRepositoryHttpUrl = v.vcsRepositoryHttpUrl;
      updates.vcsSparseCheckoutPattern = v.vcsSparseCheckoutPattern;
      updates.vcsOAuthTokenId = v.vcsOAuthTokenId;
      updates.vcsGhaInstallationId = v.vcsGhaInstallationId;
      updates.triggerDisabled = v.triggerDisabled;
    }
    if (typeof attributes["trigger-disabled"] === "boolean") updates.triggerDisabled = attributes["trigger-disabled"];
    if (typeof attributes["debugging-mode"] === "boolean") updates.debuggingMode = attributes["debugging-mode"];
    if (attributes["execution-mode"] !== undefined && attributes["execution-mode"] !== "remote" && attributes["execution-mode"] !== "agent") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "execution-mode must be remote or agent" }] };
    }
    const poolData = (relationships["agent-pool"] as { data?: { id?: unknown } } | undefined)?.data;
    if (poolData !== undefined) {
      if (poolData === null) updates.agentPoolId = null;
      else if (typeof poolData.id === "string") updates.agentPoolId = poolData.id;
      else { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent-pool must reference an agent pool" }] }; }
    }
    const nextPoolId = updates.agentPoolId !== undefined ? updates.agentPoolId : details.stack.agentPoolId;
    const nextMode = typeof attributes["execution-mode"] === "string"
      ? attributes["execution-mode"]
      : poolData !== undefined
        ? nextPoolId === null ? "remote" : "agent"
        : details.stack.executionMode;
    if (nextMode === "agent" && nextPoolId === null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent execution requires an agent-pool relationship" }] }; }
    if (nextPoolId !== null) {
      const pool = await db.query.agentPools.findFirst({ where: and(eq(agentPools.id, nextPoolId), eq(agentPools.orgId, details.stack.orgId)) });
      if (pool === undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent-pool must belong to the Stack organization" }] }; }
    }
    if (typeof attributes["execution-mode"] === "string") updates.executionMode = attributes["execution-mode"];
    await db.update(stacks).set(updates).where(eq(stacks.id, details.stack.id));
    const updated = await db.query.stacks.findFirst({ where: eq(stacks.id, params.stack_id ?? "") });
    return { data: updated === undefined ? undefined : stackResource(updated, details.projectName) };
  })
  .delete("/api/v2/stacks/:stack_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(stacks).where(eq(stacks.id, details.stack.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stacks/:stack_id/fetch-latest-from-vcs", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (details.stack.vcsIdentifier === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "fetch requires a VCS-backed stack" }] };
    }
    const configuration = await createStackConfigurationRecord(details.stack, "fetch", {});
    if (configuration === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Unable to create a Stack configuration" }] };
    }
    await enqueueStackConfiguration(configuration);
    (set as { status: number }).status = 204;
    return {};
  });
