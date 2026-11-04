import { deleteOrganization } from "../../src/lib/lifecycle";
import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  adminSettings,
  logs,
  organizations,
  policies,
  policyChecks,
  policySetParameters,
  policySets,
  policySetWorkspaces,
  runs,
  workspaces,
} from "../../src/db/schema";
import {
  captureWorkspacePolicyEvaluation,
  completeWorkspacePolicyEvaluation,
  workspacePolicyExecutionError,
} from "../../src/lib/workspace-policy-gate";
import { executeApply } from "../../src/worker";

const organizationsToDelete: string[] = [];
afterEach(async () => {
  for (const id of organizationsToDelete.splice(0)) await deleteOrganization(id);
  await db.delete(adminSettings).where(eq(adminSettings.id, "policy-enforcement"));
});

async function fixture(kind = "opa", enforcementLevel = "mandatory", overridable = false) {
  const id = crypto.randomUUID();
  organizationsToDelete.push(id);
  await db.insert(organizations).values({ id, name: id });
  await db.insert(workspaces).values({ id, orgId: id, name: id });
  await db.insert(runs).values({ id, workspaceId: id, status: "apply_queued", createdAt: Date.now() });
  await db.insert(policySets).values({ id, orgId: id, name: "required safeguards", kind, overridable });
  await db.insert(policySetWorkspaces).values({ id, policySetId: id, workspaceId: id });
  await db.insert(policies).values({
    id,
    orgId: id,
    policySetId: id,
    name: "policy",
    kind,
    enforcementLevel,
    query: "data.test.deny",
    source: "package test\ndeny := []",
  });
  return { id, workspace: { id, orgId: id } };
}

async function evaluated(
  f: Awaited<ReturnType<typeof fixture>>,
  status = "passed",
  extraResult: Record<string, unknown> = {},
) {
  const evaluation = await captureWorkspacePolicyEvaluation(db, f.workspace, f.id);
  await db.insert(policyChecks).values({
    id: crypto.randomUUID(),
    runId: f.id,
    policyId: f.id,
    policySetId: f.id,
    status,
    result: { policyEvaluationId: evaluation.id, ...extraResult },
  });
  expect(
    await completeWorkspacePolicyEvaluation(db, f.workspace, {
      id: evaluation.id,
      fingerprint: evaluation.snapshot.fingerprint,
    }),
  ).toBe(true);
  return evaluation;
}

test("hosted apply refuses a previously passed plan after its policy source changes", async () => {
  const f = await fixture();
  await evaluated(f);
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toBeNull();
  await db.update(policies).set({ source: 'package test\ndeny := ["deny"]' }).where(eq(policies.id, f.id));
  await executeApply(f.id);
  expect((await db.query.runs.findFirst({ where: eq(runs.id, f.id) }))?.status).toBe("errored");
  const output = await db.query.logs.findMany({ where: eq(logs.runId, f.id) });
  expect(output.some((row) => row.outputText.includes("changed after evaluation"))).toBe(true);
});

test("completion rejects policy changes while execution is in flight", async () => {
  const f = await fixture();
  const evaluation = await captureWorkspacePolicyEvaluation(db, f.workspace, f.id);
  await db.update(policies).set({ enforcementLevel: "advisory" }).where(eq(policies.id, f.id));
  expect(
    await completeWorkspacePolicyEvaluation(db, f.workspace, {
      id: evaluation.id,
      fingerprint: evaluation.snapshot.fingerprint,
    }),
  ).toBe(false);
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toContain("changed after evaluation");
});

test("policy parameter and override authorization changes invalidate the evaluated generation", async () => {
  const f = await fixture();
  await evaluated(f);
  await db.insert(policySetParameters).values({ id: f.id, policySetId: f.id, key: "region", value: "eu-west-1" });
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toContain("changed after evaluation");
  await db.delete(policySetParameters).where(eq(policySetParameters.id, f.id));
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toBeNull();
  await db.update(policySets).set({ overridable: true }).where(eq(policySets.id, f.id));
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toContain("changed after evaluation");
});

test("a new applicable policy cannot inherit an empty plan's checkpoint", async () => {
  const f = await fixture();
  await db.delete(policySetWorkspaces).where(eq(policySetWorkspaces.id, f.id));
  const evaluation = await captureWorkspacePolicyEvaluation(db, f.workspace, f.id);
  await completeWorkspacePolicyEvaluation(db, f.workspace, {
    id: evaluation.id,
    fingerprint: evaluation.snapshot.fingerprint,
  });
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toBeNull();
  await db.insert(policySetWorkspaces).values({ id: f.id, policySetId: f.id, workspaceId: f.id });
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toContain("changed after evaluation");
});

