import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  policyEvaluations,
  policySetOutcomes,
  runs,
  taskStages,
  users,
  workspaces,
} from "../../src/db/schema";

describe("TF policy evaluations (audit finding 3)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const outsiderId = `outsider-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `tfpe-org-${suffix}`;
  const foreignOrgId = `foreign-org-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const runId = `run-${suffix}`;
  const stageId = `tstg-${suffix}`;
  const evalId = `tfpe-${suffix}`;
  const token = `token-${suffix}`;
  const outsiderToken = `outsider-${suffix}`;

  const request = (path: string, auth?: string) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: auth === undefined ? {} : { Authorization: "Bearer " + auth },
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, username: `tfpe-${suffix}`, passwordHash: "unused" },
      { id: outsiderId, username: `outsider-${suffix}`, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: foreignOrgId, name: `foreign-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values([
      { id: `membership-${suffix}`, userId, orgId, role: "owner" },
      { id: `outsider-membership-${suffix}`, userId: outsiderId, orgId: foreignOrgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([
      { id: `token-${suffix}`, token: hashAuthenticationToken(token), userId },
      { id: `outsider-token-${suffix}`, token: hashAuthenticationToken(outsiderToken), userId: outsiderId },
    ]);
    await db.insert(workspaces).values({ id: workspaceId, name: "TFPE", orgId });
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "planned",
      message: "tfpe check",
      isDestroy: false,
      createdAt: Date.now(),
    });
    await db.insert(taskStages).values({ id: stageId, runId, stage: "post_plan", status: "passed" });
    await db.insert(policyEvaluations).values({
      id: evalId,
      runId,
      taskStageId: stageId,
      status: "passed",
      resultCount: { passed: 2 },
    });
    await db.insert(policySetOutcomes).values([
      {
        id: `outcome-pass-${suffix}`,
        policyEvaluationId: evalId,
        policySetName: "set-a",
        policyName: "always-pass",
        enforcementLevel: "mandatory",
        status: "passed",
      },
      {
        id: `outcome-fail-${suffix}`,
        policyEvaluationId: evalId,
        policySetName: "set-a",
        policyName: "needs-work",
        enforcementLevel: "advisory",
        status: "failed",
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, foreignOrgId]));
    await db.delete(users).where(inArray(users.id, [userId, outsiderId]));
  });

  it("links evaluations from the run read and sideloads them with stage types", async () => {
    const res = await request(`/api/v2/runs/${runId}?include=tf_policy_evaluations`, token);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { relationships: Record<string, { data?: unknown }> };
      included: { id: string; type: string; attributes: Record<string, unknown> }[];
    };
    expect(body.data.relationships["tf-policy-evaluations"]?.data).toEqual([
      { id: evalId, type: "tf-policy-evaluations" },
    ]);
    const evaluation = body.included.find((item): boolean => item.type === "tf-policy-evaluations");
    expect(evaluation?.id).toBe(evalId);
    expect(evaluation?.attributes["status"]).toBe("passed");
    expect(evaluation?.attributes["stage-type"]).toBe("Plan");
  });

  it("serves paginated outcomes with per-policy entries the CLI renders", async () => {
    const res = await request(`/api/v2/tf-policy-evaluations/${evalId}/tf-policy-set-outcomes`, token);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { id: string; type: string; attributes: Record<string, unknown> }[];
      meta: { pagination: Record<string, unknown> };
    };
    expect(body.data).toHaveLength(2);
    for (const item of body.data) expect(item.type).toBe("tf-policy-set-outcomes");
    const names = body.data.flatMap((item): unknown[] => {
      const outcomes = (item.attributes["outcomes"] as { policy_name: string }[] | undefined) ?? [];
      return outcomes.map((o): string => o.policy_name);
    });
    expect(names).toContain("always-pass");
    expect(names).toContain("needs-work");
    expect(body.meta.pagination["total-count"]).toBe(2);

    const filtered = await request(
      `/api/v2/tf-policy-evaluations/${evalId}/tf-policy-set-outcomes?filter[status]=failed`,
      token,
    );
    const filteredBody = await filtered.json() as { data: { id: string }[] };
    expect(filteredBody.data.map((item): string => item.id)).toEqual([`outcome-fail-${suffix}`]);
  });

  it("hides evaluations and outcomes from outsiders", async () => {
    expect((await request(`/api/v2/runs/${runId}/tf-policy-evaluations`, outsiderToken)).status).toBe(404);
    expect((await request(`/api/v2/tf-policy-evaluations/${evalId}/tf-policy-set-outcomes`, outsiderToken)).status).toBe(404);
    expect((await request(`/api/v2/tf-policy-evaluations/missing-${suffix}/tf-policy-set-outcomes`, token)).status).toBe(404);
  });

  it("reads a single outcome through its self link", async () => {
    const res = await request(`/api/v2/tf-policy-set-outcomes/outcome-pass-${suffix}`, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; type: string } };
    expect(body.data.type).toBe("tf-policy-set-outcomes");
    expect((await request(`/api/v2/tf-policy-set-outcomes/outcome-pass-${suffix}`, outsiderToken)).status).toBe(404);
  });
});
