import { and, asc, count, countDistinct, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  assessmentResults,
  explorerCatalogMemberships,
  explorerWorkspaceInventory,
  noCodeWorkspaceConfigurations,
  organizations,
  projects,
  runs,
  stateVersions,
  workspaceTags,
  workspaces,
  type durableJobs,
} from "../db/schema";
import { enqueueDurableJob, type DurableJobContext } from "./durable-jobs";
import { log } from "./log";
import { decodeStatePayload } from "./validation";

export type ExplorerCatalogItem = Readonly<{ name: string; source: string; version: string }>;
type Job = Readonly<typeof durableJobs.$inferSelect>;
const MEMBERSHIP_BATCH_SIZE = 100;

async function insertMemberships(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], memberships: readonly (typeof explorerCatalogMemberships.$inferInsert)[]): Promise<void> {
  for (let index = 0; index < memberships.length; index += MEMBERSHIP_BATCH_SIZE) {
    const batch = memberships.slice(index, index + MEMBERSHIP_BATCH_SIZE);
    if (batch.length > 0) await tx.insert(explorerCatalogMemberships).values(batch);
  }
}

function parseStateResources(jsonState: string | null): unknown[] | undefined {
  try {
    const parsed = jsonState === null ? undefined : JSON.parse(decodeStatePayload(jsonState)) as Record<string, unknown>;
    const rawResources = parsed?.resources;
    return Array.isArray(rawResources) ? rawResources : undefined;
  } catch {
    return undefined;
  }
}

