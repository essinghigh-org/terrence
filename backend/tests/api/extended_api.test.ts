import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { executeRun } from "../../src/worker";
import { rm } from "fs/promises";
import { join } from "path";

describe("the reference format API v2 - Extended APIs", () => {
  let userToken: string;
  const orgName = `ext-org-${Date.now()}`;
  let workspaceId = "";
  let varId = "";
  let cvId = "";
  let runId = "";
  let stateId = "";

  beforeAll(async () => {
    // Clear test user
    await db.delete(users).where(eq(users.username, "ext-admin"));

    // Register & Login user
    await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: "ext-admin", password: "extpassword" } }
        })
      })
    );

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "ext-admin", password: "extpassword" } }
        })
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;

    // Create Organization
    const orgRes = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: orgName } }
        })
      })
    );
    expect(orgRes.status).toBe(201);

    // Create Workspace
    const wsRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/workspaces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "workspaces", attributes: { name: "prod-cluster", "auto-apply": false } }
        })
      })
    );
    const wsData = await wsRes.json();
    workspaceId = wsData.data.id;
  }, 30_000);

  afterAll(async () => {
    if (cvId) {
      const cvPath = join(import.meta.dir, "../../storage/cv", `${cvId}.tar.gz`);
      try { await rm(cvPath, { force: true }); } catch {}
    }
  });

  it("should patch workspace settings", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { attributes: { "auto-apply": true, "terraform-version": "1.6.0" } }
        })
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.attributes["auto-apply"]).toBe(true);
    expect(data.data.attributes["terraform-version"]).toBe("1.6.0");
  });

  it("should add and list workspace tags", async () => {
    const addRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/relationships/tags`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: [
            { type: "tags", attributes: { key: "env:production" } },
            { type: "tags", attributes: { key: "team:platform" } }
          ]
        })
      })
    );
    expect(addRes.status).toBe(201);

    const getRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/relationships/tags`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(getRes.status).toBe(200);
    const tagData = await getRes.json();
    expect(tagData.data.length).toBe(2);
  });

  it("should create, read, patch, and delete a variable", async () => {
    const createRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: { key: "DB_HOST", value: "postgres.internal", category: "env", sensitive: false },
            type: "vars"
          }
        })
      })
    );
    expect(createRes.status).toBe(201);
    varId = (await createRes.json()).data.id;

    const getRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars/${varId}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(getRes.status).toBe(200);

    const patchRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars/${varId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { attributes: { value: "postgres-cluster.internal" }, type: "vars" }
        })
      })
    );
    expect(patchRes.status).toBe(200);

    const delRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars/${varId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(delRes.status).toBe(204);
  });

  it("should upload binary config and retrieve download URL", async () => {
    const createCv = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/configuration-versions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(createCv.status).toBe(201);
    cvId = (await createCv.json()).data.id;

    const uploadRes = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${cvId}/upload`, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${userToken}` },
        body: new Uint8Array([0x1f, 0x8b, 0x08])
      })
    );
    expect(uploadRes.status).toBe(200);

    const cvGet = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${cvId}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect((await cvGet.json()).data.attributes.status).toBe("uploaded");
  }, 30_000);

  it("should list workspace runs and fetch logs", async () => {
    const runRes = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: { message: "Test Run execution" },
            relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } }
          }
        })
      })
    );
    expect(runRes.status).toBe(201);
    runId = (await runRes.json()).data.id;

    const runsList = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/runs`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(runsList.status).toBe(200);
    const listData = await runsList.json();
    expect(listData.data.length).toBeGreaterThan(0);

    // Execute the run via worker (not auto-started in test)
    await executeRun(runId);

    // Poll until run completes
    let attempts = 0;
    let logText = "";
    let runStatus = "";
    while (attempts < 50) {
      const runStatusRes = await app.handle(
        new Request(`http://localhost/api/v2/runs/${runId}`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${userToken}` }
        })
      );
      if (runStatusRes.status === 200) {
        runStatus = (await runStatusRes.json()).data?.attributes?.status;
      }

      const logRes = await app.handle(
        new Request(`http://localhost/api/v2/runs/${runId}/plan/log`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${userToken}` }
        })
      );
      expect(logRes.status).toBe(200);
      logText = await logRes.text();
      if (logText.length > 0 && ["planning", "planned", "applied", "errored", "canceled", "discarded"].includes(runStatus)) break;
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    expect(logText.length).toBeGreaterThan(0);
    const terminalStatuses = new Set(["planning", "planned", "applied", "errored", "canceled", "discarded"]);
    // Allow "planned_and_finished" as a valid terminal status for plan-only runs
    expect(terminalStatuses.has(runStatus) || runStatus === "planned_and_finished").toBe(true);
  });

  it("should list state versions and download state JSON payload", async () => {
    const createState = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { attributes: { serial: 1, state: JSON.stringify({ resources: [] }) } }
        })
      })
    );
    expect(createState.status).toBe(201);
    stateId = (await createState.json()).data.id;

    const listStates = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(listStates.status).toBe(200);
    const stateList = await listStates.json();
    expect(stateList.data.length).toBeGreaterThan(0);

    const dlRes = await app.handle(
      new Request(`http://localhost/api/v2/state-versions/${stateId}/download`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(dlRes.status).toBe(200);
  });
});

describe("the reference format API v2 - Organization Management Lifecycle", () => {
  let userToken: string;
  const isolatedOrgName = `isolated-org-${Date.now()}`;

  beforeAll(async () => {
    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "ext-admin", password: "extpassword" } }
        })
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;

    await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: isolatedOrgName } }
        })
      })
    );
  });

  it("should patch and delete organization atomically", async () => {
    const patchOrg = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${isolatedOrgName}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { attributes: { name: `${isolatedOrgName}-updated` } }
        })
      })
    );
    expect(patchOrg.status).toBe(200);

    const delOrg = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${isolatedOrgName}-updated`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(delOrg.status).toBe(204);
  });
});
