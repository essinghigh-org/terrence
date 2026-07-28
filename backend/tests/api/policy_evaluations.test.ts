import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, organizationMemberships, projects, workspaces, runs, taskStages, policyEvaluations, policySetOutcomes } from "../../src/db/schema";

describe("Policy Evaluations & Outcomes API", () => {
  let token: string;
  let stageId: string;
  let evalId: string;

  beforeAll(async () => {
    const userId = `usr-${crypto.randomUUID()}`;
    const tokenVal = `test-token-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    const projId = `prj-${crypto.randomUUID()}`;
    const wsId = `ws-${crypto.randomUUID()}`;
    const runId = `run-${crypto.randomUUID()}`;
    stageId = `tstage-${crypto.randomUUID()}`;
    evalId = `poleval-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: `user_${Date.now()}`,
      passwordHash: "hash",
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: tokenVal,
      userId,
      createdAt: Date.now(),
    });

    await db.insert(organizations).values({
      id: orgId,
      name: `org-${crypto.randomUUID()}`,
    });

    await db.insert(organizationMemberships).values({
      id: `om-${crypto.randomUUID()}`,
      userId,
      orgId,
      role: "owner",
      status: "active",
    });

    await db.insert(projects).values({
      id: projId,
      orgId,
      name: "Default Project",
    });

    await db.insert(workspaces).values({
      id: wsId,
      orgId,
      projectId: projId,
      name: "ws-test",
      terraformVersion: "1.5.7",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await db.insert(runs).values({
      id: runId,
      workspaceId: wsId,
      status: "planning",
      createdAt: Date.now(),
    });

    await db.insert(taskStages).values({
      id: stageId,
      runId,
      stage: "post_plan",
      status: "passed",
      createdAt: Date.now(),
    });

    await db.insert(policyEvaluations).values({
      id: evalId,
      taskStageId: stageId,
      runId,
      status: "passed",
      policyKind: "opa",
      policyToolVersion: "0.44.0",
      createdAt: Date.now(),
    });

    await db.insert(policySetOutcomes).values({
      id: `outcome-${crypto.randomUUID()}`,
      policyEvaluationId: evalId,
      policySetName: "sentinel-checks",
      policyName: "check-cost",
      enforcementLevel: "mandatory",
      status: "passed",
      createdAt: Date.now(),
    });

    token = tokenVal;
  });

  test("GET /task-stages/:id/policy-evaluations returns evaluations list", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/task-stages/${stageId}/policy-evaluations`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);
  });

  test("GET /policy-evaluations/:id shows evaluation resource", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/policy-evaluations/${evalId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(evalId);
    expect(json.data.type).toBe("policy-evaluations");
  });

  test("GET /policy-evaluations/:id/policy-set-outcomes returns outcomes", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/policy-evaluations/${evalId}/policy-set-outcomes`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data[0].attributes["policy-name"]).toBe("check-cost");
  });
});
