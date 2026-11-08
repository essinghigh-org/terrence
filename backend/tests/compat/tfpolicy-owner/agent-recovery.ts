export type NativeApplyJournalEntry = Readonly<{
  state: string;
  retain_work_dir: boolean;
  manifest: Readonly<{
    job_id: string;
    run_id: string;
    phase: string;
    native_policy: boolean;
    fencing_token: number;
    fingerprint: string;
    work_dir: string;
  }>;
  completion?: Readonly<{
    status: string;
    error?: string;
    data: Readonly<{
      fencing_token?: number;
      run_id: string;
      operation: string;
      state_recovery_required?: boolean;
    }>;
  }>;
}>;

/** Require the durable quarantine after the API rejects a restart without state.
 * A transient pending record is not proof that restart preserved recovery. */
export function retainsNativeApplyRecovery(
  entry: NativeApplyJournalEntry,
  original: NativeApplyJournalEntry["manifest"],
): boolean {
  const unchanged = (
    ["job_id", "run_id", "phase", "native_policy", "fencing_token", "fingerprint", "work_dir"] as const
  ).every((key) => entry.manifest[key] === original[key]);
  const completion = entry.completion;
  return (
    unchanged &&
    entry.state === "recovery_required" &&
    entry.retain_work_dir &&
    completion?.status === "errored" &&
    completion.error?.includes("no rollback occurred") === true &&
    completion.data.fencing_token === original.fencing_token &&
    completion.data.run_id === original.run_id &&
    completion.data.operation === "apply" &&
    completion.data.state_recovery_required === true
  );
}
