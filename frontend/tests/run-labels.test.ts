import { expect, test } from "bun:test";

import { formatRunSource, formatRunStatus, formatRunStatusForUi, isVcsRunSource } from "../src/lib/run-labels";

test("uses the same human-readable status labels across run views", (): void => {
  expect(formatRunStatus("planned")).toBe("Needs confirmation");
  expect(formatRunStatus("planned_and_finished")).toBe("Planned and finished");
  expect(formatRunStatus("policy_hard_failed")).toBe("Policy check failed");
  expect(formatRunStatus("unknown_status")).toBe("unknown status");
  expect(formatRunStatus("toString")).toBe("toString");
});

test("recognizes legacy VCS run sources consistently", (): void => {
  expect(isVcsRunSource("github")).toBe(true);
  expect(isVcsRunSource("tfe-configuration-version", "push")).toBe(true);
  expect(isVcsRunSource("tfe-configuration-version", "manual")).toBe(false);
  expect(formatRunSource("tfe-configuration-version", "pull_request")).toBe("VCS");
  expect(formatRunSource("tfe-api")).toBe("API");
});

test("uses operator-facing labels in scan views", (): void => {
  expect(formatRunStatusForUi("planned_and_finished")).toBe("Plan complete");
  expect(formatRunStatusForUi("errored")).toBe("Failed");
  expect(formatRunStatusForUi("applied")).toBe("Applied");
});
