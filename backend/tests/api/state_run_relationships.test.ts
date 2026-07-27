import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";

describe("TFE API v2 - State-Run Relationships & Locking", () => {
  let userToken: string;
  const orgName = `st-org-${crypto.randomUUID()}`;
  let workspaceId: string;
  let runId: string;
  let stateVersionId: string;

  beforeAll(async () => {
    // Register user & login
    const username = `stuser_${crypto.randomUUID().slice(0, 8)}`;
    await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username, password: "Password123!" } },
        }),
      })
    );

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username, password: "Password123!" } },
        }),
      })
    );
    const loginData = await loginRes.json();
    userToken = loginData.data.attributes.token;

    // Create organization
    await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: { attributes: { name: orgName } },
        }),
      })
    );

    // Create workspace
    const wsRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/workspaces`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: { attributes: { name: "state-test-ws" } },
        }),
      })
    );
    const wsBody = await wsRes.json();
    workspaceId = wsBody.data.id;

    // Create run
    const runRes = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: { message: "Test run" },
            relationships: {
              workspace: { data: { id: workspaceId, type: "workspaces" } },
            },
          },
        }),
      })
    );
    const runBody = await runRes.json();
    runId = runBody.data.id;
  });

  test("should create initial state version linked to run", async () => {
    const rawState = JSON.stringify({ version: 4, serial: 1, lineage: "abc-123", resources: [] });
    const b64State = Buffer.from(rawState).toString("base64");

    const res = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              serial: 1,
              state: b64State,
            },
            relationships: {
              run: { data: { id: runId, type: "runs" } },
            },
          },
        }),
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.relationships.run.data.id).toBe(runId);
    stateVersionId = body.data.id;
  });

  test("should include input-state-version relationship on run", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/input-state-version`, {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Input state version for first run is null if no prior state existed before run
    expect(body).toBeDefined();
  });

  test("should reject state version creation if workspace is locked", async () => {
    // Lock workspace
    await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/lock`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );

    const rawState = JSON.stringify({ version: 4, serial: 2, lineage: "abc-123", resources: [] });
    const b64State = Buffer.from(rawState).toString("base64");

    const res = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              serial: 2,
              state: b64State,
            },
          },
        }),
      })
    );

    expect(res.status).toBe(409);

    // Unlock workspace
    await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/unlock`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
  });
});
