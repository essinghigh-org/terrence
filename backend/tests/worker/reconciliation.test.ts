import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import {
  assessmentResults,
  logs,
  organizations,
  runs,
  runTokens,
  workspaces,
} from "../../src/db/schema";
import { reconcileInterruptedLocalRuns } from "../../src/worker";

// Startup-reconciliation suite (scratch review: local runs orphaned by a
// restart keep transient statuses and block their workspace queue forever).
// Each test FILE gets its own temp DB (tests/setup.ts), so seeding here is
// isolated from the API suites.
const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const orgId = `org-recon-${suffix}`;
const localWsId = `ws-recon-local-${suffix}`;
const agentWsId = `ws-recon-agent-${suffix}`;

// One fixture row per reconciliation branch: requeue states (fetching,
// queuing), error states with distinct messages (planning, applying,
// apply_queued, pre_plan_running), resting states that must survive
// (planned, confirmed), and agent-mode runs that recoverStaleAgentJobs owns.
const RUNS: readonly { id: string; ws: string; status: string }[] = [
  { id: `run-recon-fetching-${suffix}`, ws: localWsId, status: "fetching" },
  { id: `run-recon-queuing-${suffix}`, ws: localWsId, status: "queuing" },
  { id: `run-recon-preplan-${suffix}`, ws: localWsId, status: "pre_plan_running" },
  { id: `run-recon-planning-${suffix}`, ws: localWsId, status: "planning" },
  { id: `run-recon-applyqueued-${suffix}`, ws: localWsId, status: "apply_queued" },
  { id: `run-recon-applying-${suffix}`, ws: localWsId, status: "applying" },
  { id: `run-recon-planned-${suffix}`, ws: localWsId, status: "planned" },
  { id: `run-recon-confirmed-${suffix}`, ws: localWsId, status: "confirmed" },
  { id: `run-recon-agent-applying-${suffix}`, ws: agentWsId, status: "applying" },
  { id: `run-recon-agent-planqueued-${suffix}`, ws: agentWsId, status: "plan_queued" },
];

const RUN_IDS = RUNS.map((run): string => run.id);
const RUNNING_ASSESSMENT_ID = `asmt-recon-running-${suffix}`;
const PENDING_ASSESSMENT_ID = `asmt-recon-pending-${suffix}`;
const WORKSPACE_IDS = [localWsId, agentWsId];

