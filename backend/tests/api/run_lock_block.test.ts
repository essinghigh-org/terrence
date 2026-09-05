import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, logs, organizationMemberships, organizations, runs, users, workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { and, eq } from "drizzle-orm";
import { clearPlanLockLoggedForTests } from "../../src/worker";

// Issue #575: a lock acquired after run creation must not park the run
// silently. The queue pollers log the block (throttled) naming the reason.
describe("locked workspaces surface blocked runs (#575)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const userId = `usr-lockblk-${suffix}`;
  const orgId = `org-lockblk-${suffix}`;
  const orgName = `lockblk-${suffix}`;
  const token = `token-lockblk-${suffix}`;
  const wsId = `ws-lockblk-${suffix}`;
  const pendingRunId = `run-lockblk-pending-${suffix}`;
  const confirmedRunId = `run-lockblk-confirmed-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const logText = async (runId: string, phase: "plan" | "apply"): Promise<string> => {
    const rows = await db.query.logs.findMany({
      where: and(eq(logs.runId, runId), eq(logs.phase, phase)),
    });
    return rows.map((row): string => row.outputText).join("\n");
  };

  beforeAll(async () => {
    clearPlanLockLoggedForTests();
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(workspaces).values([
      { id: wsId, name: `lockblk-ws-${suffix}`, orgId, executionMode: "remote" },
    ]);
    await db.insert(runs).values([
      {
        id: pendingRunId, workspaceId: wsId, status: "pending",
        logToken: crypto.randomUUID(), createdAt: Date.now(),
      },
      {
        id: confirmedRunId, workspaceId: wsId, status: "confirmed",
        scheduledAt: Date.now() - 1000, logToken: crypto.randomUUID(), createdAt: Date.now(),
      },
    ]);
    const lockRes = await request(`/api/v2/workspaces/${wsId}/actions/lock`, "POST", {
      data: { attributes: { reason: "deploy freeze" } },
    });
    expect(lockRes.status).toBe(200);
  });

  afterAll(async () => {
    await db.delete(logs).where(eq(logs.runId, pendingRunId)).catch((): void => {});
    await db.delete(logs).where(eq(logs.runId, confirmedRunId)).catch((): void => {});
    await db.delete(runs).where(eq(runs.workspaceId, wsId)).catch((): void => {});
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId)).catch((): void => {});
    await db.delete(apiTokens).where(eq(apiTokens.id, `tok-${suffix}`)).catch((): void => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`)).catch((): void => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch((): void => {});
    await db.delete(users).where(eq(users.id, userId)).catch((): void => {});
  });

  it("logs the lock block for pending runs without starting them", async () => {
    const { pollWorkerQueue } = await import("../../src/worker");
    await pollWorkerQueue();
    const row = await db.query.runs.findFirst({ where: eq(runs.id, pendingRunId) });
    expect(row?.status).toBe("pending");
    expect(await logText(pendingRunId, "plan")).toContain("workspace is locked");
    expect(await logText(pendingRunId, "plan")).toContain("deploy freeze");
  });

  it("does not spam the lock-blocked log on every poll", async () => {
    const { pollWorkerQueue } = await import("../../src/worker");
    await pollWorkerQueue();
    const rows = await db.query.logs.findMany({
      where: and(eq(logs.runId, pendingRunId), eq(logs.phase, "plan")),
    });
    expect(rows.length).toBe(1);
  });

  it("logs the lock block for confirmed applies without dispatching them", async () => {
    const { applyDueScheduledRuns } = await import("../../src/worker");
    await applyDueScheduledRuns();
    const row = await db.query.runs.findFirst({ where: eq(runs.id, confirmedRunId) });
    expect(row?.status).toBe("confirmed");
    expect(await logText(confirmedRunId, "apply")).toContain("workspace is locked");
    await applyDueScheduledRuns();
    const rows = await db.query.logs.findMany({
      where: and(eq(logs.runId, confirmedRunId), eq(logs.phase, "apply")),
    });
    expect(rows.length).toBe(1);
  });
});
