import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations, runs, workspaces } from "../../src/db/schema";
import { applyDueScheduledRuns } from "../../src/worker";

let orgId = "";
let workspaceIds: string[] = [];
let runIds: string[] = [];

describe("scheduled apply workspace loading", () => {
  beforeEach(async (): Promise<void> => {
    orgId = `org-scheduled-apply-${crypto.randomUUID()}`;
    workspaceIds = Array.from({ length: 3 }, (): string => `ws-scheduled-apply-${crypto.randomUUID()}`);
    runIds = workspaceIds.map((workspaceId): string => `run-scheduled-apply-${workspaceId}`);
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(workspaces).values(workspaceIds.map((id): typeof workspaces.$inferInsert => ({
      id,
      orgId,
      name: id,
      locked: true,
    })));
    await db.insert(runs).values(runIds.map((id, index): typeof runs.$inferInsert => ({
      id,
      workspaceId: workspaceIds[index]!,
      status: "confirmed",
      planOnly: false,
      scheduledAt: Date.now() - 1_000,
      createdAt: Date.now() - 2_000,
    })));
  });

  afterEach(async (): Promise<void> => {
    await db.delete(runs).where(inArray(runs.id, runIds));
    await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("loads all due-run workspaces in one relation query", async (): Promise<void> => {
    const workspaceFindMany = spyOn(db.query.workspaces, "findMany");
    const workspaceFindFirst = spyOn(db.query.workspaces, "findFirst");
    let result: string[] = [];
    let workspaceManyCalls = 0;
    let workspaceFirstCalls = 0;
    let loadedWorkspaceIds: string[] = [];
    try {
      result = await applyDueScheduledRuns();
      workspaceManyCalls = workspaceFindMany.mock.calls.length;
      workspaceFirstCalls = workspaceFindFirst.mock.calls.length;
      const workspaceQueryResult = workspaceFindMany.mock.results[0]?.value as Promise<readonly { id: string }[]> | undefined;
      if (workspaceQueryResult !== undefined) {
        loadedWorkspaceIds = (await workspaceQueryResult).map((workspace): string => workspace.id);
      }
    } finally {
      workspaceFindMany.mockRestore();
      workspaceFindFirst.mockRestore();
    }

    expect(result).toEqual([]);
    expect(workspaceManyCalls).toBe(1);
    expect(workspaceFirstCalls).toBe(0);
    expect(new Set(loadedWorkspaceIds)).toEqual(new Set(workspaceIds));
    const statuses = await db.query.runs.findMany({
      where: inArray(runs.id, runIds),
      columns: { status: true },
    });
    expect(statuses).toHaveLength(runIds.length);
    expect(statuses.every((run): boolean => run.status === "confirmed")).toBe(true);
  });
});
