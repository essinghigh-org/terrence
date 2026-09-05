import { expect, test } from "bun:test";
import { resolveRunDecision } from "../src/lib/run-decision";
import { resolveStages } from "../src/components/RunStageStrip";
import type { RunAttributes } from "../src/lib/run-view-state";

const attributes = (over: Partial<RunAttributes>): RunAttributes => ({
  status: "pending",
  "status-timestamps": {},
  ...over,
});

const options = (over: Partial<{
  fresh: boolean;
  speculative: boolean;
  awaitingAction: string | null;
}> = {}): Readonly<{ fresh: boolean; speculative: boolean; awaitingAction: string | null }> => ({
  fresh: true,
  speculative: false,
  awaitingAction: null,
  ...over,
});

// The bug this file exists for: the decision panel was gated on "any action is
// available", so a run that was merely planning rendered a panel headed
// "Please review the planned changes before continuing" above the words
// "Resources pending", offering only "Add comment".

test("a planning run is not asked to be reviewed", () => {
  const decision = resolveRunDecision(
    attributes({
      status: "planning",
      actions: { "is-cancelable": true },
      permissions: { "can-cancel": true },
    }),
    options(),
  );
  expect(decision.kind).toBe("waiting");
  expect(decision.headline).toBe("Planning");
  // Cancel is the only thing a working run can be asked, and it must not be
  // dressed up as a review of changes that do not exist yet.
  expect(decision.offers.map((offer): string => offer.kind)).toEqual(["cancel"]);
});

test("a planned run asks for an apply and offers a discard", () => {
  const decision = resolveRunDecision(
    attributes({
      status: "planned",
      actions: { "is-confirmable": true, "is-discardable": true },
      permissions: { "can-apply": true, "can-discard": true },
    }),
    options(),
  );
  expect(decision.kind).toBe("decide");
  const offers = decision.offers;
  expect(offers[0]?.kind).toBe("apply");
  expect(offers[0]?.emphasis).toBe("primary");
  expect(offers[0]?.blockedReason).toBeNull();
  expect(offers[1]?.kind).toBe("discard");
});

test("a blocked apply names its blocker on the button rather than in a list", () => {
  const decision = resolveRunDecision(
    attributes({
      status: "planned",
      actions: { "is-confirmable": true },
      permissions: { "can-apply": false },
    }),
    options(),
  );
  const apply = decision.offers.find((offer): boolean => offer.kind === "apply");
  expect(apply?.blockedReason).toContain("permission");
});

test("a locked workspace is reported as the blocker, not a permission problem", () => {
  const decision = resolveRunDecision(
    attributes({
      status: "planned",
      actions: { "is-confirmable": true },
      permissions: { "can-apply": true },
      "workspace-locked": true,
      "workspace-locked-reason": "migrating state",
    }),
    options(),
  );
  const apply = decision.offers.find((offer): boolean => offer.kind === "apply");
  expect(apply?.blockedReason).toContain("migrating state");
});

test("a soft-failed policy outranks the apply decision", () => {
  const decision = resolveRunDecision(
    attributes({
      status: "policy_soft_failed",
      actions: { "is-confirmable": true, "is-discardable": true },
      permissions: { "can-apply": true, "can-discard": true, "can-override-policy-check": true },
    }),
    options(),
  );
  expect(decision.kind).toBe("decide");
  expect(decision.offers[0]?.kind).toBe("override-policy");
  // Nothing can be applied until the finding is accepted, so no apply is on
  // offer at all — offering one that the backend would refuse is worse than
  // not offering it.
  expect(decision.offers.some((offer): boolean => offer.kind === "apply")).toBe(false);
});

test("a speculative plan says it never applies instead of asking for one", () => {
  const decision = resolveRunDecision(
    attributes({
      status: "planned",
      "plan-only": true,
      actions: { "is-confirmable": true },
      permissions: { "can-apply": true },
    }),
    options({ speculative: true }),
  );
  expect(decision.kind).toBe("settled");
  expect(decision.headline).toContain("never applies");
  expect(decision.offers).toEqual([]);
});

test("an action already sent is reported as in flight, not re-offered", () => {
  const decision = resolveRunDecision(
    attributes({
      status: "planned",
      actions: { "is-confirmable": true, "is-discardable": true },
      permissions: { "can-apply": true, "can-discard": true },
    }),
    options({ awaitingAction: "apply" }),
  );
  expect(decision.kind).toBe("waiting");
  expect(decision.headline).toContain("Apply confirmed");
  expect(decision.offers).toEqual([]);
});

