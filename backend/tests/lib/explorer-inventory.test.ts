import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
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
} from "../../src/db/schema";
import { ensureExplorerInventory, runExplorerCatalogJob } from "../../src/lib/explorer-inventory";

describe("Explorer inventory batch loading", () => {
  const orgId = `explorer-inventory-batch-org-${crypto.randomUUID()}`;
  const projectId = `explorer-inventory-batch-project-${crypto.randomUUID()}`;
  const workspaceIds = Array.from({ length: 120 }, (): string => `explorer-inventory-batch-workspace-${crypto.randomUUID()}`);

  beforeAll(async (): Promise<void> => {
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(projects).values({ id: projectId, orgId, name: "Batch project" });
    await db.insert(workspaces).values(workspaceIds.map((id): typeof workspaces.$inferInsert => ({
      id,
      orgId,
      projectId,
      name: id,
      terraformVersion: "1.8.0",
    })));
  });

  afterAll(async (): Promise<void> => {
    await db.delete(explorerCatalogMemberships).where(inArray(explorerCatalogMemberships.workspaceId, workspaceIds));
    await db.delete(explorerWorkspaceInventory).where(inArray(explorerWorkspaceInventory.workspaceId, workspaceIds));
    await db.delete(noCodeWorkspaceConfigurations).where(inArray(noCodeWorkspaceConfigurations.workspaceId, workspaceIds));
    await db.delete(workspaceTags).where(inArray(workspaceTags.workspaceId, workspaceIds));
    await db.delete(assessmentResults).where(inArray(assessmentResults.workspaceId, workspaceIds));
    await db.delete(runs).where(inArray(runs.workspaceId, workspaceIds));
    await db.delete(stateVersions).where(inArray(stateVersions.workspaceId, workspaceIds));
    await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("loads a representative organization without per-workspace relation queries", async (): Promise<void> => {
    const workspaceFindFirst = spyOn(db.query.workspaces, "findFirst");
    const organizationFindFirst = spyOn(db.query.organizations, "findFirst");
    const projectFindFirst = spyOn(db.query.projects, "findFirst");
    const stateFindFirst = spyOn(db.query.stateVersions, "findFirst");
    const runFindFirst = spyOn(db.query.runs, "findFirst");
    const assessmentFindFirst = spyOn(db.query.assessmentResults, "findFirst");
    const tagFindMany = spyOn(db.query.workspaceTags, "findMany");
    const noCodeFindFirst = spyOn(db.query.noCodeWorkspaceConfigurations, "findFirst");
    const batchRelationSpies = [
      spyOn(db.query.organizations, "findMany"),
      spyOn(db.query.projects, "findMany"),
      spyOn(db.query.stateVersions, "findMany"),
      spyOn(db.query.runs, "findMany"),
      spyOn(db.query.assessmentResults, "findMany"),
      spyOn(db.query.noCodeWorkspaceConfigurations, "findMany"),
    ];
    let singleItemCalls: number[] = [];
    let batchRelationCalls = 0;

    try {
      await ensureExplorerInventory(orgId);
      singleItemCalls = [
        workspaceFindFirst.mock.calls.length,
        organizationFindFirst.mock.calls.length,
        projectFindFirst.mock.calls.length,
        stateFindFirst.mock.calls.length,
        runFindFirst.mock.calls.length,
        assessmentFindFirst.mock.calls.length,
        noCodeFindFirst.mock.calls.length,
      ];
      batchRelationCalls = batchRelationSpies.reduce((total, spy): number => total + spy.mock.calls.length, tagFindMany.mock.calls.length);
    } finally {
      workspaceFindFirst.mockRestore();
      organizationFindFirst.mockRestore();
      projectFindFirst.mockRestore();
      stateFindFirst.mockRestore();
      runFindFirst.mockRestore();
      assessmentFindFirst.mockRestore();
      tagFindMany.mockRestore();
      noCodeFindFirst.mockRestore();
      for (const spy of batchRelationSpies) spy.mockRestore();
    }

    expect(singleItemCalls).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(batchRelationCalls).toBeLessThanOrEqual(14);

    const inventory = await db.query.explorerWorkspaceInventory.findMany({
      where: eq(explorerWorkspaceInventory.orgId, orgId),
    });
    expect(inventory).toHaveLength(workspaceIds.length);
    expect(new Set(inventory.map((row): string => row.workspaceId))).toEqual(new Set(workspaceIds));

    const memberships = await db.query.explorerCatalogMemberships.findMany({
      where: eq(explorerCatalogMemberships.orgId, orgId),
    });
    expect(memberships).toHaveLength(workspaceIds.length);
  });

  test("durable backfill uses the same batch relation loader", async (): Promise<void> => {
    await db.delete(explorerCatalogMemberships).where(inArray(explorerCatalogMemberships.workspaceId, workspaceIds));
    await db.delete(explorerWorkspaceInventory).where(inArray(explorerWorkspaceInventory.workspaceId, workspaceIds));

    const workspaceFindFirst = spyOn(db.query.workspaces, "findFirst");
    const organizationFindFirst = spyOn(db.query.organizations, "findFirst");
    const projectFindFirst = spyOn(db.query.projects, "findFirst");
    const stateFindFirst = spyOn(db.query.stateVersions, "findFirst");
    const runFindFirst = spyOn(db.query.runs, "findFirst");
    const assessmentFindFirst = spyOn(db.query.assessmentResults, "findFirst");
    const tagFindMany = spyOn(db.query.workspaceTags, "findMany");
    const noCodeFindFirst = spyOn(db.query.noCodeWorkspaceConfigurations, "findFirst");
    const batchRelationSpies = [
      spyOn(db.query.organizations, "findMany"),
      spyOn(db.query.projects, "findMany"),
      spyOn(db.query.stateVersions, "findMany"),
      spyOn(db.query.runs, "findMany"),
      spyOn(db.query.assessmentResults, "findMany"),
      spyOn(db.query.noCodeWorkspaceConfigurations, "findMany"),
    ];
    let singleItemCalls: number[] = [];
    let batchRelationCalls = 0;

    try {
      await runExplorerCatalogJob(
        { payload: { orgId, backfill: true } } as unknown as Parameters<typeof runExplorerCatalogJob>[0],
        { canceled: async (): Promise<boolean> => false, heartbeat: async (): Promise<boolean> => true },
      );
      singleItemCalls = [
        workspaceFindFirst.mock.calls.length,
        organizationFindFirst.mock.calls.length,
        projectFindFirst.mock.calls.length,
        stateFindFirst.mock.calls.length,
        runFindFirst.mock.calls.length,
        assessmentFindFirst.mock.calls.length,
        noCodeFindFirst.mock.calls.length,
      ];
      batchRelationCalls = batchRelationSpies.reduce((total, spy): number => total + spy.mock.calls.length, tagFindMany.mock.calls.length);
    } finally {
      workspaceFindFirst.mockRestore();
      organizationFindFirst.mockRestore();
      projectFindFirst.mockRestore();
      stateFindFirst.mockRestore();
      runFindFirst.mockRestore();
      assessmentFindFirst.mockRestore();
      tagFindMany.mockRestore();
      noCodeFindFirst.mockRestore();
      for (const spy of batchRelationSpies) spy.mockRestore();
    }

    expect(singleItemCalls).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(batchRelationCalls).toBeLessThanOrEqual(14);

    const inventory = await db.query.explorerWorkspaceInventory.findMany({
      where: eq(explorerWorkspaceInventory.orgId, orgId),
    });
    expect(inventory).toHaveLength(workspaceIds.length);
  });
});