describe("startup reconciliation of interrupted local runs", () => {
  let result: { requeued: number; errored: number; assessmentsErrored: number };

  beforeAll(async () => {
    const now = Date.now();
    await db.insert(organizations).values({ id: orgId, name: `recon-org-${suffix}` });
    await db.insert(workspaces).values([
      { id: localWsId, name: `recon-local-${suffix}`, orgId, executionMode: "remote" },
      { id: agentWsId, name: `recon-agent-${suffix}`, orgId, executionMode: "agent" },
    ]);
    await db.insert(runs).values(RUNS.map((run, index) => ({
      id: run.id,
      workspaceId: run.ws,
      status: run.status,
      createdAt: now - index,
    })));
    await db.insert(assessmentResults).values([
      { id: RUNNING_ASSESSMENT_ID, workspaceId: localWsId, status: "running", createdAt: now },
      { id: PENDING_ASSESSMENT_ID, workspaceId: localWsId, status: "pending", createdAt: now },
    ]);
    // A still-valid run token on the interrupted applying run must be revoked.
    await db.insert(runTokens).values({
      id: `rtok-recon-${suffix}`,
      tokenHash: `hash-recon-${suffix}`,
      runId: `run-recon-applying-${suffix}`,
      workspaceId: localWsId,
      organizationId: orgId,
      createdAt: now,
      expiresAt: now + 86_400_000,
    });
    // The reconciliation pass itself is the subject under test: run it once
    // in beforeAll so every assertion observes the same resulting state.
    result = await reconcileInterruptedLocalRuns();
  });

  afterAll(async () => {
    await db.delete(logs).where(inArray(logs.runId, RUN_IDS)).catch((): void => {});
    await db.delete(runTokens).where(eq(runTokens.id, `rtok-recon-${suffix}`)).catch((): void => {});
    await db.delete(runs).where(inArray(runs.id, RUN_IDS)).catch((): void => {});
    await db.delete(assessmentResults).where(inArray(assessmentResults.id, [RUNNING_ASSESSMENT_ID, PENDING_ASSESSMENT_ID])).catch((): void => {});
    await db.delete(workspaces).where(inArray(workspaces.id, WORKSPACE_IDS)).catch((): void => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch((): void => {});
  });

  it("requeues pre-execution states, errors execution states, and never touches agent-mode or resting runs", async () => {
    expect(result.requeued).toBe(2); // fetching + queuing
    expect(result.errored).toBe(4); // pre_plan_running + planning + apply_queued + applying
    expect(result.assessmentsErrored).toBe(1); // running only

    const rows = await db.query.runs.findMany({
      where: inArray(runs.id, RUN_IDS),
      columns: { id: true, status: true },
    });
    const after = Object.fromEntries(rows.map((row): [string, string] => [row.id, row.status]));
    expect(after[`run-recon-fetching-${suffix}`]).toBe("pending");
    expect(after[`run-recon-queuing-${suffix}`]).toBe("pending");
    expect(after[`run-recon-preplan-${suffix}`]).toBe("errored");
    expect(after[`run-recon-planning-${suffix}`]).toBe("errored");
    expect(after[`run-recon-applyqueued-${suffix}`]).toBe("errored");
    expect(after[`run-recon-applying-${suffix}`]).toBe("errored");
    expect(after[`run-recon-planned-${suffix}`]).toBe("planned");
    expect(after[`run-recon-confirmed-${suffix}`]).toBe("confirmed");
    expect(after[`run-recon-agent-applying-${suffix}`]).toBe("applying");
    expect(after[`run-recon-agent-planqueued-${suffix}`]).toBe("plan_queued");
  });

  it("revokes the interrupted run's token and writes phase-matched log lines", async () => {
    const token = await db.query.runTokens.findFirst({ where: eq(runTokens.id, `rtok-recon-${suffix}`) });
    expect(token).toBeDefined();
    expect(token?.revokedAt).not.toBeNull();

    const logText = async (runId: string, phase: "plan" | "apply"): Promise<string> => {
      const rows = await db.query.logs.findMany({
        where: and(eq(logs.runId, runId), eq(logs.phase, phase)),
      });
      return rows.map((row): string => row.outputText).join("\n");
    };
    // Applying: apply-phase error, explicitly never re-executed.
    expect(await logText(`run-recon-applying-${suffix}`, "apply")).toContain("restarted during apply");
    // Apply queue: apply-phase error explaining the apply never began.
    expect(await logText(`run-recon-applyqueued-${suffix}`, "apply")).toContain("never executed");
    // Pre-plan tasks: plan-phase error warning that tasks may have run.
    expect(await logText(`run-recon-preplan-${suffix}`, "plan")).toContain("pre-plan tasks");
    // Requeued run: plan-phase note explaining the requeue.
    expect(await logText(`run-recon-fetching-${suffix}`, "plan")).toContain("requeued");
  });

  it("errors only running assessments; pending survive for the next discovery cycle", async () => {
    const running = await db.query.assessmentResults.findFirst({ where: eq(assessmentResults.id, RUNNING_ASSESSMENT_ID) });
    expect(running?.status).toBe("errored");
    expect(running?.errorMessage).toContain("restarted");
    const pending = await db.query.assessmentResults.findFirst({ where: eq(assessmentResults.id, PENDING_ASSESSMENT_ID) });
    expect(pending?.status).toBe("pending");
  });

  it("is idempotent: a second pass changes nothing", async () => {
    const second = await reconcileInterruptedLocalRuns();
    expect(second.requeued).toBe(0);
    expect(second.errored).toBe(0);
    expect(second.assessmentsErrored).toBe(0);
  });
});