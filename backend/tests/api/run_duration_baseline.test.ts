import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "../../src/db";
import { runs, workspaces, organizations, users, apiTokens, organizationMemberships } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { runDurationBaseline } from "../../src/routes/runs";

describe("run duration baseline (kanban 15.12)", () => {
  const orgName = `baseline-${Date.now()}`;
  let orgId = "";
  let workspaceId = "";

  beforeAll(async () => {
    await db.delete(runs);
    await db.delete(workspaces);
    await db.delete(organizationMemberships);
    await db.delete(apiTokens);
    await db.delete(users);
    await db.delete(organizations);
    const org = await db.insert(organizations).values({
      id: `org-${orgName}`,
      name: orgName,
      email: "ops@example.com",
    }).returning();
    orgId = org[0]!.id;
    const ws = await db.insert(workspaces).values({
      id: `ws-baseline`,
      name: "baseline-workspace",
      orgId,
      autoApply: false,
    }).returning();
    workspaceId = ws[0]!.id;
  });

  afterAll(async () => {
    await db.delete(runs);
    await db.delete(workspaces);
    await db.delete(organizations);
  });

  function insertRun(overrides: Partial<typeof runs.$inferInsert>): Promise<[{ id: string }]> {
    return db.insert(runs).values({
      id: `run-${Math.random().toString(36).slice(2, 10)}`,
      workspaceId,
      status: "applied",
      message: "baseline run",
      createdAt: Date.now(),
      ...overrides,
    }).returning({ id: runs.id });
  }

  it("returns null when the run has no terminal timestamps", async () => {
    const [run] = await insertRun({ statusTimestamps: { "pending-at": "2026-01-01T00:00:00Z" } });
    const row = await db.query.runs.findFirst({ where: eq(runs.id, run.id) });
    expect(row).toBeDefined();
    const baseline = await runDurationBaseline(row!);
    expect(baseline).toBeNull();
  });

  it("returns null with fewer than 3 comparable runs", async () => {
    const [run] = await insertRun({
      statusTimestamps: {
        "planned-at": "2026-01-01T00:00:00Z",
        "applied-at": "2026-01-01T00:05:00Z",
      },
    });
    const row = await db.query.runs.findFirst({ where: eq(runs.id, run.id) });
    // No comparable history in this workspace yet.
    const baseline = await runDurationBaseline(row!);
    expect(baseline).toBeNull();
  });

  it("flags a run that is more than 2x the median of recent runs", async () => {
    // Seed 5 comparable runs of ~60s.
    for (let i = 0; i < 5; i++) {
      await insertRun({
        statusTimestamps: {
          "planned-at": "2026-02-01T00:00:00Z",
          "applied-at": "2026-02-01T00:01:00Z",
        },
      });
    }
    // This run takes 10 minutes: median 60s, so >2x.
    const [slow] = await insertRun({
      statusTimestamps: {
        "planned-at": "2026-02-02T00:00:00Z",
        "applied-at": "2026-02-02T00:10:00Z",
      },
    });
    const slowRow = await db.query.runs.findFirst({ where: eq(runs.id, slow.id) });
    const baseline = await runDurationBaseline(slowRow!);
    expect(baseline).not.toBeNull();
    expect(baseline!["median-duration-seconds"]).toBe(60);
    expect(baseline!["duration-seconds"]).toBe(600);
    expect(baseline!["is-slow"]).toBe(true);

    // A normal 60s run is not slow.
    const [normal] = await insertRun({
      statusTimestamps: {
        "planned-at": "2026-02-03T00:00:00Z",
        "applied-at": "2026-02-03T00:01:00Z",
      },
    });
    const normalRow = await db.query.runs.findFirst({ where: eq(runs.id, normal.id) });
    const normalBaseline = await runDurationBaseline(normalRow!);
    expect(normalBaseline).not.toBeNull();
    expect(normalBaseline!["is-slow"]).toBe(false);
  });
});