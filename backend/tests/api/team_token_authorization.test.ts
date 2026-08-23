import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  assessmentResults,
  changeRequests,
  organizations,
  runTasks,
  runs,
  stateVersions,
  teams,
  teamWorkspaces,
  workspaces,
} from "../../src/db/schema";
import { executeRun } from "../../src/worker";

describe("team token workspace authorization", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-team-auth-${suffix}`;
  const orgName = `team-auth-${suffix}`;
  const workspaceId = `ws-team-auth-${suffix}`;
  const workspaceName = `assigned-${suffix}`;
  const unassignedWorkspaceId = `ws-team-unassigned-${suffix}`;
  const createdWorkspaceName = `managed-${suffix}`;
  const runTaskId = `task-team-auth-${suffix}`;
  const assessmentIds = {
    assigned: `asmtres-assigned-${suffix}`,
    unassigned: `asmtres-unassigned-${suffix}`,
  };
  const teamIds = {
    read: `team-read-${suffix}`,
    plan: `team-plan-${suffix}`,
    write: `team-write-${suffix}`,
    admin: `team-admin-${suffix}`,
    custom: `team-custom-${suffix}`,
    noState: `team-no-state-${suffix}`,
    manager: `team-manager-${suffix}`,
  };
  const tokens = Object.fromEntries(
    Object.keys(teamIds).map((role): [string, string] => [role, `team-${role}-token-${suffix}`]),
  ) as Record<keyof typeof teamIds, string>;
  const orgToken = `organization-token-${suffix}`;
  const applyRunIds = {
    plan: `run-plan-role-${suffix}`,
    write: `run-write-role-${suffix}`,
    custom: `run-custom-role-${suffix}`,
    organization: `run-org-role-${suffix}`,
  };
  const terminalStatuses = new Set(["applied", "errored", "canceled", "discarded", "force_canceled"]);

  const request = (path: string, auth: string, method = "GET", body?: unknown) => {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    return app.handle(new Request(`http://terrence.test${path}`, init));
  };

  const runBody = (attributes: Record<string, unknown> = {}) => ({
    data: {
      type: "runs",
      attributes,
      relationships: {
        workspace: { data: { id: workspaceId, type: "workspaces" } },
      },
    },
  });

  const waitForTerminalRun = async (runId: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
      if (run === undefined || terminalStatuses.has(run.status)) return;
      await Bun.sleep(10);
    }
  };

  const waitForWorkspaceUnlock = async (): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if ((await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { locked: true } }))?.locked !== true) return;
      await Bun.sleep(10);
    }
    throw new Error("Workspace remained locked after waiting for worker completion");
  };

  const responseData = async <T>(response: Readonly<Response>): Promise<T> => {
    const document = await response.json() as Readonly<{ data: T }>;
    return document.data;
  };

  beforeAll(async () => {
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(workspaces).values([
      { id: workspaceId, name: workspaceName, orgId, autoApply: true },
      { id: unassignedWorkspaceId, name: `unassigned-${suffix}`, orgId },
    ]);
    await db.insert(teams).values([
      { id: teamIds.read, orgId, name: `read-${suffix}` },
      {
        id: teamIds.plan,
        orgId,
        name: `plan-${suffix}`,
        organizationAccess: { "manage-run-tasks": true },
      },
      { id: teamIds.write, orgId, name: `write-${suffix}` },
      { id: teamIds.admin, orgId, name: `admin-${suffix}` },
      { id: teamIds.custom, orgId, name: `custom-${suffix}` },
      { id: teamIds.noState, orgId, name: `no-state-${suffix}` },
      {
        id: teamIds.manager,
        orgId,
        name: `manager-${suffix}`,
        organizationAccess: { "manage-run-tasks": true, "manage-workspaces": true },
      },
    ]);
    await db.insert(teamWorkspaces).values([
      { id: `tw-read-${suffix}`, teamId: teamIds.read, workspaceId, access: "read" },
      { id: `tw-plan-${suffix}`, teamId: teamIds.plan, workspaceId, access: "plan" },
      { id: `tw-write-${suffix}`, teamId: teamIds.write, workspaceId, access: "write" },
      { id: `tw-admin-${suffix}`, teamId: teamIds.admin, workspaceId, access: "admin" },
      {
        id: `tw-custom-${suffix}`,
        teamId: teamIds.custom,
        workspaceId,
        access: "custom",
        permissions: {
          runs: "apply",
          variables: "read",
          "state-versions": "read",
          "workspace-locking": true,
          "run-tasks": true,
        },
      },
      {
        id: `tw-no-state-${suffix}`,
        teamId: teamIds.noState,
        workspaceId,
        access: "custom",
        permissions: {
          runs: "read",
          variables: "none",
          "state-versions": "none",
        },
      },
    ]);
    await db.insert(apiTokens).values([
      ...Object.entries(teamIds).map(([role, teamId]) => ({
        id: `token-${role}-${suffix}`,
        token: createHash("sha256").update(tokens[role as keyof typeof teamIds]).digest("hex"),
        teamId,
      })),
      {
        id: `token-org-${suffix}`,
        token: createHash("sha256").update(orgToken).digest("hex"),
        orgId,
      },
    ]);
    await db.insert(runTasks).values({
      id: runTaskId,
      orgId,
      name: `task-${suffix}`,
      url: "https://example.test/run-task",
    });
    await db.insert(runs).values(Object.values(applyRunIds).map((id, index) => ({
      id,
      workspaceId,
      status: "planned",
      createdAt: Date.now() + index,
    })));
    await db.insert(stateVersions).values({
      id: `sv-outputs-${suffix}`,
      workspaceId,
      serial: 1,
      status: "finalized",
      statePayload: JSON.stringify({
        version: 4,
        serial: 1,
        lineage: "team-auth",
        resources: [],
        outputs: {
          probe_output: { type: "string", value: "visible-to-readers" },
        },
      }),
      jsonState: JSON.stringify({
        version: 4,
        serial: 1,
        lineage: "team-auth",
        resources: [],
        outputs: {
          probe_output: { type: "string", value: "visible-to-readers" },
        },
      }),
      createdAt: Date.now(),
    });
    await db.insert(assessmentResults).values([
      {
        id: assessmentIds.assigned,
        workspaceId,
        status: "completed",
        succeeded: true,
        jsonOutput: { workspace: "assigned" },
      },
      {
        id: assessmentIds.unassigned,
        workspaceId: unassignedWorkspaceId,
        status: "completed",
        succeeded: true,
        jsonOutput: { workspace: "unassigned" },
      },
    ]);
  });

  afterAll(async () => {
    await Promise.all(Object.values(applyRunIds).map(waitForTerminalRun));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("identifies team tokens and limits reads to assigned workspaces", async () => {
    const accountResponse = await request("/api/v2/account/details", tokens.read);
    expect(accountResponse.status).toBe(200);
    const account = await responseData<{ relationships: Record<string, { data: unknown }> }>(accountResponse);
    expect(account.relationships["authenticated-resource"]?.data).toEqual({
      id: teamIds.read,
      type: "teams",
    });

    for (const token of [
      tokens.read,
      tokens.plan,
      tokens.write,
      tokens.admin,
      tokens.custom,
      tokens.noState,
    ]) {
      expect((await request(`/api/v2/workspaces/${workspaceId}`, token)).status).toBe(200);
      expect((await request(`/api/v2/workspaces/${unassignedWorkspaceId}`, token)).status).toBe(404);
      expect((await request("/api/v2/runs", token, "POST", {
        data: {
          type: "runs",
          relationships: {
            workspace: { data: { id: unassignedWorkspaceId, type: "workspaces" } },
          },
        },
      })).status).toBe(404);
    }

    const listResponse = await request(`/api/v2/organizations/${orgName}/workspaces`, tokens.read);
    expect(listResponse.status).toBe(200);
    expect((await responseData<{ id: string }[]>(listResponse)).map((workspace) => workspace.id)).toEqual([workspaceId]);
  });

  it("enforces read and plan roles, including workspace auto-apply", async () => {
    expect((await request("/api/v2/runs", tokens.read, "POST", runBody())).status).toBe(403);
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, tokens.read, "POST")).status).toBe(403);
    expect((await request(`/api/v2/workspaces/${workspaceId}`, tokens.read, "PATCH", {
      data: { type: "workspaces", attributes: { description: "forbidden" } },
    })).status).toBe(403);

    expect((await request("/api/v2/runs", tokens.plan, "POST", runBody({ "auto-apply": true }))).status).toBe(403);
    const planResponse = await request("/api/v2/runs", tokens.plan, "POST", runBody({ message: "plan-only access" }));
    expect(planResponse.status).toBe(201);
    const planRunId = (await responseData<{ id: string }>(planResponse)).id;
    expect(await db.query.runs.findFirst({ where: eq(runs.id, planRunId) })).toMatchObject({
      autoApply: false,
      createdBy: null,
    });
    await executeRun(planRunId);
    expect((await db.query.runs.findFirst({ where: eq(runs.id, planRunId) }))?.status).toBe("planned");
    expect((await request(`/api/v2/runs/${applyRunIds.plan}/actions/apply`, tokens.plan, "POST")).status).toBe(403);
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, tokens.plan, "POST")).status).toBe(403);
  });

  it("reports the same workspace capabilities enforced by the API", async () => {
    const permissionsFor = async (token: string): Promise<Record<string, boolean>> => {
      const response = await request(`/api/v2/workspaces/${workspaceId}`, token);
      const workspace = await responseData<{ attributes: { permissions: Record<string, boolean> } }>(response);
      return workspace.attributes.permissions;
    };

    expect(await permissionsFor(tokens.read)).toMatchObject({
      "can-force-delete": false,
      "can-lock": false,
      "can-manage-run-tasks": false,
      "can-queue-apply": false,
      "can-queue-run": false,
      "can-update": false,
      "can-update-variable": false,
    });
    expect(await permissionsFor(tokens.plan)).toMatchObject({
      "can-force-delete": false,
      "can-lock": false,
      "can-manage-run-tasks": false,
      "can-queue-apply": false,
      "can-queue-run": true,
      "can-update": false,
    });
    expect(await permissionsFor(tokens.write)).toMatchObject({
      "can-force-delete": false,
      "can-lock": true,
      "can-queue-apply": true,
      "can-queue-run": true,
      "can-update": false,
      "can-update-variable": true,
    });
    expect(await permissionsFor(tokens.admin)).toMatchObject({
      "can-force-delete": true,
      "can-lock": true,
      "can-manage-run-tasks": false,
      "can-queue-apply": true,
      "can-queue-run": true,
      "can-update": true,
      "can-update-variable": true,
    });
    expect(await permissionsFor(tokens.manager)).toMatchObject({
      "can-force-delete": true,
      "can-manage-run-tasks": true,
      "can-update": true,
    });
    expect(await permissionsFor(tokens.custom)).toMatchObject({
      "can-manage-run-tasks": false,
      "can-read-state-versions": true,
      "can-read-variable": true,
    });
    expect(await permissionsFor(tokens.noState)).toMatchObject({
      "can-read-state-versions": false,
      "can-read-variable": false,
    });
    expect((await request(`/api/v2/workspaces/${workspaceId}/resources`, tokens.custom)).status)
      .toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}/resources`, tokens.noState)).status)
      .toBe(404);
    expect((await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, tokens.noState)).status)
      .toBe(404);

    const bindingBody = {
      data: {
        type: "workspace-run-tasks",
        attributes: { stage: "post_plan", "enforcement-level": "advisory" },
        relationships: { "run-task": { data: { id: runTaskId, type: "run-tasks" } } },
      },
    };
    expect((await request(`/api/v2/workspaces/${workspaceId}/run-tasks`, tokens.plan, "POST", bindingBody)).status).toBe(404);
    expect((await request(`/api/v2/workspaces/${workspaceId}/run-tasks`, tokens.custom, "POST", bindingBody)).status).toBe(404);
    expect((await request(`/api/v2/workspaces/${workspaceId}/run-tasks`, tokens.manager, "POST", bindingBody)).status).toBe(201);
    expect((await request(`/api/v2/workspaces/${workspaceId}/run-tasks/${runTaskId}`, tokens.manager, "DELETE")).status).toBe(204);
  });

  it("returns included workspace outputs to readers without state-read access", async () => {
    for (const token of [tokens.read, tokens.noState]) {
      const response = await request(`/api/v2/workspaces/${workspaceId}?include=outputs`, token);
      expect(response.status).toBe(200);
      const body = await response.json();
      const data = (body as { data: { id: string } }).data;
      expect(data.id).toBe(workspaceId);
      const relationships = (body as { data: { relationships: Record<string, unknown> } }).data.relationships;
      expect(relationships.outputs).toMatchObject({
        data: [
          { id: expect.any(String), type: "workspace-outputs" },
        ],
        links: { related: `/api/v2/workspaces/${workspaceId}/current-state-version-outputs` },
      });
      const included = (body as { included?: { id: string; type: string; attributes: Record<string, unknown> }[] }).included ?? [];
      expect(included.length).toBe(1);
      expect(included[0]?.type).toBe("workspace-outputs");
      expect(included[0]?.attributes).toMatchObject({
        name: "probe_output",
        value: "visible-to-readers",
        sensitive: false,
        "output-type": "string",
      });
    }
  });

  it("allows write and custom roles to plan/apply and lock, but not administer", async () => {
    const writeRunResponse = await request("/api/v2/runs", tokens.write, "POST", runBody({ message: "write access" }));
    expect(writeRunResponse.status).toBe(201);
    const writeRunId = (await responseData<{ id: string }>(writeRunResponse)).id;
    expect((await db.query.runs.findFirst({ where: eq(runs.id, writeRunId) }))?.autoApply).toBe(true);

    expect((await request(`/api/v2/runs/${applyRunIds.write}/actions/apply`, tokens.write, "POST")).status).toBe(202);
    await waitForTerminalRun(applyRunIds.write);
    await waitForWorkspaceUnlock();
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, tokens.write, "POST")).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/unlock`, tokens.write, "POST")).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}`, tokens.write, "PATCH", {
      data: { type: "workspaces", attributes: { description: "forbidden" } },
    })).status).toBe(403);

    expect((await request(`/api/v2/runs/${applyRunIds.custom}/actions/apply`, tokens.custom, "POST")).status).toBe(202);
    await waitForTerminalRun(applyRunIds.custom);
    await waitForWorkspaceUnlock();
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, tokens.custom, "POST")).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/unlock`, tokens.custom, "POST")).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}`, tokens.custom, "PATCH", {
      data: { type: "workspaces", attributes: { description: "forbidden" } },
    })).status).toBe(403);
    expect((await request(`/api/v2/workspaces/${workspaceId}/vars`, tokens.custom)).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}/vars`, tokens.custom, "POST", {
      data: { type: "vars", attributes: { key: "not-allowed", value: "no" } },
    })).status).toBe(404);
  });

  it("reserves workspace settings and force-cancel for admins", async () => {
    const patchResponse = await request(`/api/v2/workspaces/${workspaceId}`, tokens.admin, "PATCH", {
      data: { type: "workspaces", attributes: { description: "administered" } },
    });
    expect(patchResponse.status).toBe(200);
    expect((await responseData<{ attributes: { description: string } }>(patchResponse)).attributes.description).toBe("administered");

    const forceRunId = `run-force-${suffix}`;
    await db.insert(runs).values({
      id: forceRunId,
      workspaceId,
      status: "applying",
      statusTimestamps: { "cancel-requested-at": new Date().toISOString() },
      createdAt: Date.now(),
    });
    expect((await request(`/api/v2/runs/${forceRunId}/actions/force-cancel`, tokens.write, "POST")).status).toBe(403);
    expect((await request(`/api/v2/runs/${forceRunId}/actions/force-cancel`, tokens.admin, "POST")).status).toBe(202);
  });

  it("propagates team workspace access through assessment and change request APIs", async () => {
    expect((await request(`/api/v2/assessment-results/${assessmentIds.assigned}`, tokens.read)).status).toBe(200);
    expect((await request(`/api/v2/assessment-results/${assessmentIds.assigned}/check-results`, tokens.read)).status).toBe(200);
    expect((await request(`/api/v2/runs/${applyRunIds.plan}/check-results`, tokens.read)).status).toBe(200);
    expect((await request(`/api/v2/assessment-results/${assessmentIds.unassigned}`, tokens.read)).status).toBe(404);
    expect((await request(`/api/v2/assessment-results/${assessmentIds.assigned}/json-output`, tokens.read)).status).toBe(403);
    expect((await request(`/api/v2/assessment-results/${assessmentIds.assigned}/json-output`, tokens.admin)).status).toBe(200);
    expect((await request(`/api/v2/assessment-results/${assessmentIds.unassigned}/json-output`, tokens.manager)).status).toBe(200);
    expect((await request(`/api/v2/assessment-results/${assessmentIds.assigned}/json-output`, orgToken)).status).toBe(403);

    const body = {
      data: {
        type: "workspace-change-requests",
        attributes: { subject: "Rotate credentials", message: "Use short-lived credentials." },
      },
    };
    expect((await request(`/api/v2/workspaces/${workspaceId}/change-requests`, tokens.read, "POST", body)).status).toBe(404);
    const createdResponse = await request(`/api/v2/workspaces/${workspaceId}/change-requests`, tokens.admin, "POST", body);
    expect(createdResponse.status).toBe(201);
    const created = await responseData<{ id: string }>(createdResponse);

    expect((await request(`/api/v2/workspaces/${workspaceName}/change-requests`, tokens.read)).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${unassignedWorkspaceId}/change-requests`, tokens.read)).status).toBe(404);
    expect((await request(`/api/v2/change-requests/${created.id}`, tokens.read)).status).toBe(200);
    expect((await request(`/api/v2/change-requests/${created.id}/actions/approve`, tokens.read, "POST")).status).toBe(200);
    expect((await db.query.changeRequests.findFirst({ where: eq(changeRequests.id, created.id) }))?.status).toBe("approved");

    const archiveResponse = await request(`/api/v2/workspaces/${workspaceId}/change-requests`, tokens.admin, "POST", {
      data: {
        type: "workspace-change-requests",
        attributes: { subject: "Archive credentials request", message: "The credential work is complete." },
      },
    });
    const archiveId = (await responseData<{ id: string }>(archiveResponse)).id;
    expect((await request(`/api/v2/workspaces/change-requests/${archiveId}`, tokens.read, "PATCH")).status).toBe(404);
    expect((await request(`/api/v2/workspaces/change-requests/${archiveId}`, tokens.plan, "PATCH")).status).toBe(404);
    expect((await request(`/api/v2/workspaces/change-requests/${archiveId}`, tokens.write, "PATCH")).status).toBe(200);
  });

  it("honors manage-workspaces organization access as workspace admin access", async () => {
    expect((await request(`/api/v2/workspaces/${unassignedWorkspaceId}`, tokens.manager)).status).toBe(200);
    expect((await request("/api/v2/runs", tokens.manager, "POST", runBody())).status).toBe(201);
    const createResponse = await request(`/api/v2/organizations/${orgName}/workspaces`, tokens.manager, "POST", {
      data: { type: "workspaces", attributes: { name: createdWorkspaceName } },
    });
    expect(createResponse.status).toBe(201);
  });

  it("keeps organization tokens unable to plan or apply", async () => {
    const readResponse = await request(`/api/v2/runs/${applyRunIds.organization}`, orgToken);
    expect(readResponse.status).toBe(200);
    const run = await responseData<{ attributes: { permissions: Record<string, boolean> } }>(readResponse);
    expect(run.attributes.permissions["can-apply"]).toBe(false);
    expect((await request("/api/v2/runs", orgToken, "POST", runBody())).status).toBe(403);
    expect((await request(`/api/v2/runs/${applyRunIds.organization}/actions/apply`, orgToken, "POST")).status).toBe(403);
  });
});
