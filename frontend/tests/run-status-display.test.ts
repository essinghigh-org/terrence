import { expect, test } from "bun:test";
import { resolveRunDisplay } from "../src/lib/run-status";

const statuses = [
  "pending",
  "fetching",
  "fetching_completed",
  "pre_plan_running",
  "pre_plan_completed",
  "queuing",
  "plan_queued",
  "planning",
  "planned",
  "cost_estimating",
  "cost_estimated",
  "policy_checking",
  "policy_override",
  "policy_soft_failed",
  "policy_checked",
  "post_plan_running",
  "post_plan_completed",
  "planned_and_saved",
  "planned_and_finished",
  "confirmed",
  "apply_queued",
  "applying",
  "applied",
  "errored",
  "canceled",
  "discarded",
  "force_canceled",
  "unreachable",
] as const;

test("every backend run status resolves to a reader-facing stage and outcome", () => {
  for (const status of statuses) {
    const display = resolveRunDisplay({ status, "status-timestamps": {} });
    expect(display.stage, status).toMatch(/^(queue|plan|checks|apply)$/);
    expect(display.stageLabel, status).not.toBe(status);
    expect(display.outcome, status).toMatch(/^(queued|running|waiting|succeeded|failed|canceled|discarded)$/);
    expect(display.outcomeLabel, status).not.toBe(status);
    expect(display.responsible, status).not.toBe("");
  }
});

test("queue display names workspace, agent and scheduled blockers", () => {
  expect(resolveRunDisplay({ status: "pending" }).waitingLabel).toBe("Waiting for workspace capacity");
  expect(resolveRunDisplay({ status: "fetching" }).outcome).toBe("running");
  expect(resolveRunDisplay({ status: "fetching" }).waitingReason).toBeNull();
  expect(resolveRunDisplay({ status: "plan_queued", "execution-mode": "remote", "position-in-queue": 3 }).waitingLabel)
    .toBe("Waiting for workspace capacity · position 3");
  expect(resolveRunDisplay({ status: "plan_queued", "execution-mode": "agent" }).waitingLabel)
    .toBe("Waiting for an available agent");
  expect(resolveRunDisplay({
    status: "confirmed",
    "status-timestamps": { "scheduled-at": "2030-01-01T12:00:00.000Z" },
  }).waitingLabel).toBe("Scheduled to start");
});

test("policy rejection and execution failure remain distinct", () => {
  const rejected = resolveRunDisplay({ status: "policy_hard_failed", "status-timestamps": {} });
  expect(rejected.outcome).toBe("failed");
  expect(rejected.outcomeLabel).toBe("Rejected by policy");
  expect(rejected.stageLabel).toBe("Checks");

  const failed = resolveRunDisplay({ status: "errored", "status-timestamps": {} });
  expect(failed.outcome).toBe("failed");
  expect(failed.outcomeLabel).toBe("Execution failed");
});

test("human and policy waits identify the responsible actor", () => {
  const approval = resolveRunDisplay({ status: "needs_confirmation", "status-timestamps": {} });
  expect(approval.waitingLabel).toBe("Waiting for a human decision");
  expect(approval.responsible).toContain("authorized reviewer");

  const policy = resolveRunDisplay({ status: "policy_soft_failed", "status-timestamps": {} });
  expect(policy.waitingLabel).toBe("Waiting for a policy decision");
  expect(policy.responsible).toBe("A policy reviewer");
});
