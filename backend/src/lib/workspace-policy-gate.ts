import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { db } from "../db";
import type { DeepReadonly } from "./types";
import { logs, policies, policyChecks, policySetParameters, policySets } from "../db/schema";
import { resolveWorkspacePolicySetIds } from "./policy-set-scope";
import { getPolicyEnforcementSettings, type PolicyEnforcementSettings } from "./policy-enforcement";
import { newResourceId } from "./resource-id";
import { nativePolicySnapshotInfo, nativeAdmissionError, type NativeSnapshotInfo } from "./tfpolicy-native";

type Database = Readonly<typeof db>;
type Workspace = Readonly<{ id: string; orgId: string }>;
type Check = DeepReadonly<typeof policyChecks.$inferSelect>;
const CHECKPOINT = "policy-evaluation-checkpoint";

/** A valid denial may be advisory or overridable. Failure to evaluate never is. */
export function policyFailureIsOverridable(
  policy: Readonly<{ enforcementLevel: string }>,
  policySet: Readonly<{ kind: string; overridable: boolean | null }> | undefined,
): boolean {
  return (
    ["opa", "sentinel"].includes(policySet?.kind ?? "") &&
    ["mandatory", "hard-mandatory", "soft-mandatory"].includes(policy.enforcementLevel) &&
    (policySet?.overridable === true ||
      (policySet?.kind === "sentinel" && policy.enforcementLevel === "soft-mandatory"))
  );
}

export function isPolicyEvaluationCheckpoint(
  check: Readonly<{
    policyId: string | null;
    policySetId: string | null;
    result: Readonly<Record<string, unknown>> | null;
  }>,
): boolean {
  return check.policyId === null && check.policySetId === null && check.result?.[CHECKPOINT] === true;
}

export type WorkspacePolicySnapshot = {
  fingerprint: string;
  sets: (typeof policySets.$inferSelect)[];
  policies: (typeof policies.$inferSelect)[];
  parameters: (typeof policySetParameters.$inferSelect)[];
  enforcement: PolicyEnforcementSettings;
  disabledSets: (typeof policySets.$inferSelect)[];
  nativeInfo?: NativeSnapshotInfo;
};

export async function loadWorkspacePolicySnapshot(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Workspace,
): Promise<WorkspacePolicySnapshot> {
  const ids = await resolveWorkspacePolicySetIds(database, workspace.id, workspace.orgId);
  const [sets, policyRows, parameters, enforcement] = await Promise.all([
    ids.length === 0
      ? []
      : database.query.policySets.findMany({
          where: and(inArray(policySets.id, ids), eq(policySets.orgId, workspace.orgId)),
        }),
    ids.length === 0 ? [] : database.query.policies.findMany({ where: inArray(policies.policySetId, ids) }),
    ids.length === 0
      ? []
      : database.query.policySetParameters.findMany({ where: inArray(policySetParameters.policySetId, ids) }),
    getPolicyEnforcementSettings(database),
  ]);
  sets.sort((a, b) => a.id.localeCompare(b.id));
  policyRows.sort((a, b) => a.id.localeCompare(b.id));
  parameters.sort((a, b) => a.id.localeCompare(b.id));
  const enabledSets = sets.filter((set) =>
    set.kind === "opa" ? enforcement.opa : set.kind === "sentinel" ? enforcement.sentinel : true,
  );
  const enabledIds = new Set(enabledSets.map((set) => set.id));
  const nativeInfo = await nativePolicySnapshotInfo(database, enabledSets);
  // Hash persisted source, tool versions, override permissions, parameters and scope.
  // Never persist the parameter values in a public policy-check result.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        sets,
        policies: policyRows,
        parameters,
        enforcement,
        ...(nativeInfo === undefined ? {} : { nativeInfo }),
      }),
    )
    .digest("hex");
  return {
    fingerprint,
    sets: enabledSets,
    policies: policyRows.filter((policy) => policy.policySetId !== null && enabledIds.has(policy.policySetId)),
    parameters,
    enforcement,
    disabledSets: sets.filter((set) => !enabledIds.has(set.id)),
    ...(nativeInfo === undefined ? {} : { nativeInfo }),
  };
}