test("a finished run asks for nothing", () => {
  for (const status of ["applied", "errored", "canceled", "discarded", "planned_and_finished"]) {
    const decision = resolveRunDecision(attributes({ status }), options());
    expect(decision.kind).toBe("settled");
    expect(decision.offers).toEqual([]);
  }
});

test("a stale page refuses to apply rather than acting on data it cannot vouch for", () => {
  const decision = resolveRunDecision(
    attributes({
      status: "planned",
      actions: { "is-confirmable": true },
      permissions: { "can-apply": true },
    }),
    options({ fresh: false }),
  );
  const apply = decision.offers.find((offer): boolean => offer.kind === "apply");
  expect(apply?.blockedReason).not.toBeNull();
});

// ── Stage strip ─────────────────────────────────────────────────────────────

test("stages mark what is done, what is running, and what is still ahead", () => {
  const stages = resolveStages(
    "planning",
    { "pending-at": "t0", "planning-at": "t1" },
    { planOnly: false, hasPolicyChecks: true },
  );
  const byId = new Map(stages.map((stage): [string, string] => [stage.id, stage.state]));
  expect(byId.get("queue")).toBe("done");
  expect(byId.get("plan")).toBe("active");
  expect(byId.get("apply")).toBe("pending");
});

test("a failed run marks where it stopped and does not leave later stages pending", () => {
  const stages = resolveStages(
    "errored",
    { "pending-at": "t0", "planning-at": "t1", "errored-at": "t2" },
    { planOnly: false, hasPolicyChecks: true },
  );
  const byId = new Map(stages.map((stage): [string, string] => [stage.id, stage.state]));
  expect(byId.get("plan")).toBe("failed");
  // A stage the run never reached is "not reached", not "waiting to start" —
  // a permanently grey circle on a finished run reads as still pending.
  expect(byId.get("apply")).toBe("skipped");
});

test("the apply stage is omitted from a plan-only run", () => {
  const stages = resolveStages(
    "planned_and_finished",
    { "planning-at": "t1", "planned-and-finished-at": "t2" },
    { planOnly: true, hasPolicyChecks: false },
  );
  expect(stages.some((stage): boolean => stage.id === "apply")).toBe(false);
});

test("the checks stage is omitted when nothing has ever run there", () => {
  // An instance with no policies and no cost estimation would otherwise show a
  // permanently grey stage wedged between two real ones.
  const stages = resolveStages(
    "applying",
    { "planning-at": "t1", "planned-at": "t2", "applying-at": "t3" },
    { planOnly: false, hasPolicyChecks: false },
  );
  expect(stages.some((stage): boolean => stage.id === "policy")).toBe(false);
  expect(stages.some((stage): boolean => stage.id === "apply")).toBe(true);
});

// ── Regressions found in review ─────────────────────────────────────────────

test("a hard policy failure is reported as failed, not as work in progress", () => {
  const decision = resolveRunDecision(attributes({ status: "policy_hard_failed" }), options());
  expect(decision.kind).toBe("settled");
  expect(decision.headline).toContain("policy check failed");
  expect(decision.showProgress).toBe(false);
});

test("needs_confirmation is treated as a finished plan even without an actions block", () => {
  // The API can omit `actions`. Without this the status whose whole name says
  // a human is being waited on fell through to a generic spinner.
  const decision = resolveRunDecision(attributes({ status: "needs_confirmation" }), options());
  expect(decision.kind).not.toBe("waiting");
  expect(decision.headline).not.toBe("Run in progress");
});

test("a cancel that is not acknowledged still offers force cancel", () => {
  // Hiding every offer while an action was in flight hid force cancel in
  // exactly the situation it exists for: a process that will not stop.
  const decision = resolveRunDecision(
    attributes({
      status: "applying",
      actions: { "is-cancelable": true, "is-force-cancelable": true },
      permissions: { "can-cancel": true, "can-force-cancel": true },
    }),
    options({ awaitingAction: "cancel" }),
  );
  const kinds = decision.offers.map((offer): string => offer.kind);
  expect(kinds).toContain("force-cancel");
  // ...but the action already sent is not re-offered.
  expect(kinds).not.toContain("cancel");
});

test("a hard policy failure marks the checks stage failed, not still running", () => {
  const stages = resolveStages(
    "policy_hard_failed",
    { "planning-at": "t1", "planned-at": "t2", "policy-checking-at": "t3" },
    { planOnly: false, hasPolicyChecks: true },
  );
  const byId = new Map(stages.map((stage): [string, string] => [stage.id, stage.state]));
  expect(byId.get("plan")).toBe("done");
  expect(byId.get("policy")).toBe("failed");
  expect(byId.get("apply")).toBe("skipped");
});
