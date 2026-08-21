import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations, runs, stateVersions, workspaces } from "../../src/db/schema";
import { enqueueDueAutoDestroyRuns } from "../../src/worker";
import { isMaintenanceActive } from "../../src/lib/maintenance";

const NOW = Date.parse("2030-01-15T12:00:00.000Z");
let orgId = "";

async function waitIfMaintenanceActive(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (isMaintenanceActive() && Date.now() < deadline) {
    await Bun.sleep(100);
  }
}

async function enqueueWithMaintenanceWait(now = Date.now()): Promise<string[]> {
  await waitIfMaintenanceActive();
  return enqueueDueAutoDestroyRuns(now);
}

async function createWorkspace(
  attributes: Partial<typeof workspaces.$inferInsert>,
): Promise<string> {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  await db.insert(workspaces).values({
    id: workspaceId,
    orgId,
    name: workspaceId,
    createdAt: NOW - (10 * 86_400_000),
    ...attributes,
  });
  return workspaceId;
}

describe("automatic workspace destruction scheduler", () => {
  beforeEach(async () => {
    await waitIfMaintenanceActive();
    orgId = `org-${crypto.randomUUID()}`;
    await db.insert(organizations).values({ id: orgId, name: orgId });
  });

  afterEach(async () => {
    const wsList = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, orgId) });
    const wsIds = wsList.map((w) => w.id);
    if (wsIds.length > 0) {
      await db.delete(runs).where(inArray(runs.workspaceId, wsIds));
      await db.delete(stateVersions).where(inArray(stateVersions.workspaceId, wsIds));
      await db.delete(workspaces).where(inArray(workspaces.id, wsIds));
    }
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("queues and auto-approves a due scheduled destroy exactly once", async () => {
    const workspaceId = await createWorkspace({
      autoDestroyAt: new Date(NOW - 1_000).toISOString(),
    });
    void (await enqueueWithMaintenanceWait(NOW));
    const ourRun = await db.query.runs.findFirst({ where: eq(runs.workspaceId, workspaceId) });
    expect(ourRun).toBeDefined();
    expect(ourRun).toMatchObject({
      workspaceId,
      status: "pending",
      isDestroy: true,
      autoApply: true,
      message: "[auto-destroy] Scheduled workspace destruction",
    });
    expect((await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    }))?.autoDestroyAt).toBeNull();
    await enqueueWithMaintenanceWait(NOW + 1_000);
    const runsList = await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) });
    expect(runsList).toHaveLength(1);
  });

  test("uses finalized state activity and retains inactivity scheduling", async () => {
    const workspaceId = await createWorkspace({ autoDestroyActivityDuration: "2h" });
    await db.insert(stateVersions).values({
      id: `sv-${crypto.randomUUID()}`,
      workspaceId,
      serial: 1,
      status: "finalized",
      statePayload: "{}",
      createdAt: NOW - (3 * 3_600_000),
    });
    void (await enqueueWithMaintenanceWait(NOW));
    const ourRun = await db.query.runs.findFirst({ where: eq(runs.workspaceId, workspaceId) });
    expect(ourRun).toBeDefined();
    expect((await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    }))?.autoDestroyActivityDuration).toBe("2h");

    if (ourRun) await db.update(runs).set({ status: "applied" }).where(eq(runs.id, ourRun.id));
    await enqueueWithMaintenanceWait(NOW + 3_600_000);
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).toHaveLength(1);
    await enqueueWithMaintenanceWait(NOW + (3 * 3_600_000));
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).toHaveLength(2);
  });

  test("does not queue for recent activity, invalid duration, locks, or an active run", async () => {
    const recentId = await createWorkspace({ autoDestroyActivityDuration: "2h" });
    await db.insert(stateVersions).values({
      id: `sv-${crypto.randomUUID()}`,
      workspaceId: recentId,
      serial: 1,
      status: "finalized",
      statePayload: "{}",
      createdAt: NOW - 3_600_000,
    });
    await createWorkspace({ autoDestroyActivityDuration: "forever" });
    await createWorkspace({
      autoDestroyAt: new Date(NOW - 1_000).toISOString(),
      locked: true,
    });
    const activeId = await createWorkspace({
      autoDestroyAt: new Date(NOW - 1_000).toISOString(),
    });
    await db.insert(runs).values({
      id: `run-${crypto.randomUUID()}`,
      workspaceId: activeId,
      status: "planning",
      createdAt: NOW - 1_000,
    });
    await enqueueWithMaintenanceWait(NOW);
    const recentRuns = await db.query.runs.findMany({ where: eq(runs.workspaceId, recentId) });
    expect(recentRuns).toHaveLength(0);
  });
});
