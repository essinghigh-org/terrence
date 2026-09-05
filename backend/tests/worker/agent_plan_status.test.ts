import { describe, expect, it } from "bun:test";

import { resolvePlanStatus } from "../../src/lib/agent-jobs";
import type { AgentPlanFlags, AgentPolicyVerdict } from "../../src/lib/agent-jobs";
import { canTransitionRunStatus } from "../../src/lib/run-status";

// Agent plan-status decision coverage (issue #587): allow-empty-apply only
// permits applying an empty plan (mirroring the local worker, where an empty
// plan with the flag stops at planned for confirmation); it never triggers
// an automatic apply on its own.

const CLEAN_VERDICT: AgentPolicyVerdict = { hardFailed: false, softFailed: false };

const PLAIN_RUN: AgentPlanFlags = {
  autoApply: false,
  allowEmptyApply: false,
  savePlan: false,
  planOnly: false,
};

describe("resolvePlanStatus (#587)", () => {
  it("stops at planned for confirmation when only allow-empty-apply is set", () => {
    expect(resolvePlanStatus(CLEAN_VERDICT, { ...PLAIN_RUN, allowEmptyApply: true })).toBe("planned");
  });

  it("queues apply only for explicit autoApply", () => {
    expect(resolvePlanStatus(CLEAN_VERDICT, { ...PLAIN_RUN, autoApply: true })).toBe("apply_queued");
    expect(
      resolvePlanStatus(CLEAN_VERDICT, { ...PLAIN_RUN, autoApply: true, allowEmptyApply: true }),
    ).toBe("apply_queued");
  });

  it("keeps policy and plan-mode verdicts ahead of the apply decision", () => {
    expect(
      resolvePlanStatus({ hardFailed: true, softFailed: false }, { ...PLAIN_RUN, autoApply: true }),
    ).toBe("errored");
    expect(
      resolvePlanStatus({ hardFailed: false, softFailed: true }, { ...PLAIN_RUN, autoApply: true }),
    ).toBe("policy_soft_failed");
    expect(
      resolvePlanStatus(CLEAN_VERDICT, { ...PLAIN_RUN, savePlan: true, autoApply: true }),
    ).toBe("planned_and_saved");
    expect(
      resolvePlanStatus(CLEAN_VERDICT, { ...PLAIN_RUN, planOnly: true, autoApply: true }),
    ).toBe("planned_and_finished");
  });

  it("stops a plain run at planned", () => {
    expect(resolvePlanStatus(CLEAN_VERDICT, PLAIN_RUN)).toBe("planned");
  });

  it("emits only state-machine-legal plan-completion edges from planning", () => {
    const outcomes = new Set<string>();
    for (const verdict of [
      CLEAN_VERDICT,
      { hardFailed: true, softFailed: false },
      { hardFailed: false, softFailed: true },
    ] as const) {
      for (const run of [
        PLAIN_RUN,
        { ...PLAIN_RUN, autoApply: true },
        { ...PLAIN_RUN, allowEmptyApply: true },
        { ...PLAIN_RUN, savePlan: true },
        { ...PLAIN_RUN, planOnly: true },
      ] as const) {
        outcomes.add(resolvePlanStatus(verdict, run));
      }
    }
    expect(outcomes).toEqual(
      new Set(["planned", "apply_queued", "planned_and_saved", "planned_and_finished", "policy_soft_failed", "errored"]),
    );
    for (const outcome of outcomes) {
      expect(canTransitionRunStatus("planning", outcome), `planning -> ${outcome}`).toBe(true);
    }
  });

  it("keeps apply-completion edges legal from applying", () => {
    expect(canTransitionRunStatus("applying", "applied")).toBe(true);
    expect(canTransitionRunStatus("applying", "errored")).toBe(true);
  });
});
