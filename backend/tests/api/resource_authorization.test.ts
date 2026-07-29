import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  configurationVersions,
  organizationMemberships,
  organizations,
  runs,
  stateVersions,
  users,
  workspaces,
  workspaceVariables,
} from "../../src/db/schema";

describe("direct resource authorization", () => {
  const suffix = crypto.randomUUID();
  const ownerId = `owner-${suffix}`;
  const unrelatedId = `unrelated-${suffix}`;
  const ownerToken = `user-owner-${suffix}`;
  const unrelatedToken = `user-unrelated-${suffix}`;
  const orgToken = `org-${suffix}`;
  const orgId = `org-a-${suffix}`;
  const otherOrgId = `org-b-${suffix}`;
  const orgName = `org-a-${suffix}`;
  const workspaceId = `ws-a-${suffix}`;
  const otherWorkspaceId = `ws-b-${suffix}`;
  const stateId = `state-${suffix}`;
  const variableId = `var-${suffix}`;
  const configurationVersionId = `cv-a-${suffix}`;
  const otherConfigurationVersionId = `cv-b-${suffix}`;
  const runId = `run-a-${suffix}`;
  const appliedRunId = `run-applied-${suffix}`;
  const archivePath = join(tmpdir(), `terrence-cv-${suffix}.tar.gz`);

  const request = (path: string, token: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await writeFile(archivePath, new Uint8Array([0x1f, 0x8b, 0x08]));
    await db.insert(users).values([
      { id: ownerId, username: ownerId, passwordHash: "unused" },
      { id: unrelatedId, username: unrelatedId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: otherOrgId, name: `org-b-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId: ownerId, orgId, role: "owner" },
      { id: crypto.randomUUID(), userId: unrelatedId, orgId: otherOrgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: ownerToken, userId: ownerId },
      { id: crypto.randomUUID(), token: unrelatedToken, userId: unrelatedId },
      { id: crypto.randomUUID(), token: orgToken, orgId },
    ]);
    await db.insert(workspaces).values([
      { id: workspaceId, name: `workspace-a-${suffix}`, orgId },
      { id: otherWorkspaceId, name: `workspace-b-${suffix}`, orgId: otherOrgId },
    ]);
    await db.insert(stateVersions).values({
      id: stateId,
      workspaceId,
      serial: 1,
      statePayload: JSON.stringify({ version: 4, resources: [] }),
    });
    await db.insert(workspaceVariables).values({
      id: variableId,
      workspaceId,
      key: "secret",
      value: "do-not-leak",
      sensitive: true,
    });
    await db.insert(configurationVersions).values([
      {
        id: configurationVersionId,
        workspaceId,
        status: "uploaded",
        archivePath,
      },
      {
        id: otherConfigurationVersionId,
        workspaceId: otherWorkspaceId,
        status: "uploaded",
      },
    ]);
    await db.insert(runs).values([
      {
        id: runId,
        workspaceId,
        configurationVersionId,
        status: "planned",
        createdAt: Date.now(),
      },
      {
        id: appliedRunId,
        workspaceId,
        status: "applied",
        createdAt: Date.now() + 1,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
    await db.delete(users).where(inArray(users.id, [ownerId, unrelatedId]));
    await rm(archivePath, { force: true });
  });

  it("hides cross-org resources and rejects principals that cannot plan or apply", async () => {
    const stateBody = {
      data: { type: "state-versions", attributes: { serial: 2, state: "{}" } },
    };
    const runBody = (workspace: string, cv?: string) => ({
      data: {
        type: "runs",
        relationships: {
          workspace: { data: { id: workspace, type: "workspaces" } },
          ...(cv ? { "configuration-version": { data: { id: cv, type: "configuration-versions" } } } : {}),
        },
      },
    });

    const crossOrgRequests: [string, string, unknown?][] = [
      [`/api/v2/workspaces/${workspaceId}/state-versions`, "GET"],
      [`/api/v2/workspaces/${workspaceId}/current-state-version`, "GET"],
      [`/api/v2/state-versions/${stateId}`, "GET"],
      [`/api/v2/state-versions/${stateId}/download`, "GET"],
      [`/api/v2/workspaces/${workspaceId}/state-versions`, "POST", stateBody],
      [`/api/v2/workspaces/${workspaceId}/vars`, "GET"],
      [`/api/v2/workspaces/${workspaceId}/vars`, "POST", {
        data: { type: "vars", attributes: { key: "injected", value: "no" } },
      }],
      [`/api/v2/workspaces/${workspaceId}/vars/${variableId}`, "GET"],
      [`/api/v2/workspaces/${workspaceId}/vars/${variableId}`, "PATCH", {
        data: { type: "vars", attributes: { value: "changed" } },
      }],
      [`/api/v2/workspaces/${workspaceId}/vars/${variableId}`, "DELETE"],
      [`/api/v2/workspaces/${workspaceId}/configuration-versions`, "GET"],
      [`/api/v2/workspaces/${workspaceId}/configuration-versions`, "POST"],
      [`/api/v2/configuration-versions/${configurationVersionId}`, "GET"],
      [`/api/v2/configuration-versions/${configurationVersionId}/download`, "GET"],
      [`/api/v2/workspaces/${workspaceId}/runs`, "GET"],
      [`/api/v2/organizations/${orgName}/runs`, "GET"],
      ["/api/v2/runs", "POST", runBody(workspaceId)],
      [`/api/v2/runs/${runId}`, "GET"],
      [`/api/v2/runs/${runId}/plan`, "GET"],
      [`/api/v2/plans/plan-${runId}`, "GET"],
      [`/api/v2/applies/apply-${runId}`, "GET"],
      [`/api/v2/runs/${runId}/run-events`, "GET"],
      [`/api/v2/runs/${runId}/logs`, "GET"],
      [`/api/v2/runs/${runId}/plan/log`, "GET"],
      [`/api/v2/runs/${runId}/apply/log`, "GET"],
      [`/api/v2/runs/${runId}/actions/apply`, "POST"],
      [`/api/v2/runs/${runId}/actions/discard`, "POST"],
      [`/api/v2/runs/${runId}/actions/cancel`, "POST"],
      [`/api/v2/runs/${runId}/actions/force-cancel`, "POST"],
      [`/api/v2/runs/${runId}`, "DELETE"],
    ];

    for (const [path, method, body] of crossOrgRequests) {
      expect((await request(path, unrelatedToken, method, body)).status, `${method} ${path}`).toBe(404);
    }

    expect((await request(`/api/v2/state-versions/${stateId}`, orgToken)).status).toBe(200);
    expect((await request(`/api/v2/configuration-versions/${configurationVersionId}`, orgToken)).status).toBe(200);
    expect((await request(`/api/v2/configuration-versions/${configurationVersionId}/download`, orgToken)).status).toBe(200);
    const orgRunResponse = await request(`/api/v2/runs/${runId}`, orgToken);
    expect(orgRunResponse.status).toBe(200);
    const orgRun = (await orgRunResponse.json()).data;
    expect(orgRun.attributes.actions["is-confirmable"]).toBe(false);
    expect(orgRun.attributes.permissions).toMatchObject({
      "can-apply": false,
      "can-discard": false,
      "can-override-policy-check": false,
    });
    const ownerRun = (await (await request(`/api/v2/runs/${runId}`, ownerToken)).json()).data;
    expect(ownerRun.attributes.actions["is-confirmable"]).toBe(true);
    expect(ownerRun.attributes.permissions["can-apply"]).toBe(true);
    expect((await request(`/api/v2/configuration-versions/${otherConfigurationVersionId}`, orgToken)).status).toBe(404);
    expect((await request("/api/v2/runs", orgToken, "POST", runBody(otherWorkspaceId))).status).toBe(404);
    expect((await request("/api/v2/runs", orgToken, "POST", runBody(workspaceId))).status).toBe(403);
    expect((await request(`/api/v2/runs/${runId}/actions/apply`, orgToken, "POST")).status).toBe(403);

    const mismatchedConfiguration = await request(
      "/api/v2/runs",
      ownerToken,
      "POST",
      runBody(workspaceId, otherConfigurationVersionId),
    );
    expect(mismatchedConfiguration.status).toBe(422);

    const alreadyApplied = await request(
      `/api/v2/runs/${appliedRunId}/actions/apply`,
      ownerToken,
      "POST",
    );
    expect(alreadyApplied.status).toBe(409);

    expect(await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId) }))
      .toHaveLength(1);
    expect(await db.query.workspaceVariables.findMany({ where: eq(workspaceVariables.workspaceId, workspaceId) }))
      .toMatchObject([{ id: variableId, value: "do-not-leak" }]);
    expect(await db.query.configurationVersions.findMany({ where: eq(configurationVersions.workspaceId, workspaceId) }))
      .toHaveLength(1);
    const storedRuns = await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) });
    expect(storedRuns).toHaveLength(2);
    expect(storedRuns.find(run => run.id === runId)?.status).toBe("planned");
    expect(storedRuns.find(run => run.id === appliedRunId)?.status).toBe("applied");
  });
});
