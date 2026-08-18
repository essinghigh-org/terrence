import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations, runs, stateVersions, workspaces } from "../../src/db/schema";
import { enqueueDueAutoDestroyRuns } from "../../src/worker";

const NOW = Date.parse("2030-01-15T12:00:00.000Z");
let orgId = "";

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
    orgId = `org-${crypto.randomUUID()}`;
    await db.insert(organizations).values({ id: orgId, name: orgId });
  });

  afterEach(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("queues and auto-approves a due scheduled destroy exactly once", async () => {
    const workspaceId = await createWorkspace({
      autoDestroyAt: new Date(NOW - 1_000).toISOString(),
    });
    const created = await enqueueDueAutoDestroyRuns(NOW);
    expect(created).toHaveLength(1);
    expect(await db.query.runs.findFirst({ where: eq(runs.id, created[0] ?? "") })).toMatchObject({
      workspaceId,
      status: "pending",
      isDestroy: true,
      autoApply: true,
      message: "[auto-destroy] Scheduled workspace destruction",
    });
    expect((await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    }))?.autoDestroyAt).toBeNull();
    expect(await enqueueDueAutoDestroyRuns(NOW + 1_000)).toHaveLength(0);
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
    const first = await enqueueDueAutoDestroyRuns(NOW);
    expect(first).toHaveLength(1);
    expect((await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    }))?.autoDestroyActivityDuration).toBe("2h");

    await db.update(runs).set({ status: "applied" }).where(eq(runs.id, first[0] ?? ""));
    expect(await enqueueDueAutoDestroyRuns(NOW + 3_600_000)).toHaveLength(0);
    expect(await enqueueDueAutoDestroyRuns(NOW + (3 * 3_600_000))).toHaveLength(1);
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
    expect(await enqueueDueAutoDestroyRuns(NOW)).toHaveLength(0);
  });
});