export type WorkspacePolicyEvaluation = Readonly<{ id: string; snapshot: WorkspacePolicySnapshot }>;

function unsupportedRuntimeError(
  snapshot: DeepReadonly<WorkspacePolicySnapshot>,
  nativeSupported = false,
): string | null {
  const unsupported = snapshot.sets.find(
    (set) => !["opa", "sentinel"].includes(set.kind) && !(nativeSupported && set.kind === "tfpolicy"),
  );
  return unsupported === undefined
    ? null
    : `${unsupported.kind} policy set ${unsupported.name} (${unsupported.id}) cannot be evaluated because the ${unsupported.kind} runtime is not supported`;
}

/** Reject unsupported native policy execution before preparing source, releasing
 * credentials, or starting an engine. Completion/apply checks remain necessary
 * because policy scope can change while a plan is running. */
export async function workspacePolicyPlanningError(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Workspace,
  nativeSupported = false,
): Promise<string | null> {
  try {
    const reason = unsupportedRuntimeError(await loadWorkspacePolicySnapshot(database, workspace), nativeSupported);
    return reason === null ? null : `Plan blocked: ${reason}`;
  } catch (error: unknown) {
    return `Plan blocked: policy configuration could not be verified: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

export async function captureWorkspacePolicyEvaluation(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Workspace,
  runId: string,
  dispatchKey?: string,
): Promise<WorkspacePolicyEvaluation> {
  const snapshot = await loadWorkspacePolicySnapshot(database, workspace);
  const id = newResourceId("pchk");
  const previous = await latestWorkspacePolicyEvaluation(database, runId);
  const createdAt = Math.max(Date.now(), (previous?.createdAt ?? 0) + 1);
  await database.insert(policyChecks).values({
    id,
    runId,
    status: "pending",
    result: {
      [CHECKPOINT]: true,
      fingerprint: snapshot.fingerprint,
      enforcementRevision: snapshot.enforcement.revision,
      ...(dispatchKey === undefined ? {} : { dispatchKey }),
    },
    createdAt,
  });
  if (snapshot.disabledSets.length > 0)
    await database.insert(logs).values({
      id: newResourceId("log"),
      runId,
      phase: "plan",
      createdAt: Date.now(),
      outputText: `[terrence] Policy enforcement intentionally disabled by administrator at revision ${snapshot.enforcement.revision}: ${snapshot.disabledSets.map((set) => `${set.kind}:${set.id}`).join(", ")}.`,
    });
  return { id, snapshot };
}

export async function latestWorkspacePolicyEvaluation(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  runId: string,
): Promise<Check | undefined> {
  const checks = await database.query.policyChecks.findMany({
    where: eq(policyChecks.runId, runId),
    orderBy: [desc(policyChecks.createdAt), desc(policyChecks.id)],
  });
  return checks.find(isPolicyEvaluationCheckpoint);
}

export async function completeWorkspacePolicyEvaluation(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Workspace,
  evaluation: Readonly<{ id: string; fingerprint: string }>,
): Promise<boolean> {
  const current = await loadWorkspacePolicySnapshot(database, workspace);
  const unchanged = current.fingerprint === evaluation.fingerprint;
  await database
    .update(policyChecks)
    .set({ status: unchanged ? "passed" : "errored" })
    .where(eq(policyChecks.id, evaluation.id));
  return unchanged;
}

function policyCheckAllowsApply(
  policy: Readonly<{ enforcementLevel: string }>,
  set: Readonly<{ kind: string; overridable: boolean | null }> | undefined,
  check: Check,
  checkpointId: string,
  allowOverride: boolean,
): boolean {
  if (check.status === "passed") return true;
  if (check.status === "failed" && policy.enforcementLevel === "advisory") return true;
  if (!policyFailureIsOverridable(policy, set)) return false;
  if (check.status === "overridden") return check.result?.["overrideEvaluationId"] === checkpointId;
  return allowOverride && ["failed", "soft_failed"].includes(check.status);
}

/** Invalid persisted settings or a failed read must deny admission, rather than
 * throw between an agent job claim and its lifecycle/lock association. */
export async function workspacePolicyExecutionError(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Workspace,
  runId?: string,
  allowOverride = false,
): Promise<string | null> {
  try {
    return await workspacePolicyExecutionErrorImpl(database, workspace, runId, allowOverride);
  } catch (error: unknown) {
    return `Apply blocked: policy configuration could not be verified: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

function nativeRuntimeConfigured(snapshot: DeepReadonly<WorkspacePolicySnapshot>, runId: string | undefined): boolean {
  return runId !== undefined && typeof snapshot.nativeInfo?.profileDigest === "string";
}

/** Recheck the exact generation at override and immediately before apply. */
async function workspacePolicyExecutionErrorImpl(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Workspace,
  runId?: string,
  allowOverride = false,
): Promise<string | null> {
  const snapshot = await loadWorkspacePolicySnapshot(database, workspace);
  const hasNative = snapshot.sets.some((set) => set.kind === "tfpolicy");
  const unsupported = unsupportedRuntimeError(snapshot, nativeRuntimeConfigured(snapshot, runId));
  if (unsupported !== null) return `Apply blocked: ${unsupported}`;
  if (runId === undefined) return null;
  const checkpoint = await latestWorkspacePolicyEvaluation(database, runId);
  // Historical runs without policy requirements remain usable. Newly attached
  // policies must never inherit a historical plan's implicit approval.
  if (checkpoint === undefined)
    return snapshot.sets.length === 0 ? null : "Apply blocked: policy evaluation is missing; create a new plan";
  if (checkpoint.result?.["fingerprint"] !== snapshot.fingerprint)
    return "Apply blocked: policies or enforcement settings changed after evaluation; create a new plan";
  if (checkpoint.status !== "passed")
    return "Apply blocked: policy evaluation is incomplete or errored; create a new plan";
  if (hasNative) {
    const reason = await nativeAdmissionError(database, workspace, runId, checkpoint, snapshot, allowOverride);
    if (reason !== null) return `Apply blocked: ${reason}`;
  }
  const checks = await database.query.policyChecks.findMany({ where: eq(policyChecks.runId, runId) });
  const currentChecks = checks.filter((check) => check.result?.["policyEvaluationId"] === checkpoint.id);
  for (const policy of snapshot.policies) {
    const matches = currentChecks.filter((check) => check.policyId === policy.id);
    if (matches.length !== 1) return "Apply blocked: a policy evaluation is missing or duplicated; create a new plan";
    const check = matches[0];
    if (check === undefined) return "Apply blocked: policy evaluation is missing";
    const set = snapshot.sets.find((item) => item.id === policy.policySetId);
    if (policyCheckAllowsApply(policy, set, check, checkpoint.id, allowOverride)) continue;
    return `Apply blocked: policy ${policy.name} ${check.status}; a successful evaluation or authorized override is required`;
  }
  return null;
}

/** Validated override targets from this evaluation only. Call in the transaction
 * that locks the run and writes the override plus its audit record. */
export async function overridableWorkspacePolicyChecks(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Workspace,
  runId: string,
  checkId?: string,
): Promise<readonly Check[]> {
  if ((await workspacePolicyExecutionError(database, workspace, runId, true)) !== null) return [];
  const checkpoint = await latestWorkspacePolicyEvaluation(database, runId);
  if (checkpoint === undefined) return [];
  const snapshot = await loadWorkspacePolicySnapshot(database, workspace);
  const checks = await database.query.policyChecks.findMany({ where: eq(policyChecks.runId, runId) });
  return checks.filter((check) => {
    if (checkId !== undefined && check.id !== checkId) return false;
    if (check.result?.["policyEvaluationId"] !== checkpoint.id || !["failed", "soft_failed"].includes(check.status))
      return false;
    if (check.result["native"] === true) {
      const set = snapshot.sets.find((item) => item.id === check.policySetId);
      return (
        set?.kind === "tfpolicy" &&
        check.status === "soft_failed" &&
        check.result["nativeEnforcement"] === "mandatory_overridable"
      );
    }
    const policy = snapshot.policies.find((item) => item.id === check.policyId);
    const set = snapshot.sets.find((item) => item.id === policy?.policySetId);
    return policy !== undefined && policyFailureIsOverridable(policy, set);
  });
}