function stateItems(jsonState: string | null): Readonly<{ resources: number; providers: string[]; modules: string[]; providerItems: ExplorerCatalogItem[]; moduleItems: ExplorerCatalogItem[] }> {
  const providers = new Map<string, ExplorerCatalogItem>();
  const modules = new Map<string, ExplorerCatalogItem>();
  let resources = 0;
  const rawResources = parseStateResources(jsonState);
  if (rawResources === undefined) return { resources, providers: [], modules: [], providerItems: [], moduleItems: [] };
  for (const raw of rawResources) {
    if (raw === null || typeof raw !== "object") continue;
    const resource = raw as Record<string, unknown>;
    resources += Array.isArray(resource.instances) ? resource.instances.length : 0;
    const provider = typeof resource.provider === "string" ? resource.provider.replace(/^provider\[\"|\"\]$/g, "") : "";
    if (provider !== "") {
      const name = provider.split("/").at(-1) ?? provider;
      const version = typeof resource.provider_version === "string" ? resource.provider_version : "";
      providers.set(`${name}|${provider}|${version}`, { name, source: provider, version });
    }
    const module = typeof resource.module === "string" ? resource.module : "";
    if (module !== "" && module !== "root") modules.set(`${module}|${module}`, { name: module, source: module, version: "" });
  }
  const providerItems = [...providers.values()].sort((a, b) => a.source.localeCompare(b.source));
  const moduleItems = [...modules.values()].sort((a, b) => a.source.localeCompare(b.source));
  return { resources, providers: providerItems.map((item) => item.source), modules: moduleItems.map((item) => item.source), providerItems, moduleItems };
}

function jsonItems(value: string): ExplorerCatalogItem[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is ExplorerCatalogItem => item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string" && typeof (item as Record<string, unknown>).source === "string" && typeof (item as Record<string, unknown>).version === "string") : [];
  } catch {
    return [];
  }
}

type ExplorerInventoryCatalogRow = Readonly<{
  orgId: string;
  workspaceId: string;
  workspaceName: string;
  terraformVersion?: string | null | undefined;
  providerItems?: string | undefined;
  moduleItems?: string | undefined;
}>;

function membershipRows(row: ExplorerInventoryCatalogRow): typeof explorerCatalogMemberships.$inferInsert[] {
  const now = Date.now();
  const items: Readonly<{ kind: string; item: ExplorerCatalogItem }>[] = [
    { kind: "tf_versions", item: { name: row.terraformVersion ?? "latest", source: "", version: row.terraformVersion ?? "latest" } },
    ...jsonItems(row.providerItems ?? "[]").map((item): Readonly<{ kind: string; item: ExplorerCatalogItem }> => ({ kind: "providers", item })),
    ...jsonItems(row.moduleItems ?? "[]").map((item): Readonly<{ kind: string; item: ExplorerCatalogItem }> => ({ kind: "modules", item })),
  ];
  return items.map(({ kind, item }): typeof explorerCatalogMemberships.$inferInsert => ({
    id: `ecm-${crypto.randomUUID()}`,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    kind,
    name: item.name,
    source: item.source,
    version: item.version,
    updatedAt: now,
  }));
}

export async function refreshExplorerWorkspace(workspaceId: string, rebuild = true): Promise<void> {
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (workspace === undefined) return;
  const [organization, project, state, run, assessment, tags, noCode] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) }),
    workspace.projectId === null ? Promise.resolve(undefined) : db.query.projects.findFirst({ where: eq(projects.id, workspace.projectId) }),
    db.query.stateVersions.findFirst({ where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized"), eq(stateVersions.intermediate, false)), orderBy: [desc(stateVersions.serial)] }),
    db.query.runs.findFirst({ where: eq(runs.workspaceId, workspace.id), orderBy: [desc(runs.createdAt)] }),
    db.query.assessmentResults.findFirst({ where: eq(assessmentResults.workspaceId, workspace.id), orderBy: [desc(assessmentResults.createdAt)] }),
    db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspace.id), columns: { key: true } }),
    db.query.noCodeWorkspaceConfigurations.findFirst({ where: eq(noCodeWorkspaceConfigurations.workspaceId, workspace.id) }),
  ]);
  const items = stateItems(state?.jsonState ?? null);
  const repo = typeof workspace.vcsRepo === "object" && workspace.vcsRepo !== null ? workspace.vcsRepo as Record<string, unknown> : {};
  const now = Date.now();
  const row: typeof explorerWorkspaceInventory.$inferInsert = {
    workspaceId: workspace.id,
    orgId: workspace.orgId,
    workspaceName: workspace.name,
    workspaceCreatedAt: workspace.createdAt ?? now,
    workspaceUpdatedAt: workspace.updatedAt ?? now,
    terraformVersion: workspace.terraformVersion,
    executionMode: workspace.executionMode,
    vcsRepoIdentifier: typeof repo.identifier === "string" ? repo.identifier : null,
    sourceModuleId: noCode?.noCodeModuleId ?? null,
    projectId: workspace.projectId,
    projectName: project?.name ?? "Default Project",
    currentRunStatus: run?.status ?? null,
    currentRunAppliedAt: run?.appliedAt ?? null,
    currentRunExternalId: run?.id ?? null,
    currentResourceCount: items.resources,
    drifted: assessment?.drifted ?? null,
    resourcesDrifted: assessment?.resourcesDrifted ?? 0,
    resourcesUndrifted: assessment?.resourcesUndrifted ?? 0,
    allChecksSucceeded: assessment?.allChecksSucceeded ?? null,
    checksPassed: assessment?.checksPassed ?? 0,
    checksFailed: assessment?.checksFailed ?? 0,
    checksErrored: assessment?.checksErrored ?? 0,
    checksUnknown: assessment?.checksUnknown ?? 0,
    tags: tags.map((tag) => tag.key).sort().join(", "),
    providers: items.providers.join(", "),
    modules: items.modules.join(", "),
    providerItems: JSON.stringify(items.providerItems),
    moduleItems: JSON.stringify(items.moduleItems),
    providerCount: items.providerItems.length,
    moduleCount: items.moduleItems.length,
    stateVersionTerraformVersion: state?.terraformVersion ?? workspace.terraformVersion,
    stateSerial: state?.serial ?? null,
    updatedAt: now,
  };
  await db.transaction(async (tx): Promise<void> => {
    await tx.insert(explorerWorkspaceInventory).values(row).onConflictDoUpdate({
      target: explorerWorkspaceInventory.workspaceId,
      set: row,
    });
    await tx.delete(explorerCatalogMemberships).where(eq(explorerCatalogMemberships.workspaceId, row.workspaceId));
    const memberships = membershipRows(row);
    await insertMemberships(tx, memberships);
  });
  if (organization !== undefined && rebuild) scheduleExplorerCatalog(organization.id);
}

export async function rebuildExplorerCatalog(orgId: string, context?: DurableJobContext): Promise<void> {
  // Backfill membership rows by workspace keyset. Reads do not need this job
  // to materialize an organization-sized map; the indexed membership relation
  // is the source for paged catalog queries.
  let cursor = "";
  for (;;) {
    if (context !== undefined && await context.canceled()) return;
    const rows = await db.query.explorerWorkspaceInventory.findMany({
      where: and(eq(explorerWorkspaceInventory.orgId, orgId), cursor === "" ? undefined : gt(explorerWorkspaceInventory.workspaceId, cursor)),
      orderBy: [asc(explorerWorkspaceInventory.workspaceId)],
      limit: 200,
    });
    if (rows.length === 0) break;
    const workspaceIds = rows.map((row) => row.workspaceId);
    await db.transaction(async (tx): Promise<void> => {
      await tx.delete(explorerCatalogMemberships).where(inArray(explorerCatalogMemberships.workspaceId, workspaceIds));
      const memberships = rows.flatMap(membershipRows);
      await insertMemberships(tx, memberships);
    });
    cursor = rows[rows.length - 1]?.workspaceId ?? cursor;
    if (context !== undefined) await context.heartbeat();
    if (rows.length < 200) break;
  }
}

