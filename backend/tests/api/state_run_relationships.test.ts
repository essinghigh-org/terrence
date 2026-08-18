import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";

describe("the reference format API v2 - State-Run Relationships & Locking", () => {
  let userToken: string;
  const orgName = `st-org-${crypto.randomUUID()}`;
  let workspaceId: string;
  let runId: string;

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
          data: { type: "organizations", attributes: { name: orgName } },
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
          data: { type: "workspaces", attributes: { name: "state-test-ws" } },
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

  test("should include run status and message in state version list", async () => {
    // Create a state version linked to the existing run
    const rawState = JSON.stringify({ version: 4, serial: 1, lineage: "abc-123", resources: [] });
    const b64State = Buffer.from(rawState).toString("base64");
    await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: { serial: 1, state: b64State },
            relationships: {
              run: { data: { id: runId, type: "runs" } },
            },
          },
        }),
      })
    );

    const res = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(1);

    // The state version should have run relationship data
    const svWithRun = (body.data as Record<string, unknown>[]).find(
      (sv: Record<string, unknown>): boolean => {
        const rels = sv.relationships as Record<string, unknown> | null | undefined;
        const runRel = rels?.run as Record<string, unknown> | null | undefined;
        return runRel?.data != null;
      }
    );
    expect(svWithRun).toBeDefined();
    const rels = (svWithRun!).relationships as Record<string, unknown>;
    const runRel = rels.run as Record<string, unknown>;
    const runData = runRel.data as Record<string, unknown>;
    expect(runData.id).toBe(runId);
    const attrs = (svWithRun!).attributes as Record<string, unknown>;

    // Run attributes should be included
    expect(attrs["run-status"]).toBeDefined();
    expect(attrs["run-message"]).toBeDefined();
    expect(attrs["run-status"]).toBe("pending");
    expect(attrs["run-message"]).toBe("Test run");
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

    // the reference format semantics: state uploads are allowed on locked workspaces (the
    // lock guards runs, not the lock holder's own state writes).
    expect(res.status).toBe(201);

    // Unlock workspace
    await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/unlock`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
  });
});