test("a successful checkpoint cannot hide missing, duplicate, or stale policy results", async () => {
  const f = await fixture();
  const evaluation = await captureWorkspacePolicyEvaluation(db, f.workspace, f.id);
  await completeWorkspacePolicyEvaluation(db, f.workspace, {
    id: evaluation.id,
    fingerprint: evaluation.snapshot.fingerprint,
  });
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toContain("missing or duplicated");
  const checkId = crypto.randomUUID();
  await db.insert(policyChecks).values({
    id: checkId,
    runId: f.id,
    policyId: f.id,
    policySetId: f.id,
    status: "passed",
    result: { policyEvaluationId: "old-evaluation" },
  });
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toContain("missing or duplicated");
  await db
    .update(policyChecks)
    .set({ result: { policyEvaluationId: evaluation.id } })
    .where(eq(policyChecks.id, checkId));
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toBeNull();
  await db.insert(policyChecks).values({
    id: crypto.randomUUID(),
    runId: f.id,
    policyId: f.id,
    policySetId: f.id,
    status: "passed",
    result: { policyEvaluationId: evaluation.id },
  });
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toContain("missing or duplicated");
});

test.each(["errored", "unreachable", "pending", "skipped"])(
  "advisory %s results are blocking and cannot be overridden",
  async (status) => {
    const f = await fixture("sentinel", "advisory", true);
    await evaluated(f, status);
    expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toContain(`policy policy ${status}`);
    expect(await workspacePolicyExecutionError(db, f.workspace, f.id, true)).toContain(`policy policy ${status}`);
  },
);

test("valid advisory denials remain non-blocking", async () => {
  const f = await fixture("opa", "advisory");
  await evaluated(f, "failed");
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toBeNull();
});

test.each([
  ["sentinel", "soft-mandatory", false, true],
  ["sentinel", "hard-mandatory", false, false],
  ["sentinel", "hard-mandatory", true, true],
  ["opa", "mandatory", false, false],
  ["opa", "mandatory", true, true],
] as const)(
  "%s %s set override=%s follows authorized exception semantics",
  async (kind, level, setOverride, allowed) => {
    const f = await fixture(kind, level, setOverride);
    const evaluation = await evaluated(f, "failed");
    expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).not.toBeNull();
    expect((await workspacePolicyExecutionError(db, f.workspace, f.id, true)) === null).toBe(allowed);
    await db
      .update(policyChecks)
      .set({
        status: "overridden",
        result: { policyEvaluationId: evaluation.id, overrideEvaluationId: "stale-generation" },
      })
      .where(eq(policyChecks.policyId, f.id));
    expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).not.toBeNull();
    await db
      .update(policyChecks)
      .set({ result: { policyEvaluationId: evaluation.id, overrideEvaluationId: evaluation.id } })
      .where(eq(policyChecks.policyId, f.id));
    expect((await workspacePolicyExecutionError(db, f.workspace, f.id)) === null).toBe(allowed);
  },
);

test("admin bypass is dynamic, recorded, and cannot be reused after enforcement resumes", async () => {
  const f = await fixture();
  await db
    .insert(adminSettings)
    .values({ id: "policy-enforcement", values: { revision: 1, opa: false, sentinel: true } });
  const evaluation = await captureWorkspacePolicyEvaluation(db, f.workspace, f.id);
  expect(evaluation.snapshot.policies).toHaveLength(0);
  await completeWorkspacePolicyEvaluation(db, f.workspace, {
    id: evaluation.id,
    fingerprint: evaluation.snapshot.fingerprint,
  });
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toBeNull();
  const output = await db.query.logs.findMany({ where: eq(logs.runId, f.id) });
  expect(
    output.some((row) => row.outputText.includes("intentionally disabled") && row.outputText.includes("revision 1")),
  ).toBe(true);
  await db
    .update(adminSettings)
    .set({ values: { revision: 2, opa: true, sentinel: true } })
    .where(eq(adminSettings.id, "policy-enforcement"));
  expect(await workspacePolicyExecutionError(db, f.workspace, f.id)).toContain("changed after evaluation");
});
