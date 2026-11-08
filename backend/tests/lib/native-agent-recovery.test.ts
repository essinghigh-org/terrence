import { expect, test } from "bun:test";
import { retainsNativeApplyRecovery, type NativeApplyJournalEntry } from "../compat/tfpolicy-owner/agent-recovery";

const manifest = {
  job_id: "job-apply",
  run_id: "run-original",
  phase: "apply",
  native_policy: true,
  fencing_token: 7,
  fingerprint: "original-fingerprint",
  work_dir: "/private/original-apply",
};
const retained: NativeApplyJournalEntry = {
  state: "recovery_required",
  retain_work_dir: true,
  manifest,
  completion: {
    status: "errored",
    error: "Agent restarted during native apply; no rollback occurred",
    data: {
      fencing_token: 7,
      run_id: "run-original",
      operation: "apply",
      state_recovery_required: true,
    },
  },
};

test("native death qualification accepts durable quarantine even when pending was never observed", () => {
  // The production agent can finish the API's 409 round trip between two polls.
  const observations = [{ ...retained, state: "executing" }, retained];
  expect(observations.some((entry) => retainsNativeApplyRecovery(entry, manifest))).toBe(true);
});

for (const state of ["claimed", "executing", "completion_pending", "completion_acked", "cleanup_done"])
  test(`native death qualification rejects ${state} as proof of durable recovery`, () => {
    expect(retainsNativeApplyRecovery({ ...retained, state }, manifest)).toBe(false);
  });

for (const key of ["job_id", "run_id", "phase", "fingerprint", "work_dir"] as const)
  test(`native death qualification rejects changed ${key}`, () => {
    expect(retainsNativeApplyRecovery({ ...retained, manifest: { ...manifest, [key]: "changed" } }, manifest)).toBe(
      false,
    );
  });

for (const changed of [
  { ...manifest, fencing_token: 8 },
  { ...manifest, native_policy: false },
])
  test(`native death qualification rejects changed lease or native identity ${JSON.stringify(changed)}`, () => {
    expect(retainsNativeApplyRecovery({ ...retained, manifest: changed }, manifest)).toBe(false);
  });

test("native death qualification requires retained directory, completion, warning and original completion scope", () => {
  const completion = retained.completion;
  if (completion === undefined) throw new Error("Missing fixture completion");
  const invalid: NativeApplyJournalEntry[] = [
    { ...retained, retain_work_dir: false },
    { state: retained.state, retain_work_dir: true, manifest },
    { ...retained, completion: { ...completion, status: "finished" } },
    { ...retained, completion: { ...completion, error: "unrelated error" } },
    ...[{ fencing_token: 8 }, { run_id: "another-run" }, { operation: "plan" }, { state_recovery_required: false }].map(
      (change) => ({ ...retained, completion: { ...completion, data: { ...completion.data, ...change } } }),
    ),
  ];
  for (const entry of invalid) expect(retainsNativeApplyRecovery(entry, manifest)).toBe(false);
});