async function backfillExplorerInventory(orgId: string, context: DurableJobContext): Promise<void> {
  let cursor = "";
  for (;;) {
    if (await context.canceled()) return;
    const page = await db.query.workspaces.findMany({
      where: and(eq(workspaces.orgId, orgId), cursor === "" ? undefined : gt(workspaces.id, cursor)),
      columns: { id: true },
      orderBy: [asc(workspaces.id)],
      limit: 200,
    });
    if (page.length === 0) break;
    const ids = page.map((workspace) => workspace.id);
    const inventory = await db.query.explorerWorkspaceInventory.findMany({ where: inArray(explorerWorkspaceInventory.workspaceId, ids), columns: { workspaceId: true } });
    const existing = new Set(inventory.map((row) => row.workspaceId));
    const missing = page.filter((workspace) => !existing.has(workspace.id));
    for (let index = 0; index < missing.length; index += 25) {
      if (await context.canceled()) return;
      await Promise.all(missing.slice(index, index + 25).map(async (workspace) => refreshExplorerWorkspace(workspace.id, false)));
    }
    cursor = page[page.length - 1]?.id ?? cursor;
    await context.heartbeat();
    if (page.length < 200) break;
  }
  await rebuildExplorerCatalog(orgId, context);
}

export async function enqueueExplorerInventory(workspaceId: string): Promise<void> {
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { orgId: true } });
  if (workspace === undefined) return;
  await enqueueDurableJob("explorer-inventory", { workspaceId }, { dedupeKey: workspaceId });
}

export async function enqueueExplorerCatalog(orgId: string): Promise<void> {
  await enqueueDurableJob("explorer-catalog", { orgId }, { dedupeKey: `catalog:${orgId}` });
}

export function scheduleExplorerCatalog(orgId: string): void {
  void enqueueExplorerCatalog(orgId).catch((error: unknown): void => {
    log.warn("Failed to queue Explorer catalog", { orgId, error: String(error) });
  });
}

export function scheduleExplorerInventory(workspaceId: string): void {
  void enqueueExplorerInventory(workspaceId).catch((error: unknown): void => {
    log.warn("Failed to queue Explorer inventory", { workspaceId, error: String(error) });
  });
}

export async function runExplorerInventoryJob(job: Job, context: DurableJobContext): Promise<void> {
  const workspaceId = job.payload.workspaceId;
  if (typeof workspaceId !== "string") throw new Error("explorer-inventory job is missing workspaceId");
  if (await context.canceled()) return;
  await refreshExplorerWorkspace(workspaceId);
}

export async function runExplorerCatalogJob(job: Job, context: DurableJobContext): Promise<void> {
  const orgId = job.payload.orgId;
  if (typeof orgId !== "string") throw new Error("explorer-catalog job is missing orgId");
  if (await context.canceled()) return;
  if (job.payload.backfill === true) await backfillExplorerInventory(orgId, context);
  else await rebuildExplorerCatalog(orgId, context);
}

export async function ensureExplorerInventory(orgId: string): Promise<void> {
  const [workspaceCount, inventoryCount, membershipCount] = await Promise.all([
    db.select({ total: count() }).from(workspaces).where(eq(workspaces.orgId, orgId)),
    db.select({ total: count() }).from(explorerWorkspaceInventory).where(eq(explorerWorkspaceInventory.orgId, orgId)),
    db.select({ total: countDistinct(explorerCatalogMemberships.workspaceId) }).from(explorerCatalogMemberships).where(eq(explorerCatalogMemberships.orgId, orgId)),
  ]);
  const workspaceTotal = workspaceCount[0]?.total ?? 0;
  if (workspaceTotal === (inventoryCount[0]?.total ?? 0) && (workspaceTotal === 0 || (membershipCount[0]?.total ?? 0) > 0)) return;
  if (workspaceTotal === (inventoryCount[0]?.total ?? 0)) {
    if (workspaceTotal <= 1000) await rebuildExplorerCatalog(orgId);
    else await enqueueDurableJob("explorer-catalog", { orgId }, { dedupeKey: `catalog:${orgId}` });
    return;
  }
  if (workspaceTotal <= 1000) {
    const workspacesInOrg = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, orgId), columns: { id: true } });
    const inventory = await db.query.explorerWorkspaceInventory.findMany({ where: eq(explorerWorkspaceInventory.orgId, orgId), columns: { workspaceId: true } });
    const existing = new Set(inventory.map((row) => row.workspaceId));
    const missing = workspacesInOrg.filter((workspace) => !existing.has(workspace.id));
    const batchSize = 25;
    for (let index = 0; index < missing.length; index += batchSize) {
      await Promise.all(missing.slice(index, index + batchSize).map(async (workspace) => refreshExplorerWorkspace(workspace.id, false)));
    }
    await rebuildExplorerCatalog(orgId);
    return;
  }
  // ponytail: large first-read backfills are durable and keyset-paged; the
  // separate dedupe key keeps repeated reads from multiplying work.
  await enqueueDurableJob("explorer-catalog", { orgId, backfill: true }, { dedupeKey: `catalog-backfill:${orgId}` });
}
