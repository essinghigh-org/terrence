import { describe, expect, it, beforeEach } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, organizations, organizationMemberships, teams, projects, workspaces, runs, runComments, runTasks, runTaskResults, workspaceRunTasks, apiTokens, auditLogs } from "../../src/db/schema";
import { writePlanJsonArtifact } from "../../src/lib/plan-json";
describe("Epics 9-14: Runs Comments, Tasks, Tokens, Entitlements & Audit Logs", () => {
  let userToken: string;
  let userId: string;
  let orgName: string;
  let orgId: string;
  let teamId: string;
  let workspaceId: string;
  let runId: string;

  beforeEach(async () => {
    await db.delete(apiTokens);
    await db.delete(auditLogs);
    await db.delete(runTaskResults);
    await db.delete(workspaceRunTasks);
    await db.delete(runTasks);
    await db.delete(runComments);
    await db.delete(runs);
    await db.delete(workspaces);
    await db.delete(projects);
    await db.delete(teams);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(users);

    userId = `usr-${crypto.randomUUID()}`;
    userToken = `test-user-token-${crypto.randomUUID()}`;
    orgName = `epic914-org-${crypto.randomUUID().substring(0, 8)}`;
    orgId = `org-${crypto.randomUUID()}`;
    teamId = `team-${crypto.randomUUID()}`;
    workspaceId = `ws-${crypto.randomUUID()}`;
    runId = `run-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: "epic914_owner",
      email: "owner@epic914.local",
      passwordHash: "hashed",
      isSiteAdmin: true,
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: userToken,
      userId,
      createdAt: Date.now(),
    });

    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
    });

    await db.insert(organizationMemberships).values({
      id: `orgmem-owner`,
      orgId,
      userId,
      role: "owner",
      status: "active",
    });

    await db.insert(teams).values({
      id: teamId,
      orgId,
      name: "DevOps Team",
    });

    await db.insert(workspaces).values({
      id: workspaceId,
      name: "cluster-core",
      orgId,
      autoApply: false,
      terraformVersion: "latest",
    });

    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "planned",
      message: "Deploy cluster core",
      createdAt: Date.now(),
    });
    await writePlanJsonArtifact(runId, {
      format_version: "1.2",
      terraform_version: "1.9.8",
      resource_changes: [{ address: "terraform_data.example" }],
    });
  });

  it("manages run apply comments, comments API, and plan JSON output", async () => {
    // Post comment on run apply action
    const applyRes = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/actions/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          comment: "Approved by SRE on call",
        }),
      })
    );
    expect(applyRes.status).toBe(200);

    // List run comments
    const listRes = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/comments`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.length).toBe(1);
    expect(listBody.data[0].attributes.body).toBe("Approved by SRE on call");
    expect(listBody.data[0].attributes["actor-username"]).toBe("epic914_owner");

    const commentRes = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: { type: "comments", attributes: { body: "Ready to continue" } },
        }),
      }),
    );
    expect(commentRes.status).toBe(201);
    expect((await commentRes.json()).data.attributes).toMatchObject({
      body: "Ready to continue",
      "actor-username": "epic914_owner",
    });

    // Fetch plan JSON output
    const planRes = await app.handle(
      new Request(`http://localhost/api/v2/plans/${runId}/json-output`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(planRes.status).toBe(200);
    const planBody = await planRes.json();
    expect(planBody).toMatchObject({
      format_version: "1.2",
      terraform_version: "1.9.8",
      resource_changes: [{ address: "terraform_data.example" }],
    });
  });

  it("manages Team and Organization Authentication Tokens", async () => {
    const postTeamTok = await app.handle(
      new Request(`http://localhost/api/v2/teams/${teamId}/authentication-token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(postTeamTok.status).toBe(201);
    const teamTokBody = await postTeamTok.json();
    expect(teamTokBody.data.attributes.token).toContain("team-tok-");

    const postOrgTok = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/authentication-token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(postOrgTok.status).toBe(201);
    const orgTokBody = await postOrgTok.json();
    expect(orgTokBody.data.attributes.token).toContain("org-");
  });

  it("manages Run Tasks and Workspace Task Bindings", async () => {
    const createTask = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/run-tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "run-tasks",
            attributes: {
              name: "Security Vulnerability Scanner",
              url: "https://security.internal/scan",
            },
          },
        }),
      })
    );
    expect(createTask.status).toBe(201);
    const taskBody = await createTask.json();
    const taskId = taskBody.data.id;

    const bindTask = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/run-tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "workspace-run-tasks",
            attributes: {
              stage: "post_plan",
              "enforcement-level": "advisory",
            },
            relationships: {
              "run-task": { data: { id: taskId, type: "run-tasks" } },
            },
          },
        }),
      })
    );
    expect(bindTask.status).toBe(201);
    const bindingsResponse = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/run-tasks`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(bindingsResponse.status).toBe(200);
    expect((await bindingsResponse.json()).data[0].attributes).toMatchObject({
      "run-task-name": "Security Vulnerability Scanner",
      "run-task-enabled": true,
    });

    await db.insert(runTaskResults).values({
      id: `taskrs-${crypto.randomUUID()}`,
      runId,
      runTaskId: taskId,
      status: "passed",
      message: "Scan complete",
    });
    const headers = { Authorization: `Bearer ${userToken}` };
    const [runResults, taskResults] = await Promise.all([
      app.handle(new Request(`http://localhost/api/v2/runs/${runId}/run-tasks`, { headers })),
      app.handle(new Request(`http://localhost/api/v2/run-tasks/${taskId}/task-results`, { headers })),
    ]);
    expect(runResults.status).toBe(200);
    expect(taskResults.status).toBe(200);
    expect((await runResults.json()).data[0].attributes).toMatchObject({
      status: "passed",
      message: "Scan complete",
    });
    expect((await taskResults.json()).data).toHaveLength(1);
  });

  it("returns Entitlements and Organization Audit Logs", async () => {
    const entRes = await app.handle(
      new Request("http://localhost/api/v2/entitlements", {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(entRes.status).toBe(200);
    const entBody = await entRes.json();
    expect(entBody.data.attributes.state_storage).toBe(true);

    const auditRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/audit-logs`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(auditRes.status).toBe(200);
  });

  it("manages Agent Pools and receives Webhook events", async () => {
    const createPool = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/agent-pools`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: { type: "agent-pools", attributes: { name: "homelab-k8s-agents" } },
        }),
      })
    );
    expect(createPool.status).toBe(201);

    const ghWebhook = await app.handle(
      new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "refs/heads/main" }),
      })
    );
    expect(ghWebhook.status).toBe(401); // fail closed without configured secret
  });
});
