import { newResourceId } from "../lib/resource-id";
import { Elysia } from "elysia";
import { and, desc, eq, inArray, notInArray, or } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { agentPools, durableJobs, githubAppInstallations, oauthClients, oauthTokens, organizations, projects, stackAgentJobs, stackRecords, stackStateLocks, stacks } from "../db/schema";
import { checkOrganizationPermission, pageRequest, pagination, signedApiURL, validSignedApiURL, type DeepReadonly } from "../lib/utils";
import { isValidTagsRegex } from "../lib/vcs-repo";
import { cachedOrgByName } from "../lib/cached-lookups";
import { enqueueDurableJob } from "../lib/durable-jobs";
import { isCurrentStackStateRecord, isStackStoragePath } from "../lib/stack-worker";
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
  const value = (record.payload ?? {})["fencing-token"] ?? (record.payload ?? {})["fencingToken"];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

const STACK_STORAGE_DIR = join(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"), "stacks");

function stackResource(stack: StackItem, _projectName: string | null): Record<string, unknown> {
  const vcsRepo: Record<string, unknown> = {};
  if (stack.vcsIdentifier !== null || stack.vcsServiceProvider !== null || stack.vcsRepositoryHttpUrl !== null) {
    vcsRepo["identifier"] = stack.vcsIdentifier;
    vcsRepo["branch"] = stack.vcsBranch ?? "";
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
    relationships["project"] = { data: { id: stack.projectId, type: "projects" } };
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

function vcsRepoString(repo: Record<string, unknown>, key: string): string {
  const value = repo[key];
  return typeof value === "string" ? value : "";
}

function nullIfEmpty(value: string): string | null {
  return value === "" ? null : value;
}

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
  const identifier = vcsRepoString(repo, "identifier").trim();
  const branch = vcsRepoString(repo, "branch");
  const serviceProvider = typeof repo["service-provider"] === "string"
    ? repo["service-provider"] as string
    : vcsRepoString(attributes, "service-provider");
  const tagsRegex = vcsRepoString(repo, "tags-regex");
  const displayIdentifier = vcsRepoString(repo, "display-identifier");
  const repositoryHttpUrl = vcsRepoString(repo, "repository-http-url");
  const sparseCheckoutPattern = vcsRepoString(repo, "sparse-checkout-pattern");
  const oauthTokenId = vcsRepoString(repo, "oauth-token-id");
  const ghaId = vcsRepoString(repo, "github-app-installation-id");
  return {
    vcsIdentifier: nullIfEmpty(identifier),
    vcsServiceProvider: nullIfEmpty(serviceProvider),
    vcsBranch: nullIfEmpty(branch),
    vcsTagsRegex: nullIfEmpty(tagsRegex),
    vcsDisplayIdentifier: nullIfEmpty(displayIdentifier),
    vcsRepositoryHttpUrl: nullIfEmpty(repositoryHttpUrl),
    vcsSparseCheckoutPattern: nullIfEmpty(sparseCheckoutPattern),
    vcsOAuthTokenId: nullIfEmpty(oauthTokenId),
    vcsGhaInstallationId: nullIfEmpty(ghaId),
    triggerDisabled: repo["trigger-disabled"] === true || attributes["trigger-disabled"] === true,
  };
}

const stackServiceProviders = new Set(["github", "github_enterprise", "gitlab_hosted", "gitlab_community_edition", "gitlab_enterprise_edition", "ado_server"]);

function validRepositoryHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

async function validStackVcs(vcs: StackVcsAttributes, orgId: string): Promise<string | null> {
  if (vcs.vcsServiceProvider !== null && !stackServiceProviders.has(vcs.vcsServiceProvider)) return "Invalid Stack VCS service provider";
  if (vcs.vcsRepositoryHttpUrl !== null && !validRepositoryHttpUrl(vcs.vcsRepositoryHttpUrl)) return "Invalid Stack repository-http-url";
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
  const stack = await db.query.stacks.findFirst({ where: eq(stacks.id, configuration.stackId), columns: { orgId: true } });
  const organizationId = stack?.orgId ?? null;
  await enqueueDurableJob(
    "stack-configuration",
    { configurationId: configuration.id, organizationId, jobClass: "plan", estimatedBytes: 16 * 1024 * 1024 },
    { dedupeKey: configuration.id },
  );
}

async function enqueueStackDeployment(runId: string, organizationId: string | null, dedupeKey: string): Promise<void> {
  await enqueueDurableJob(
    "stack-deployment",
    { runId, organizationId, jobClass: "run", estimatedBytes: 32 * 1024 * 1024 },
    { dedupeKey },
  );
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

type StackRecordTimestamps = Readonly<{ "created-at": string | null; "updated-at": string | null }>;
type StackRecordApproval = { id: string; type: string } | null;

function stackConfigurationResource(record: StackRecordItem, payload: Record<string, unknown>, timestamps: StackRecordTimestamps): Record<string, unknown> {
  return {
    id: record.id,
    type: record.recordType,
    attributes: {
      status: record.status,
      "sequence-number": payload["sequence-number"] ?? 1,
      ...timestamps,
      speculative: payload["speculative"] === true,
      components: Array.isArray(payload["components"]) ? payload["components"] : [],
      deployments: Array.isArray(payload["deployments"]) ? payload["deployments"] : [],
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

function stackDeploymentGroupResource(record: StackRecordItem, payload: Record<string, unknown>, timestamps: StackRecordTimestamps, approval: StackRecordApproval): Record<string, unknown> {
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

function stackDeploymentRunResource(record: StackRecordItem, payload: Record<string, unknown>, timestamps: StackRecordTimestamps, approval: StackRecordApproval): Record<string, unknown> {
  return {
    id: record.id,
    type: record.recordType,
    attributes: { status: record.status, deployment: record.name, ...timestamps, "plan-mode": payload["plan-mode"] ?? "normal", component: payload["component"] ?? null, "component-index": payload["componentIndex"] ?? 0, cycle: payload["cycle"] ?? 0, destroy: payload["destroy"] === true, "lock-acquired": payload["lockAcquired"] === true, error: payload["error"] ?? null },
    relationships: {
      "stack-deployment-group": { data: record.parentId === null ? null : { id: record.parentId, type: "stack-deployment-groups" } },
      "stack-configuration": { data: typeof payload["configurationId"] === "string" ? { id: payload["configurationId"], type: "stack-configurations" } : null },
      "stack-deployment-steps": { links: { related: `/api/v2/stack-deployment-runs/${record.id}/stack-deployment-steps` } },
      "stack-approval": { data: approval },
    },
    links: { self: `/api/v2/stack-deployment-runs/${record.id}` },
  };
}

function stackDeploymentStepResource(record: StackRecordItem, payload: Record<string, unknown>, timestamps: StackRecordTimestamps, approval: StackRecordApproval): Record<string, unknown> {
  return {
    id: record.id,
    type: record.recordType,
    attributes: { status: record.status, "operation-type": payload["operation-type"] ?? "plan", phase: payload["phase"] ?? null, "component-index": payload["componentIndex"] ?? 0, "requires-state-lock": payload["requires-state-lock"] === true, "has-changes": payload["has-changes"] === true || payload["hasChanges"] === true, "deferred-changes": payload["deferred-changes"] === true || payload["deferredChanges"] === true, output: payload["output"] ?? null, ...timestamps },
    relationships: {
      "stack-deployment-run": { data: record.parentId === null ? null : { id: record.parentId, type: "stack-deployment-runs" } },
      "stack-diagnostics": { links: { related: `/api/v2/stack-deployment-steps/${record.id}/stack-diagnostics` }, meta: { count: 0 } },
      "stack-approval": { data: approval },
    },
    links: { self: `/api/v2/stack-deployment-steps/${record.id}`, "plan-description": `/api/v2/stack-deployment-steps/${record.id}/artifacts?name=plan-description` },
  };
}

function stackStateResource(record: StackRecordItem, payload: Record<string, unknown>): Record<string, unknown> {
  const isCurrent = isCurrentStackStateRecord(record);
  const status = isCurrent ? "current" : record.status === "current" ? "superseded" : record.status;
  return {
    id: record.id,
    type: record.recordType,
    attributes: {
      generation: payload["generation"] ?? 1,
      status,
      deployment: record.name,
      components: Array.isArray(payload["components"]) ? payload["components"] : [],
      "is-current": isCurrent,
      "resource-instance-count": payload["resource-instance-count"] ?? 0,
    },
    relationships: { stack: { data: { id: record.stackId, type: "stacks" } }, "stack-deployment-run": { data: typeof payload["runId"] === "string" ? { id: payload["runId"], type: "stack-deployment-runs" } : null } },
    links: { self: `/api/v2/stack-states/${record.id}`, description: `/api/v2/stack-states/${record.id}/description` },
  };
}

function stackDiagnosticResource(record: StackRecordItem, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: record.id,
    type: record.recordType,
    attributes: { severity: payload["severity"] ?? "error", summary: payload["summary"] ?? "", detail: payload["detail"] ?? "", diags: payload["diags"] ?? null, acknowledged: payload["acknowledged"] === true, "acknowledged-at": payload["acknowledged-at"] ?? null, "created-at": recordDate(record.createdAt) },
    relationships: { "stack-configuration": { data: record.parentId === null ? null : { id: record.parentId, type: "stack-configurations" } } },
    links: { self: `/api/v2/stack-diagnostics/${record.id}` },
  };
}

function stackApprovalResource(record: StackRecordItem, payload: Record<string, unknown>): Record<string, unknown> {
  return { id: record.id, type: record.recordType, attributes: { reason: payload["reason"] ?? null, "created-at": recordDate(record.createdAt) }, relationships: { user: { data: typeof payload["userId"] === "string" ? { id: payload["userId"], type: "users" } : null } } };
}

function stackRecordResource(record: StackRecordItem): Record<string, unknown> {
  const payload = record.payload ?? {};
  const approval = typeof payload["approvalId"] === "string" ? { id: payload["approvalId"], type: "stack-approvals" } : null;
  const timestamps = {
    "created-at": recordDate(record.createdAt),
    "updated-at": recordDate(record.updatedAt),
  };
  if (record.recordType === "stack-configurations") return stackConfigurationResource(record, payload, timestamps);
  if (record.recordType === "stack-deployment-groups") return stackDeploymentGroupResource(record, payload, timestamps, approval);
  if (record.recordType === "stack-deployment-runs") return stackDeploymentRunResource(record, payload, timestamps, approval);
  if (record.recordType === "stack-deployment-steps") return stackDeploymentStepResource(record, payload, timestamps, approval);
  if (record.recordType === "stack-states") return stackStateResource(record, payload);
  if (record.recordType === "stack-diagnostics") return stackDiagnosticResource(record, payload);
  if (record.recordType === "stack-approvals") return stackApprovalResource(record, payload);
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

async function approveStackRecord(record: StackRecordItem, organizationId: string, userId: string | null, reason: string | null): Promise<void> {
  const approvalId = newResourceId("sa");
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
  for (const runId of runIds) await enqueueStackDeployment(runId, organizationId, `stack-run:${runId}:approval:${approvalId}`);
}

async function createStackConfigurationRecord(stack: StackItem, source: string, attributes: Record<string, unknown>): Promise<StackRecordItem | undefined> {
  return db.transaction(async (tx): Promise<StackRecordItem | undefined> => {
    const configurations = await tx.select().from(stackRecords).where(and(eq(stackRecords.stackId, stack.id), eq(stackRecords.recordType, "stack-configurations"))).orderBy(desc(stackRecords.createdAt));
    const latest = configurations[0];
    if (source === "reuse" && (latest === undefined || ["pending", "preparing"].includes(latest.status))) return undefined;
    const latestPayload = latest?.payload ?? {};
    const sequence = configurations.length === 0 ? 1 : Number(latestPayload["sequence-number"] ?? configurations.length) + 1;
    const record: typeof stackRecords.$inferInsert = {
      id: newResourceId("stc"),
      stackId: stack.id,
      parentId: null,
      recordType: "stack-configurations",
      name: null,
      status: "pending",
      payload: {
        source,
        "sequence-number": sequence,
        speculative: attributes["speculative"] === true,
        "destroy-all": attributes["destroy-all"] === true,
        components: [],
        archivePath: source === "reuse" && typeof latestPayload["archivePath"] === "string" ? latestPayload["archivePath"] : null,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await tx.insert(stackRecords).values(record);
    return record as StackRecordItem;
  });
}

function parseStackPatchDocument(body: unknown): { attributes: Record<string, unknown>; relationships: Record<string, unknown> } {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const data = payload["data"];
  const attrs = (data !== null && typeof data === "object" ? (data as Record<string, unknown>)["attributes"] : null);
  const attributes = attrs !== null && typeof attrs === "object" ? attrs as Record<string, unknown> : {};
  const relationships = data !== null && typeof data === "object" && (data as Record<string, unknown>)["relationships"] !== null && typeof (data as Record<string, unknown>)["relationships"] === "object"
    ? (data as Record<string, unknown>)["relationships"] as Record<string, unknown>
    : {};
  return { attributes, relationships };
}

function applyStackScalarUpdates(attributes: Record<string, unknown>, updates: Partial<typeof stacks.$inferInsert>): void {
  if (typeof attributes["name"] === "string" && attributes["name"].trim() !== "") updates.name = attributes["name"].trim();
  if (typeof attributes["description"] === "string") updates.description = attributes["description"];
  if (typeof attributes["speculative-enabled"] === "boolean") updates.speculativeEnabled = attributes["speculative-enabled"];
  if (typeof attributes["working-directory"] === "string") updates.workingDirectory = attributes["working-directory"];
  if (Array.isArray(attributes["trigger-patterns"])) updates.triggerPatterns = (attributes["trigger-patterns"] as unknown[]).filter((item): item is string => typeof item === "string");
  if (typeof attributes["trigger-disabled"] === "boolean") updates.triggerDisabled = attributes["trigger-disabled"];
  if (typeof attributes["debugging-mode"] === "boolean") updates.debuggingMode = attributes["debugging-mode"];
}

async function applyStackVcsUpdate(
  attributes: Record<string, unknown>,
  orgId: string,
  updates: Partial<typeof stacks.$inferInsert>,
): Promise<string | null> {
  // vcs-repo updates replace the stored VCS attributes (empty/null clears).
  // A present-but-malformed vcs-repo is a client error, not a silent clear.
  if (attributes["vcs-repo"] === undefined) return null;
  const vcs = attributes["vcs-repo"];
  if (vcs !== null && (typeof vcs !== "object" || Array.isArray(vcs))) {
    return "vcs-repo must be an object or null";
  }
  const v = stackVcsRepoAttributes(attributes);
  const vcsError = await validStackVcs(v, orgId);
  if (vcsError !== null) return vcsError;
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
  return null;
}

function applyStackPoolRelationship(
  poolData: { id?: unknown } | null | undefined,
  updates: Partial<typeof stacks.$inferInsert>,
): string | null {
  if (poolData === undefined) return null;
  if (poolData === null) {
    updates.agentPoolId = null;
    return null;
  }
  if (typeof poolData.id !== "string") return "agent-pool must reference an agent pool";
  updates.agentPoolId = poolData.id;
  return null;
}

async function validateStackAgentPool(nextPoolId: string | null, orgId: string): Promise<string | null> {
  if (nextPoolId === null) return null;
  const pool = await db.query.agentPools.findFirst({ where: and(eq(agentPools.id, nextPoolId), eq(agentPools.orgId, orgId)) });
  if (pool === undefined) return "agent-pool must belong to the Stack organization";
  return null;
}

async function applyStackExecutionUpdates(
  attributes: Record<string, unknown>,
  relationships: Record<string, unknown>,
  stack: StackItem,
  orgId: string,
  updates: Partial<typeof stacks.$inferInsert>,
): Promise<string | null> {
  if (attributes["execution-mode"] !== undefined && attributes["execution-mode"] !== "remote" && attributes["execution-mode"] !== "agent") {
    return "execution-mode must be remote or agent";
  }
  const poolData = (relationships["agent-pool"] as { data?: { id?: unknown } } | undefined)?.data;
  const poolError = applyStackPoolRelationship(poolData, updates);
  if (poolError !== null) return poolError;
  const nextPoolId = updates.agentPoolId !== undefined ? updates.agentPoolId : stack.agentPoolId;
  const nextMode = typeof attributes["execution-mode"] === "string"
    ? attributes["execution-mode"]
    : poolData !== undefined
      ? nextPoolId === null ? "remote" : "agent"
      : stack.executionMode;
  if (nextMode === "agent" && nextPoolId === null) return "agent execution requires an agent-pool relationship";
  const orgError = await validateStackAgentPool(nextPoolId, orgId);
  if (orgError !== null) return orgError;
  if (typeof attributes["execution-mode"] === "string") updates.executionMode = attributes["execution-mode"];
  return null;
}

function stackRelationId(rels: Record<string, unknown>, key: string): string | undefined {
  const relData = (rels[key] as { data?: { id?: unknown } } | undefined)?.data;
  return typeof relData?.id === "string" ? relData.id : undefined;
}

type StackCreateFields = Readonly<{
  attrs: Record<string, unknown>;
  name: string;
  description: string;
  projectId: string;
  agentPoolId: string | undefined;
  workingDirectory: string | undefined;
  executionMode: unknown;
  speculative: boolean;
  triggerPatterns: string[];
}>;

function parseStackCreateFields(data: Record<string, unknown>): StackCreateFields {
  const attributes = data["attributes"];
  const attrs = attributes !== null && typeof attributes === "object" ? attributes as Record<string, unknown> : {};
  const relationships = data["relationships"];
  const rels = relationships !== null && typeof relationships === "object" ? relationships as Record<string, unknown> : {};
  const agentPoolId = stackRelationId(rels, "agent-pool");
  return {
    attrs,
    name: typeof attrs["name"] === "string" ? attrs["name"].trim() : "",
    description: typeof attrs["description"] === "string" ? attrs["description"] : "",
    projectId: stackRelationId(rels, "project") ?? "",
    agentPoolId,
    workingDirectory: typeof attrs["working-directory"] === "string" ? attrs["working-directory"] : undefined,
    executionMode: attrs["execution-mode"] === undefined ? (agentPoolId === undefined ? "remote" : "agent") : attrs["execution-mode"],
    speculative: attrs["speculative-enabled"] === true,
    triggerPatterns: Array.isArray(attrs["trigger-patterns"]) ? (attrs["trigger-patterns"] as unknown[]).filter((item): item is string => typeof item === "string") : [],
  };
}

async function authorizeStackProject(
  projectId: string,
  agentPoolId: string | undefined,
  userId: string | undefined,
  tokenOrgId: string | null,
  teamId: string | null,
): Promise<{ project: typeof projects.$inferSelect } | { status: 404 }> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (project === undefined || !(await checkOrganizationPermission(project.orgId, userId, tokenOrgId, teamId, "manage-projects"))) {
    return { status: 404 };
  }
  if (agentPoolId !== undefined) {
    const pool = await db.query.agentPools.findFirst({
      where: and(eq(agentPools.id, agentPoolId), eq(agentPools.orgId, project.orgId)),
    });
    if (pool === undefined) return { status: 404 };
  }
  return { project };
}

function buildStackInsert(
  id: string,
  orgId: string,
  fields: StackCreateFields,
  executionMode: string,
  vcs: StackVcsAttributes,
  now: number,
): typeof stacks.$inferInsert {
  return {
    id, orgId, projectId: fields.projectId, agentPoolId: fields.agentPoolId ?? null, executionMode, name: fields.name,
    description: fields.description === "" ? null : fields.description,
    speculativeEnabled: fields.speculative, triggerDisabled: vcs.triggerDisabled, debuggingMode: fields.attrs["debugging-mode"] === true,
    workingDirectory: fields.workingDirectory ?? null, triggerPatterns: fields.triggerPatterns,
    vcsIdentifier: vcs.vcsIdentifier, vcsServiceProvider: vcs.vcsServiceProvider, vcsBranch: vcs.vcsBranch,
    vcsTagsRegex: vcs.vcsTagsRegex, vcsDisplayIdentifier: vcs.vcsDisplayIdentifier,
    vcsRepositoryHttpUrl: vcs.vcsRepositoryHttpUrl, vcsSparseCheckoutPattern: vcs.vcsSparseCheckoutPattern,
    vcsOAuthTokenId: vcs.vcsOAuthTokenId, vcsGhaInstallationId: vcs.vcsGhaInstallationId,
    createdAt: now, updatedAt: now,
  };
}

function stackExecutionModeError(executionMode: unknown, agentPoolId: string | undefined): string | null {
  if (executionMode !== "remote" && executionMode !== "agent") return "execution-mode must be remote or agent";
  if (executionMode === "agent" && agentPoolId === undefined) return "agent execution requires an agent-pool relationship";
  return null;
}

function stackConfigurationSourceError(source: string, vcsIdentifier: string | null): string | null {
  if (!(source === "manual" || source === "fetch" || source === "reuse")) {
    return "source must be manual, fetch, or reuse";
  }
  if (source === "fetch" && vcsIdentifier === null) {
    return "fetch requires a VCS-backed stack";
  }
  return null;
}

function stackConfigurationAttributes(body: unknown): Record<string, unknown> {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const data = payload["data"];
  return data !== null && typeof data === "object" && (data as Record<string, unknown>)["attributes"] !== null && typeof (data as Record<string, unknown>)["attributes"] === "object"
    ? (data as Record<string, unknown>)["attributes"] as Record<string, unknown>
    : {};
}

function stackConfigurationFlagError(attrs: Record<string, unknown>): string | null {
  for (const key of ["speculative", "destroy-all"] as const) {
    if (attrs[key] !== undefined && typeof attrs[key] !== "boolean") {
      return `${key} must be a boolean`;
    }
  }
  return null;
}

function validateStackConfigurationRequest(source: string, vcsIdentifier: string | null, attrs: Record<string, unknown>): string | null {
  const sourceError = stackConfigurationSourceError(source, vcsIdentifier);
  if (sourceError !== null) return sourceError;
  const flagError = stackConfigurationFlagError(attrs);
  if (flagError !== null) return flagError;
  if (source === "manual" && vcsIdentifier !== null && attrs["speculative"] !== true) {
    return "manual configurations for VCS-backed stacks must be speculative";
  }
  return null;
}

async function loadUploadableRecord(
  recordId: string,
  user: ParamCtx["user"],
  tokenOrgId: string | null | undefined,
  teamId: string | null | undefined,
  request: ParamCtx["request"],
): Promise<{ record: StackRecordItem; recordPayload: Record<string, unknown> } | { error: { status: 404 | 409 } }> {
  const authorized = await authorizedStackRecord(recordId, user, tokenOrgId, teamId, "stack-configurations");
  if (authorized === undefined && !validSignedApiURL(request, `/api/v2/stack-configurations/${recordId}/upload`, "PUT")) {
    return { error: { status: 404 } };
  }
  const record = authorized?.record ?? await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, recordId), eq(stackRecords.recordType, "stack-configurations")) });
  if (record === undefined) return { error: { status: 404 } };
  const recordPayload = record.payload ?? {};
  const existingPath = typeof recordPayload["archivePath"] === "string" ? recordPayload["archivePath"] : null;
  if (record.status !== "pending" || existingPath !== null) return { error: { status: 409 } };
  return { record, recordPayload };
}

async function readUploadBytes(body: unknown, request: ParamCtx["request"]): Promise<Uint8Array> {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array(await request.arrayBuffer());
}

export const stackRoutes = new Elysia({ name: "stacks" })
  .use(authPlugin)
  .post("/api/v2/stacks", async ({ body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload["data"];
    if (data === null || typeof data !== "object") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data is required" }] }; }
    const fields = parseStackCreateFields(data as Record<string, unknown>);
    const { projectId, agentPoolId, executionMode } = fields;
    if (fields.name === "" || projectId === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "name and project are required" }] }; }
    const modeError = stackExecutionModeError(executionMode, agentPoolId);
    if (modeError !== null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: modeError }] }; }
    const authorized = await authorizeStackProject(projectId, agentPoolId, user?.id, tokenOrgId ?? null, teamId ?? null);
    if ("status" in authorized) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const project = authorized.project;
    const vcs = stackVcsRepoAttributes(fields.attrs);
    const vcsError = await validStackVcs(vcs, project.orgId);
    if (vcsError !== null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: vcsError }] }; }
    const id = newResourceId("st");
    const now = Date.now();
    const row = buildStackInsert(id, project.orgId, fields, executionMode as string, vcs, now);
    await db.insert(stacks).values(row);
    (set as { status: number }).status = 201;
    return { data: stackResource(row as StackItem, project.name) };
  })
  .get("/api/v2/stacks/:stack_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params["stack_id"] ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: stackResource(details.stack, details.projectName) };
  })
  .get("/api/v2/organizations/:org_name/stacks", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const rows = await db.query.stacks.findMany({ where: eq(stacks.orgId, org.id) });
    return { data: rows.map((stack): Record<string, unknown> => stackResource(stack, null)) };
  })
  .get("/api/v2/stacks/:stack_id/stack-configuration-summaries", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params["stack_id"] ?? "");
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
    const details = await stackDetails(params["stack_id"] ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const source = new URL(request.url).searchParams.get("source") ?? "manual";
    const attrs = stackConfigurationAttributes(body);
    const requestError = validateStackConfigurationRequest(source, details.stack.vcsIdentifier, attrs);
    if (requestError !== null) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: requestError }] };
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
    const details = await stackDetails(params["stack_id"] ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, details.stack.id), eq(stackRecords.recordType, "stack-configurations")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_configuration_id"] ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-deployment-group-summaries", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_configuration_id"] ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const groups = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-groups")), orderBy: [desc(stackRecords.createdAt)] });
    const summaries = groups.map((group): Record<string, unknown> => ({ id: `sdgs-${group.id.slice(4)}`, type: "stack-deployment-group-summaries", attributes: { name: group.name, status: group.status, "status-counts": { [group.status]: 1 } }, relationships: { "stack-deployment-group": { data: { id: group.id, type: "stack-deployment-groups" } } } }));
    const { number, size } = pageRequest(request);
    return { data: summaries.slice((number - 1) * size, number * size), ...pagination(request, number, size, summaries.length) };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-diagnostics", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_configuration_id"] ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-diagnostics")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/upload-url", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_configuration_id"] ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { "source-upload-url": signedApiURL(request, `/api/v2/stack-configurations/${authorized.record.id}/upload`, "PUT") }, links: { self: `/api/v2/stack-configurations/${authorized.record.id}/upload-url` } };
  })
  .put("/api/v2/stack-configurations/:stack_configuration_id/upload", async ({ params, body, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const recordId = params["stack_configuration_id"] ?? "";
    const loaded = await loadUploadableRecord(recordId, user, tokenOrgId, teamId, request);
    if ("error" in loaded) {
      (set as { status: number }).status = loaded.error.status;
      return { errors: [{ status: String(loaded.error.status), title: loaded.error.status === 404 ? "Not Found" : "Conflict" }] };
    }
    const { record, recordPayload } = loaded;
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 100 * 1024 * 1024) {
      (set as { status: number }).status = 413;
      return { errors: [{ status: "413", title: "Payload Too Large" }] };
    }
    const bytes = await readUploadBytes(body, request);
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
    const authorized = await authorizedStackRecord(params["stack_configuration_id"] ?? "", user, tokenOrgId, teamId, "stack-configurations");
    const archivePath = authorized === undefined ? null : (() => {
      const payload = authorized.record.payload ?? {};
      return typeof payload["archivePath"] === "string" ? payload["archivePath"] : null;
    })();
    if (authorized === undefined || archivePath === null || !isStackStoragePath(archivePath) || !(await Bun.file(archivePath).exists())) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const location = signedApiURL(request, `/api/v2/stack-configurations/${authorized.record.id}/source-bundle/download`, "GET");
    (set.headers as Record<string, string>) ["Location"] = location;
    (set as { status: number }).status = 302;
    return {};
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/source-bundle/download", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const record = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, params["stack_configuration_id"] ?? ""), eq(stackRecords.recordType, "stack-configurations")) });
    const details = record === undefined ? undefined : await stackDetails(record.stackId);
    if (record === undefined || details === undefined || (!(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects")) && !validSignedApiURL(request, `/api/v2/stack-configurations/${record.id}/source-bundle/download`, "GET"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const recordPayload = record.payload ?? {};
    const archivePath = typeof recordPayload["archivePath"] === "string" ? recordPayload["archivePath"] : null;
    if (archivePath === null || !isStackStoragePath(archivePath) || !(await Bun.file(archivePath).exists())) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    (set.headers as Record<string, string>)["Content-Type"] = "application/gzip";
    return Bun.file(archivePath);
  })
  .get("/api/v2/stacks/:stack_id/stack-deployments", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params["stack_id"] ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const groups = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, details.stack.id), eq(stackRecords.recordType, "stack-deployment-groups")), orderBy: [desc(stackRecords.createdAt)] });
    const seen = new Set<string>();
    const deployments = groups.flatMap((group): Record<string, unknown>[] => {
      const name = group.name ?? group.id;
      if (seen.has(name)) return [];
      seen.add(name);
      const run = (group.payload ?? {})["latestRunId"];
      return [{ id: `${details.stack.id}-std-${name}`, type: "stack-deployments", attributes: { name }, relationships: { stack: { data: { id: details.stack.id, type: "stacks" } }, "latest-deployment-run": { data: typeof run === "string" ? { id: run, type: "stack-deployment-runs" } : null } }, links: { self: `/api/v2/stacks/${details.stack.id}/stack-deployments/${encodeURIComponent(name)}`, "stack-deployment-runs": `/api/v2/stacks/${details.stack.id}/stack-deployments/${encodeURIComponent(name)}/stack-deployment-runs` } }];
    });
    const { number, size } = pageRequest(request);
    return { data: deployments.slice((number - 1) * size, number * size), ...pagination(request, number, size, deployments.length) };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-deployment-groups", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_configuration_id"] ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-groups")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-deployment-groups/:stack_deployment_group_name", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_configuration_id"] ?? "", user, tokenOrgId, teamId, "stack-configurations");
    const group = authorized === undefined ? undefined : await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-groups"), eq(stackRecords.name, params["stack_deployment_group_name"] ?? "")) });
    if (group === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(group) };
  })
  .get("/api/v2/stack-deployment-groups/:stack_deployment_group_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_group_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-groups");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-configurations/:stack_configuration_id/stack-deployment-runs", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_configuration_id"] ?? "", user, tokenOrgId, teamId, "stack-configurations");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = (await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, authorized.record.stackId), eq(stackRecords.recordType, "stack-deployment-runs")), orderBy: [desc(stackRecords.createdAt)] })).filter((record) => (record.payload ?? {})["configurationId"] === authorized.record.id);
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-deployment-groups/:stack_deployment_group_id/stack-deployment-runs", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_group_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-groups");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-runs")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-deployment-runs/:stack_deployment_run_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_run_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-runs");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-deployment-runs/:stack_deployment_run_id/stack-deployment-steps", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_run_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-runs");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-steps")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-deployment-steps/:stack_deployment_step_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_step_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-steps");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-deployment-steps/:stack_deployment_step_id/stack-diagnostics", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_step_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-steps");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-diagnostics")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack-deployment-steps/:stack_deployment_step_id/artifacts", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_step_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-steps");
    const name = new URL(request.url).searchParams.get("name") ?? "";
    if (authorized === undefined || !["plan-description", "plan-debug-log", "apply-description", "apply-debug-log"].includes(name)) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const artifact = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-artifacts"), eq(stackRecords.name, name)) });
    const path = (artifact?.payload ?? {})["path"];
    if (typeof path !== "string" || !isStackStoragePath(path) || !(await Bun.file(path).exists())) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return new Response(Bun.file(path), { headers: { "Content-Type": "application/octet-stream" } });
  })
  .get("/api/v2/stack-approvals/:stack_approval_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_approval_id"] ?? "", user, tokenOrgId, teamId, "stack-approvals");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .post("/api/v2/stack-deployment-groups/:stack_deployment_group_id/approve-all-plans", async ({ params, user, body, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_group_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-groups");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    await approveStackRecord(authorized.record, authorized.details.stack.orgId, user?.id ?? null, typeof payload["reason"] === "string" ? payload["reason"] : null);
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stack-deployment-groups/:stack_deployment_group_id/rerun", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_group_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-groups");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const now = Date.now();
    const rerunIds: string[] = [];
    await db.transaction(async (tx): Promise<void> => {
      await tx.update(stackRecords).set({ status: "pending", updatedAt: now }).where(eq(stackRecords.id, authorized.record.id));
      const runs = await tx.query.stackRecords.findMany({
        where: and(eq(stackRecords.parentId, authorized.record.id), eq(stackRecords.recordType, "stack-deployment-runs"), or(eq(stackRecords.status, "failed"), eq(stackRecords.status, "canceled"))),
        columns: { id: true },
      });
      if (runs.length === 0) return;
      const runIds = runs.map((r): string => r.id);
      rerunIds.push(...runIds);
      const steps = await tx.query.stackRecords.findMany({
        where: and(eq(stackRecords.recordType, "stack-deployment-steps"), inArray(stackRecords.parentId, runIds)),
        orderBy: [desc(stackRecords.createdAt)],
      });
      const latestStepByRun = new Map<string, typeof steps[number]>();
      for (const s of steps) {
        if (!latestStepByRun.has(s.parentId ?? "")) latestStepByRun.set(s.parentId ?? "", s);
      }
      for (const run of runs) {
        await tx.update(stackRecords).set({ status: "planning", updatedAt: now }).where(eq(stackRecords.id, run.id));
        const step = latestStepByRun.get(run.id);
        if (step !== undefined) await tx.update(stackRecords).set({ status: "queued", payload: { ...(step.payload ?? {}), error: null }, updatedAt: now }).where(eq(stackRecords.id, step.id));
      }
    });
    for (const runId of rerunIds) {
      await enqueueStackDeployment(runId, authorized.details.stack.orgId, `stack-run:${runId}:rerun:${now}`);
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stack-deployment-runs/:stack_deployment_run_id/approve-all-plans", async ({ params, user, body, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_run_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-runs");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    await approveStackRecord(authorized.record, authorized.details.stack.orgId, user?.id ?? null, typeof payload["reason"] === "string" ? payload["reason"] : null);
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stack-deployment-runs/:stack_deployment_run_id/cancel", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_deployment_run_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-runs");
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
    const authorized = await authorizedStackRecord(params["stack_deployment_step_id"] ?? "", user, tokenOrgId, teamId, "stack-deployment-steps");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.update(stackRecords).set({ status: "completed", updatedAt: Date.now() }).where(eq(stackRecords.id, authorized.record.id));
    if (authorized.record.parentId !== null) await enqueueStackDeployment(authorized.record.parentId, authorized.details.stack.orgId, `stack-run:${authorized.record.parentId}:advance:${authorized.record.id}`);
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/stacks/:stack_id/stack-states", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params["stack_id"] ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, details.stack.id), eq(stackRecords.recordType, "stack-states")), orderBy: [desc(stackRecords.createdAt)] });
    const { data, pagination: page } = pagedStackRecords(records, request);
    return { data, ...page };
  })
  .get("/api/v2/stack_states/:stack_state_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_state_id"] ?? "", user, tokenOrgId, teamId, "stack-states");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-states/:stack_state_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_state_id"] ?? "", user, tokenOrgId, teamId, "stack-states");
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stackRecordResource(authorized.record) };
  })
  .get("/api/v2/stack-states/:stack_state_id/description", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const authorized = await authorizedStackRecord(params["stack_state_id"] ?? "", user, tokenOrgId, teamId, "stack-states");
    const path = (authorized?.record.payload ?? {})["descriptionPath"];
    if (authorized === undefined || typeof path !== "string" || !isStackStoragePath(path) || !(await Bun.file(path).exists())) { (set as { status: number }).status = 204; return {}; }
    const location = signedApiURL(request, `/api/v2/stack-states/${authorized.record.id}/description/download`, "GET");
    (set.headers as Record<string, string>)["Location"] = location;
    (set as { status: number }).status = 307;
    return {};
  })
  .get("/api/v2/stack-states/:stack_state_id/description/download", async ({ params, user, request, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const record = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, params["stack_state_id"] ?? ""), eq(stackRecords.recordType, "stack-states")) });
    const details = record === undefined ? undefined : await stackDetails(record.stackId);
    if (record === undefined || details === undefined || (!(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects")) && !validSignedApiURL(request, `/api/v2/stack-states/${record.id}/description/download`, "GET"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const path = (record.payload ?? {})["descriptionPath"];
    if (typeof path !== "string" || !isStackStoragePath(path) || !(await Bun.file(path).exists())) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return Bun.file(path);
  })
  .patch("/api/v2/stacks/:stack_id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params["stack_id"] ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { attributes, relationships } = parseStackPatchDocument(body);
    const updates: Partial<typeof stacks.$inferInsert> = { updatedAt: Date.now() };
    applyStackScalarUpdates(attributes, updates);
    const vcsError = await applyStackVcsUpdate(attributes, details.stack.orgId, updates);
    if (vcsError !== null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: vcsError }] }; }
    const executionError = await applyStackExecutionUpdates(attributes, relationships, details.stack, details.stack.orgId, updates);
    if (executionError !== null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: executionError }] }; }
    await db.update(stacks).set(updates).where(eq(stacks.id, details.stack.id));
    const updated = await db.query.stacks.findFirst({ where: eq(stacks.id, params["stack_id"] ?? "") });
    return { data: updated === undefined ? undefined : stackResource(updated, details.projectName) };
  })
  .delete("/api/v2/stacks/:stack_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const details = await stackDetails(params["stack_id"] ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(stacks).where(eq(stacks.id, details.stack.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stacks/:stack_id/fetch-latest-from-vcs", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params["stack_id"] ?? "");
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
