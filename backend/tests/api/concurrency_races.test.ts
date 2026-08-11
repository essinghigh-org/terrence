import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import {
  agentJobs,
  agentPools,
  assessmentResults,
  organizations,
  runs,
  workspaces,
} from "../../src/db/schema";
import { confirmRunForApply } from "../../src/lib/operations";
import { pollAssessmentQueue, pollWorkerQueue } from "../../src/worker";
import { canTransitionRunStatus } from "../../src/lib/run-status";

/**
 * Concurrency race tests (review item 22.11).
 *
 * The queue claim path is a read-then-CAS: pollers first SELECT pending rows,
 * then claim each with UPDATE ... WHERE status = 'pending' RETURNING. Under
 * concurrent pollers both can read the same row before either writes; the
 * WHERE-status guard (not application-level locking) is what makes the claim
 * exclusive. These tests hammer that window with many concurrent callers and
 * assert the invariants the queue depends on:
 *   - each run/assessment is claimed by exactly one poller (no double-claim),
 *   - at most one run per workspace is claimed per poll wave,
 *   - a run can only be confirmed for apply once (double-trigger race),
 *   - unclaimed rows stay pending.
 * They fail loudly if someone removes the conditional WHERE from a claim.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgId = `conc-org-${suffix}`;
const agentPoolId = `conc-pool-${suffix}`;
const confirmPoolId = `conc-pool-confirm-${suffix}`;
const workspaceAId = `conc-ws-a-${suffix}`;
const workspaceBId = `conc-ws-b-${suffix}`;
const workspaceCId = `conc-ws-c-${suffix}`;
const workspaceDId = `conc-ws-d-${suffix}`;
const workspaceEId = `conc-ws-e-${suffix}`;
const workspaceFId = `conc-ws-f-${suffix}`;
const workspaceGId = `conc-ws-g-${suffix}`;

const RUN_A1 = `conc-run-a1-${suffix}`;
const RUN_A2 = `conc-run-a2-${suffix}`;
const RUN_A3 = `conc-run-a3-${suffix}`;
const RUN_B = `conc-run-b-${suffix}`;
const RUN_C = `conc-run-c-${suffix}`;
const RUN_D = `conc-run-d-${suffix}`;
const RUN_E = `conc-run-e-${suffix}`;
const RUN_F = `conc-run-f-${suffix}`;
const CONFIRM_RUN = `conc-confirm-${suffix}`;

beforeAll(async () => {
  await db.insert(organizations).values({ id: orgId, name: `conc-org-${suffix}` });
  await db.insert(agentPools).values([
    { id: agentPoolId, orgId, name: `conc-pool-${suffix}`, organizationScoped: true },
    { id: confirmPoolId, orgId, name: `conc-pool-confirm-${suffix}`, organizationScoped: true },
  ]);
  await db.insert(workspaces).values([
    { id: workspaceAId, orgId, name: "conc-ws-a", executionMode: "agent", agentPoolId },
    { id: workspaceBId, orgId, name: "conc-ws-b", executionMode: "agent", agentPoolId },
    { id: workspaceCId, orgId, name: "conc-ws-c", executionMode: "agent", agentPoolId },
    { id: workspaceDId, orgId, name: "conc-ws-d", executionMode: "agent", agentPoolId },
    { id: workspaceEId, orgId, name: "conc-ws-e", executionMode: "agent", agentPoolId },
    { id: workspaceFId, orgId, name: "conc-ws-f", executionMode: "agent", agentPoolId },
    { id: workspaceGId, orgId, name: "conc-ws-g", executionMode: "agent", agentPoolId: confirmPoolId },
  ]);
  await db.insert(runs).values([
    // Three pending runs in the SAME workspace: at most one may ever be claimed.
    { id: RUN_A1, workspaceId: workspaceAId, status: "pending", createdAt: Date.now() - 6000 },
    { id: RUN_A2, workspaceId: workspaceAId, status: "pending", createdAt: Date.now() - 5000 },
    { id: RUN_A3, workspaceId: workspaceAId, status: "pending", createdAt: Date.now() - 4000 },
    { id: RUN_B, workspaceId: workspaceBId, status: "pending", createdAt: Date.now() - 3000 },
    { id: RUN_C, workspaceId: workspaceCId, status: "pending", createdAt: Date.now() - 3000 },
    { id: RUN_D, workspaceId: workspaceDId, status: "pending", createdAt: Date.now() - 3000 },
    { id: RUN_E, workspaceId: workspaceEId, status: "pending", createdAt: Date.now() - 3000 },
    { id: RUN_F, workspaceId: workspaceFId, status: "pending", createdAt: Date.now() - 3000 },
    // Confirm race run lives in its own workspace with its own pool so the
    // claim tests and the confirm test cannot interfere.
    { id: CONFIRM_RUN, workspaceId: workspaceGId, status: "planned", createdAt: Date.now() - 2000 },
  ]);
  // Six pending assessments: the queue drains at most HEALTH_ASSESSMENT_CONCURRENCY.
  await db.insert(assessmentResults).values(
    Array.from({ length: 6 }, (_, i) => ({
      id: `conc-asm-${suffix}-${i}`,
      workspaceId: workspaceFId,
      status: "pending",
      createdAt: Date.now() - 1000 + i,
    })),
  );
});

afterAll(async () => {
  await db.delete(runs).where(inArray(runs.id, [
    RUN_A1, RUN_A2, RUN_A3, RUN_B, RUN_C, RUN_D, RUN_E, RUN_F, CONFIRM_RUN,
  ]));
  await db.delete(assessmentResults).where(
    inArray(assessmentResults.id, Array.from({ length: 6 }, (_, i) => `conc-asm-${suffix}-${i}`)),
  );
  await db.delete(workspaces).where(inArray(workspaces.id, [
    workspaceAId, workspaceBId, workspaceCId, workspaceDId, workspaceEId, workspaceFId, workspaceGId,
  ]));
  await db.delete(agentPools).where(inArray(agentPools.id, [agentPoolId, confirmPoolId]));
  await db.delete(organizations).where(eq(organizations.id, orgId));
});

async function runStatus(id: string): Promise<string | undefined> {
  const row = await db.query.runs.findFirst({ where: eq(runs.id, id), columns: { status: true } });
  return row?.status;
}

describe("concurrency: queue claim races", () => {
  it("exactly one run per workspace is claimed across 24 concurrent pollers (CAS exclusivity)", async () => {
    const pollers = Array.from({ length: 24 }, async (): Promise<string[]> => pollWorkerQueue());
    const results = await Promise.all(pollers);
    const claims = results.flat();

    // No double-claim: the union has the same size as the flattened list.
    expect(new Set(claims).size).toBe(claims.length);
    // One run per workspace, across 6 workspaces.
    expect(new Set(claims).size).toBe(6);
    for (const runId of [RUN_B, RUN_C, RUN_D, RUN_E]) {
      expect(claims).toContain(runId);
    }
    // Workspace A's three runs: exactly one claimed.
    const aClaims = claims.filter((id) => id === RUN_A1 || id === RUN_A2 || id === RUN_A3);
    expect(aClaims.length).toBe(1);
    // Claimed runs moved to plan_queued; unclaimed siblings stayed pending.
    const claimedSet = new Set(claims);
    for (const runId of [RUN_B, RUN_C, RUN_D, RUN_E]) {
      expect(await runStatus(runId)).toBe("plan_queued");
    }
    for (const runId of [RUN_A1, RUN_A2, RUN_A3]) {
      const status = await runStatus(runId);
      if (claimedSet.has(runId)) {
        expect(status).toBe("plan_queued");
      } else {
        expect(status).toBe("pending");
      }
    }
    // Exactly one agent job per claimed run.
    const jobs = await db.query.agentJobs.findMany({
      where: eq(agentJobs.agentPoolId, agentPoolId),
      columns: { runId: true },
    });
    expect(jobs.length).toBe(6);
    expect(new Set(jobs.map((j) => j.runId)).size).toBe(6);
  });

  it("assessment claims are exclusive and bounded by concurrency across 20 concurrent pollers", async () => {
    const previous = process.env.HEALTH_ASSESSMENT_CONCURRENCY;
    process.env.HEALTH_ASSESSMENT_CONCURRENCY = "3";
    try {
      const pollers = Array.from({ length: 20 }, async (): Promise<string[]> => pollAssessmentQueue());
      const results = await Promise.all(pollers);
      const claims = results.flat();
      // No double-claim across any caller.
      expect(new Set(claims).size).toBe(claims.length);
      // Each serialized pass is capped at the configured concurrency (3),
      // regardless of caller count.
      for (const pass of results) {
        expect(pass.length).toBeLessThanOrEqual(3);
      }
      expect(claims.length).toBeGreaterThanOrEqual(1);
      // The remaining assessments were never claimed twice: every claimed id
      // was moved out of 'pending' by its claim CAS (the fire-and-forget
      // executor may have already failed them to 'errored', which is fine).
      const statuses = await db.query.assessmentResults.findMany({
        where: inArray(
          assessmentResults.id,
          Array.from({ length: 6 }, (_, i) => `conc-asm-${suffix}-${i}`),
        ),
        columns: { id: true, status: true },
      });
      const byId = new Map(statuses.map((s) => [s.id, s.status]));
      for (const claimed of claims) {
        expect(byId.get(claimed), `claimed ${claimed} should not be pending`).not.toBe("pending");
      }
    } finally {
      if (previous === undefined) delete process.env.HEALTH_ASSESSMENT_CONCURRENCY;
      else process.env.HEALTH_ASSESSMENT_CONCURRENCY = previous;
    }
  });

  it("a run can be confirmed for apply exactly once under a 16-way race", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 16 }, (): Promise<{ ok: boolean }> => confirmRunForApply(CONFIRM_RUN)),
    );
    const successes = attempts.filter((a) => a.ok === true);
    expect(successes.length).toBe(1);
    // Agent-mode confirmation: CAS to confirmed, then enqueueAgentApplyJob
    // moves the run to apply_queued and inserts exactly one agent job.
    expect(await runStatus(CONFIRM_RUN)).toBe("apply_queued");
    const jobs = await db.query.agentJobs.findMany({
      where: eq(agentJobs.runId, CONFIRM_RUN),
      columns: { id: true, agentPoolId: true, phase: true },
    });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.agentPoolId).toBe(confirmPoolId);
    expect(jobs[0]?.phase).toBe("apply");
    // A second wave against the apply_queued run must not re-queue it.
    const secondWave = await Promise.all(
      Array.from({ length: 8 }, (): Promise<{ ok: boolean }> => confirmRunForApply(CONFIRM_RUN)),
    );
    expect(secondWave.every((a) => a.ok === false)).toBe(true);
    expect(await runStatus(CONFIRM_RUN)).toBe("apply_queued");
    const jobsAfter = await db.query.agentJobs.findMany({
      where: eq(agentJobs.runId, CONFIRM_RUN),
      columns: { id: true },
    });
    expect(jobsAfter.length).toBe(1);
    // The confirmed transition is legal in the state machine (22.8).
    expect(canTransitionRunStatus("planned", "confirmed")).toBe(true);
    expect(canTransitionRunStatus("confirmed", "apply_queued")).toBe(true);
  });
});
