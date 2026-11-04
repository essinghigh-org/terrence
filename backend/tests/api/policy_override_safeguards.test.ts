import { afterEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  auditLogs,
  organizationMemberships,
  organizations,
  policies,
  policyChecks,
  policySets,
  policySetWorkspaces,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import {
  captureWorkspacePolicyEvaluation,
  completeWorkspacePolicyEvaluation,
} from "../../src/lib/workspace-policy-gate";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) {
    await db.delete(organizations).where(eq(organizations.id, id));
    await db.delete(users).where(eq(users.id, id));
  }
});
async function fixture(kind = "sentinel", level = "soft-mandatory", overridable = false, status = "soft_failed") {
  const id = crypto.randomUUID();
  ids.push(id);
  await db.insert(users).values({ id, username: id, passwordHash: "unused" });
  await db.insert(organizations).values({ id, name: id });
  await db.insert(organizationMemberships).values({ id, orgId: id, userId: id, role: "owner" });
  await db.insert(apiTokens).values({ id, userId: id, token: hashAuthenticationToken(id) });
  await db.insert(workspaces).values({ id, orgId: id, name: id });
  await db.insert(runs).values({ id, workspaceId: id, status: "policy_soft_failed", createdAt: Date.now() });
  await db.insert(policySets).values({ id, orgId: id, kind, name: id, overridable });
  await db.insert(policySetWorkspaces).values({ id, workspaceId: id, policySetId: id });
  await db.insert(policies).values({
    id,
    orgId: id,
    kind,
    policySetId: id,
    name: id,
    enforcementLevel: level,
    source: "main = rule { false }",
  });
  const evaluation = await captureWorkspacePolicyEvaluation(db, { id, orgId: id }, id);
  await db.insert(policyChecks).values({
    id,
    runId: id,
    policyId: id,
    policySetId: id,
    status,
    result: { passed: false, policyEvaluationId: evaluation.id },
  });
  await completeWorkspacePolicyEvaluation(
    db,
    { id, orgId: id },
    { id: evaluation.id, fingerprint: evaluation.snapshot.fingerprint },
  );
  const request = (path: string, method = "GET") =>
    app.handle(
      new Request(`http://terrence.test${path}`, {
        method,
        headers: { Authorization: `Bearer ${id}`, "Content-Type": "application/vnd.api+json" },
        ...(method === "POST"
          ? { body: JSON.stringify({ data: { attributes: { comment: "Reviewed and accepted this finding." } } }) }
          : {}),
      }),
    );
  return { id, evaluation, request };
}

for (const endpoint of ["check", "run"] as const) {
  for (const entry of [
    ["sentinel", "soft-mandatory", false, "soft_failed", 200],
    ["sentinel", "hard-mandatory", false, "failed", 409],
    ["sentinel", "hard-mandatory", true, "soft_failed", 200],
    ["opa", "mandatory", false, "failed", 409],
    ["opa", "mandatory", true, "soft_failed", 200],
    ["sentinel", "advisory", true, "failed", 409],
    ["sentinel", "soft-mandatory", true, "errored", 409],
    ["sentinel", "advisory", true, "unreachable", 409],
    ["sentinel", "soft-mandatory", true, "skipped", 409],
    ["sentinel", "soft-mandatory", true, "passed", 409],
  ] as const) {
    const [kind, level, allowed, status, expected] = entry;
    test(`${endpoint} override: ${kind}/${level}/${status} with set override ${allowed}`, async () => {
      const { id, evaluation, request } = await fixture(kind, level, allowed, status);
      const path =
        endpoint === "check"
          ? `/api/v2/policy-checks/${id}/actions/override`
          : `/api/v2/runs/${id}/actions/override-policy`;
      expect((await request(path, "POST")).status).toBe(expected);
      const check = await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, id) });
      expect(check?.status).toBe(expected === 200 ? "overridden" : status);
      const audits = await db.query.auditLogs.findMany({
        where: and(eq(auditLogs.resourceId, id), eq(auditLogs.action, "override-policy")),
      });
      expect(audits).toHaveLength(expected === 200 ? 1 : 0);
      if (expected === 200) {
        expect(check?.result?.["overrideEvaluationId"]).toBe(evaluation.id);
        const details = audits[0]?.details as Record<string, unknown> | null | undefined;
        expect(details?.["policyEvaluationId"]).toBe(evaluation.id);
      }
    });
  }
  test(`${endpoint} override rejects changed policy source and leaves no override audit`, async () => {
    const { id, request } = await fixture();
    await db.update(policies).set({ source: "main = rule { true }" }).where(eq(policies.id, id));
    const path =
      endpoint === "check"
        ? `/api/v2/policy-checks/${id}/actions/override`
        : `/api/v2/runs/${id}/actions/override-policy`;
    expect((await request(path, "POST")).status).toBe(409);
    expect((await db.query.runs.findFirst({ where: eq(runs.id, id) }))?.status).toBe("policy_soft_failed");
    expect(
      await db.query.auditLogs.findMany({
        where: and(eq(auditLogs.resourceId, id), eq(auditLogs.action, "override-policy")),
      }),
    ).toHaveLength(0);
  });
}

test("internal evaluation checkpoint is absent from lists, linkage, detail, output and override", async () => {
  const { id, evaluation, request } = await fixture();
  const listed = await (await request(`/api/v2/runs/${id}/policy-checks`)).json();
  expect(listed.data.map((item: { id: string }) => item.id)).toEqual([id]);
  const run = await (await request(`/api/v2/runs/${id}`)).json();
  expect(run.data.relationships["policy-checks"].data.map((item: { id: string }) => item.id)).toEqual([id]);
  for (const suffix of ["", "/output", "/actions/override"])
    expect(
      (await request(`/api/v2/policy-checks/${evaluation.id}${suffix}`, suffix.includes("override") ? "POST" : "GET"))
        .status,
    ).toBe(404);
});

test("concurrent policy overrides audit only the successful transition", async () => {
  const { id, request } = await fixture();
  const path = `/api/v2/policy-checks/${id}/actions/override`;
  const responses = await Promise.all([request(path, "POST"), request(path, "POST")]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(
    await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.resourceId, id), eq(auditLogs.action, "override-policy")),
    }),
  ).toHaveLength(1);
});
