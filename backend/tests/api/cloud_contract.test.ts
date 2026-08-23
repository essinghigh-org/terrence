import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rm } from "fs/promises";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { TFP_API_VERSION } from "../../src/lib/constants";
import {
  apiTokens,
  configurationVersions,
  logs,
  organizationMemberships,
  organizations,
  runs,
  stateVersions,
  users,
  workspaces,
} from "../../src/db/schema";
import { validTarGzip } from "./test-archives";

describe("Terraform cloud protocol contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `cloud-contract-${suffix}`;
  const membershipId = `membership-${suffix}`;
  const tokenId = `token-${suffix}`;
  const token = `cloud-token-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const runId = `run-${suffix}`;
  let configurationVersionId = "";

  const request = (path: string, init?: RequestInit) =>
    app.handle(new Request(new URL(path, "http://terrence.test"), init));

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/vnd.api+json",
  };

  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      username: `cloud-contract-${suffix}`,
      passwordHash: "unused",
    });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: membershipId,
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({ id: tokenId, token, userId });
    await db.insert(workspaces).values({
      id: workspaceId,
      name: "cloud-contract",
      orgId,
      autoApply: false,
      locked: false,
    });
  });

  afterAll(async () => {
    const configurationVersion = configurationVersionId
      ? await db.query.configurationVersions.findFirst({
          where: eq(configurationVersions.id, configurationVersionId),
        })
      : undefined;

    await db.delete(logs).where(eq(logs.runId, runId));
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, membershipId));
    await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));

    if (configurationVersion?.archivePath) {
      await rm(configurationVersion.archivePath, { force: true });
    }
  });

  it("supports discovery and workspace endpoint details", async () => {
    const pingResponse = await request("/api/v2/ping");
    expect(pingResponse.status).toBe(200);
    expect(pingResponse.headers.get("TFP-API-Version")).toBe(TFP_API_VERSION);
    // TFP-AppName is intentionally omitted: its literal value is a vendor
    // trademark string and is not required by any run/registry flow.
    expect(pingResponse.headers.get("TFP-AppName")).toBeNull();

    const workspaceResponse = await request(`/api/v2/workspaces/${workspaceId}`, {
      headers: authHeaders,
    });
    expect(workspaceResponse.status).toBe(200);
    const workspace = (await workspaceResponse.json()).data;
    expect(workspace.attributes["execution-mode"]).toBe("remote");
    expect(workspace.attributes["iac-binary"]).toBe("terraform");
    expect(workspace.attributes["structured-run-output-enabled"]).toBe(true);
    expect(workspace.attributes.permissions).toMatchObject({
      "can-queue-apply": true,
      "can-queue-run": true,
      "can-update": true,
    });
  });

  it("supports configuration version creation, upload, and listing", async () => {
    const createConfigurationResponse = await request(
      `/api/v2/workspaces/${workspaceId}/configuration-versions`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "configuration-versions",
            attributes: { speculative: true, provisional: false },
          },
        }),
      },
    );
    expect(createConfigurationResponse.status).toBe(201);
    const createdConfiguration = await createConfigurationResponse.json();
    configurationVersionId = createdConfiguration.data.id;
    const uploadUrl = createdConfiguration.data.attributes["upload-url"];
    expect(typeof uploadUrl).toBe("string");
    const uploadLocation = new URL(uploadUrl);
    expect(uploadLocation.pathname).toBe(`/api/v2/configuration-versions/${configurationVersionId}/upload`);
    expect(uploadLocation.searchParams.has("expires")).toBe(true);
    expect(uploadLocation.searchParams.has("signature")).toBe(true);
    expect(createdConfiguration.data.attributes.speculative).toBe(true);
    expect(createdConfiguration.data.attributes.source).toBe("tfe-api");

    const uploadResponse = await request(uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: validTarGzip("cloud-contract"),
    });
    expect(uploadResponse.status).toBe(200);
    const downloadResponse = await request(
      `/api/v2/configuration-versions/${configurationVersionId}/download`,
      { headers: authHeaders },
    );
    expect(downloadResponse.status).toBe(200);
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(
      validTarGzip("cloud-contract"),
    );

    const configurationListResponse = await request(
      `/api/v2/workspaces/${workspaceId}/configuration-versions?page[number]=1&page[size]=1`,
      { headers: authHeaders },
    );
    expect(configurationListResponse.status).toBe(200);
    const configurationList = await configurationListResponse.json();
    expect(configurationList.data).toContainEqual(expect.objectContaining({
      id: configurationVersionId,
      attributes: expect.objectContaining({
        status: "uploaded",
        source: "tfe-api",
        speculative: true,
      }),
    }));
    const listedUploadUrl = configurationList.data[0].attributes["upload-url"];
    expect(typeof listedUploadUrl).toBe("string");
    const listedUploadLocation = new URL(listedUploadUrl);
    expect(listedUploadLocation.pathname).toBe(`/api/v2/configuration-versions/${configurationVersionId}/upload`);
    expect(listedUploadLocation.searchParams.has("expires")).toBe(true);
    expect(listedUploadLocation.searchParams.has("signature")).toBe(true);
    expect(configurationList.meta.pagination).toEqual({
      "current-page": 1,
      "page-size": 1,
      "prev-page": null,
      "next-page": null,
      "total-pages": 1,
      "total-count": 1,
    });
  });

  it("supports speculative runs and plan log URL shape verification", async () => {
    const speculativeRunResponse = await request("/api/v2/runs", {
      method: "POST",
      headers: { ...authHeaders, "Terraform-Version": "1.10.0" },
      body: JSON.stringify({
        data: {
          type: "runs",
          attributes: {
            refresh: false,
            "target-addrs": ["null_resource.target"],
            "replace-addrs": ["null_resource.replace"],
            variables: [{ key: "region", value: '"eu-west-2"' }],
            "terraform-version": "1.10.0",
            "debugging-mode": true,
          },
          relationships: {
            workspace: { data: { id: workspaceId, type: "workspaces" } },
            "configuration-version": {
              data: { id: configurationVersionId, type: "configuration-versions" },
            },
          },
        },
      }),
    });
    expect(speculativeRunResponse.status).toBe(201);
    const speculativeRun = (await speculativeRunResponse.json()).data;
    expect(speculativeRun.attributes).toMatchObject({
      "plan-only": true,
      refresh: false,
      "target-addrs": ["null_resource.target"],
      "replace-addrs": ["null_resource.replace"],
      variables: [{ key: "region", value: '"eu-west-2"' }],
      "terraform-version": "1.10.0",
      "debugging-mode": true,
    });
    expect(speculativeRun.relationships["created-by"].data.id).toBe(userId);
    const promotedWorkspace = (await (await request(
      `/api/v2/workspaces/${workspaceId}`,
      { headers: authHeaders },
    )).json()).data;
    expect(promotedWorkspace.attributes["iac-binary"]).toBe("terraform");
    const speculativePlan = (await (await request(
      `/api/v2/plans/plan-${speculativeRun.id}`,
      { headers: authHeaders },
    )).json()).data;
    expect(speculativePlan.attributes["log-read-url"]).toMatch(
      new RegExp(`^http://terrence\\.test/api/v2/runs/${speculativeRun.id}/plan/log/[^/]+$`),
    );
    expect(speculativePlan.attributes["log-read-url"].endsWith(`/${speculativeRun.id}`)).toBe(false);
    expect((await request(speculativePlan.attributes["log-read-url"])).status).toBe(200);
    // Protocol-level regression: the freshly created speculative run must appear
    // in the workspace run history (no implicit plan-only exclusion).
    const historyResponse = await request(`/api/v2/workspaces/${workspaceId}/runs`, { headers: authHeaders });
    expect(historyResponse.status).toBe(200);
    const historyIds = (await historyResponse.json()).data.map((run: any) => run.id);
    expect(historyIds).toContain(speculativeRun.id);
    expect((await request(
      `/api/v2/runs/${speculativeRun.id}`,
      { method: "DELETE", headers: authHeaders },
    )).status).toBe(204);
  });

  it("supports state version creation, current version retrieval, and state download", async () => {
    const lockResponse = await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(lockResponse.status).toBe(200);
    const state = { version: 4, serial: 1, lineage: suffix, resources: [] };
    const metadataOnlyStateResponse = await request(
      `/api/v2/workspaces/${workspaceId}/state-versions`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: { type: "state-versions", attributes: { serial: 1 } },
        }),
      },
    );
    expect(metadataOnlyStateResponse.status).toBe(201);
    const pendingState = (await metadataOnlyStateResponse.json()).data;
    expect(pendingState.attributes.status).toBe("pending");
    const stateUploadUrl = pendingState.attributes["hosted-state-upload-url"];
    const jsonStateUploadUrl = pendingState.attributes["hosted-json-state-upload-url"];
    expect(stateUploadUrl).toMatch(
      /^http:\/\/terrence\.test\/api\/v2\/state-versions\/[^/]+\/upload\?expires=\d+&signature=[a-f0-9]+$/,
    );
    expect((await request(stateUploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    })).status).toBe(200);
    expect((await request(jsonStateUploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    })).status).toBe(200);

    const createdStateResponse = await request(
      `/api/v2/state-versions/${pendingState.id}`,
      { headers: authHeaders },
    );
    expect(createdStateResponse.status).toBe(200);
    const createdState = await createdStateResponse.json();
    const stateDownloadUrl = createdState.data.attributes["hosted-state-download-url"];
    expect(stateDownloadUrl).toMatch(
      /^http:\/\/terrence\.test\/api\/v2\/state-versions\/[^/]+\/download\?expires=\d+&signature=[a-f0-9]+$/,
    );

    const currentStateResponse = await request(
      `/api/v2/workspaces/${workspaceId}/current-state-version`,
      { headers: authHeaders },
    );
    expect(currentStateResponse.status).toBe(200);
    const currentState = await currentStateResponse.json();
    expect(currentState.data.id).toBe(pendingState.id);

    const stateDownloadResponse = await request(stateDownloadUrl);
    expect(stateDownloadResponse.status).toBe(200);
    expect(await stateDownloadResponse.json()).toEqual(state);
  });

  it("supports run resource management, logs, plan/apply resources, and run actions", async () => {
    await db.update(configurationVersions).set({
      source: "github",
      ingressAttributes: {
        branch: "feature/structured-output",
        pullRequestNumber: 10,
      },
    }).where(eq(configurationVersions.id, configurationVersionId));
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      configurationVersionId,
      status: "planned",
      message: "Contract run",
      isDestroy: false,
      logToken: runId,
      createdAt: Date.now(),
    });
    await db.insert(runs).values({
      id: `historical-run-${suffix}`,
      workspaceId,
      status: "errored",
      message: "Historical run",
      createdAt: Date.now() - 1_000,
    });
    await db.insert(logs).values([
      {
        id: `plan-log-${suffix}`,
        runId,
        phase: "plan",
        outputText: "abcdef",
        createdAt: Date.now(),
      },
      {
        id: `apply-log-${suffix}`,
        runId,
        phase: "apply",
        outputText: "uvwxyz",
        createdAt: Date.now(),
      },
    ]);

    const runResponse = await request(`/api/v2/runs/${runId}`, { headers: authHeaders });
    expect(runResponse.status).toBe(200);
    const run = (await runResponse.json()).data;
    expect(run.attributes.actions).toEqual(expect.objectContaining({
      "is-confirmable": true,
      "is-discardable": true,
    }));
    expect(run.attributes["has-changes"]).toBe(true);
    // RUN-006: run source is the transport taxonomy; the VCS provider is kept
    // as ingress metadata (branch/pull-request attr on the configuration
    // version), not echoed as the run's source.
    expect(run.attributes.source).toBe("tfe-configuration-version");
    expect(run.attributes["trigger-reason"]).toBe("pull_request");
    expect(new Date(run.attributes["created-at"]).toISOString()).toBe(run.attributes["created-at"]);
    expect(run.attributes.permissions["can-apply"]).toBe(true);
    expect(run.relationships.workspace.data.id).toBe(workspaceId);
    expect(run.relationships.workspace.links.related).toBe(`/api/v2/workspaces/${workspaceId}`);
    expect(run.relationships["configuration-version"].data.id).toBe(configurationVersionId);
    expect(run.relationships.plan.data.id).toBe(`plan-${runId}`);
    expect(run.relationships.apply.data.id).toBe(`apply-${runId}`);
    expect(run.relationships["run-events"].links.related).toBe(
      `/api/v2/runs/${runId}/run-events`,
    );

    const historicalStatusFilter = await request(
      `/api/v2/organizations/${orgName}/workspaces?filter[current-run][status]=errored`,
      { headers: authHeaders },
    );
    expect((await historicalStatusFilter.json()).data).toHaveLength(0);
    const currentStatusFilter = await request(
      `/api/v2/organizations/${orgName}/workspaces?filter[current-run][status]=planned`,
      { headers: authHeaders },
    );
    expect((await currentStatusFilter.json()).data.map((item: any) => item.id)).toContain(workspaceId);

    const planResponse = await request(`/api/v2/plans/plan-${runId}`, { headers: authHeaders });
    expect(planResponse.status).toBe(200);
    const plan = (await planResponse.json()).data;
    expect(plan.attributes.status).toBe("finished");
    expect(plan.attributes["generated-configuration"]).toBe(false);
    expect(plan.attributes["execution-details"]).toEqual({ mode: "remote" });
    expect(plan.attributes["log-read-url"]).toBe(
      `http://terrence.test/api/v2/runs/${runId}/plan/log/${runId}`,
    );
    expect(await (await request(
      `/api/v2/runs/${runId}/plan/log/${runId}?offset=2&limit=3`,
    )).text()).toBe("cde");
    expect((await request(`/api/v2/runs/${runId}/plan/log/not-the-token`)).status).toBe(404);

    const applyResponse = await request(`/api/v2/applies/apply-${runId}`, { headers: authHeaders });
    expect(applyResponse.status).toBe(200);
    const apply = (await applyResponse.json()).data;
    expect(apply.attributes.status).toBe("pending");
    expect(apply.attributes["log-read-url"]).toBe(
      `http://terrence.test/api/v2/runs/${runId}/apply/log/${runId}`,
    );
    expect(await (await request(
      `/api/v2/runs/${runId}/apply/log/${runId}?offset=6&limit=3`,
    )).text()).toBe("");

    const runEventsResponse = await request(
      `/api/v2/runs/${runId}/run-events`,
      { headers: authHeaders },
    );
    expect(runEventsResponse.status).toBe(200);
    expect(await runEventsResponse.json()).toEqual({ data: [] });

    const organizationRunsResponse = await request(
      `/api/v2/organizations/${orgName}/runs`,
      { headers: authHeaders },
    );
    expect(organizationRunsResponse.status).toBe(200);
    const organizationRuns = await organizationRunsResponse.json();
    expect(organizationRuns.data.map((item: any) => item.id)).toContain(runId);
    expect(organizationRuns.data.find((item: any) => item.id === runId).attributes)
      .toMatchObject({ source: "tfe-configuration-version", "trigger-reason": "pull_request" });

    for (const [action, status] of [
      ["discard", "discarded"],
      ["cancel", "canceled"],
      ["force-cancel", "force_canceled"],
    ]) {
      await db.update(runs).set({
        status: action === "cancel" ? "planning" : action === "force-cancel" ? "applying" : "planned",
        ...(action === "force-cancel" ? { statusTimestamps: { "cancel-requested-at": new Date().toISOString() } } : {}),
      }).where(eq(runs.id, runId));
      const actionResponse = await request(
        `/api/v2/runs/${runId}/actions/${action}`,
        { method: "POST", headers: authHeaders },
      );
      expect(actionResponse.status).toBe(202);
      expect((await db.query.runs.findFirst({ where: eq(runs.id, runId) }))?.status).toBe(status);
    }
  });

  it("supports run deletion", async () => {
    const deleteResponse = await request(
      `/api/v2/runs/${runId}`,
      { method: "DELETE", headers: authHeaders },
    );
    expect(deleteResponse.status).toBe(204);
    expect((await request(`/api/v2/runs/${runId}`, { headers: authHeaders })).status).toBe(404);
  });
});
