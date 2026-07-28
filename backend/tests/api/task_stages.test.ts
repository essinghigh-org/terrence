import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, organizationMemberships, projects, workspaces, runs, taskStages, runTasks } from "../../src/db/schema";

describe("Task Stages & Multi-Stage API", () => {
  let token: string;
  let runId: string;
  let stageId: string;

  beforeAll(async () => {
    const userId = `usr-${crypto.randomUUID()}`;
    const tokenVal = `test-token-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    const projId = `prj-${crypto.randomUUID()}`;
    const wsId = `ws-${crypto.randomUUID()}`;
    runId = `run-${crypto.randomUUID()}`;
    stageId = `tstage-${crypto.randomUUID()}`;

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
      stage: "pre_plan",
      status: "failed",
      createdAt: Date.now(),
    });

    token = tokenVal;
  });

  test("GET /runs/:run_id/task-stages lists task stages", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/task-stages`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);
  });

  test("GET /task-stages/:id shows stage resource", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/task-stages/${stageId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(stageId);
    expect(json.data.type).toBe("task-stages");
  });

  test("PATCH /task-stages/:id/actions/override overrides failed stage", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/task-stages/${stageId}/actions/override`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.attributes.status).toBe("passed");
  });
});
