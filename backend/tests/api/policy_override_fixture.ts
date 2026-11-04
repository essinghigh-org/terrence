import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { policies, policyChecks, policySets, policySetWorkspaces, runs, workspaces } from "../../src/db/schema";
import {
  captureWorkspacePolicyEvaluation,
  completeWorkspacePolicyEvaluation,
} from "../../src/lib/workspace-policy-gate";

/** Seed persisted evaluation state for authorization/audit tests. Engine parsing
 * is exercised separately at the worker and agent completion boundaries. */
export async function seedOverridablePolicyCheck(runId: string, checkId = `check-${runId}`): Promise<void> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (run === undefined) throw new Error("Missing fixture run");
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
  if (workspace === undefined) throw new Error("Missing fixture workspace");
  const id = `policy-fixture-${workspace.id}`;
  if ((await db.query.policySets.findFirst({ where: eq(policySets.id, id) })) === undefined) {
    await db.insert(policySets).values({ id, orgId: workspace.orgId, name: id, kind: "sentinel", overridable: false });
    await db.insert(policySetWorkspaces).values({ id, policySetId: id, workspaceId: workspace.id });
    await db.insert(policies).values({
      id,
      orgId: workspace.orgId,
      policySetId: id,
      name: "fixture denial",
      kind: "sentinel",
      enforcementLevel: "soft-mandatory",
      source: "main = rule { false }",
    });
  }
  await db.update(runs).set({ status: "policy_soft_failed" }).where(eq(runs.id, runId));
  const evaluation = await captureWorkspacePolicyEvaluation(db, workspace, runId);
  const values = {
    runId,
    policyId: id,
    policySetId: id,
    status: "soft_failed",
    result: { passed: false, policyEvaluationId: evaluation.id },
    createdAt: Date.now(),
  };
  await db
    .insert(policyChecks)
    .values({ id: checkId, ...values })
    .onConflictDoUpdate({ target: policyChecks.id, set: values });
  await completeWorkspacePolicyEvaluation(db, workspace, {
    id: evaluation.id,
    fingerprint: evaluation.snapshot.fingerprint,
  });
}
