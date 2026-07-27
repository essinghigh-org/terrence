import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";

describe("TFE API v2 - Data Retention & Garbage Collection", () => {
  let userToken: string;
  const orgName = `gc-org-${crypto.randomUUID()}`;
  let workspaceId: string;

  beforeAll(async () => {
    // Register user & login
    const username = `gcuser_${crypto.randomUUID().slice(0, 8)}`;
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
          data: { attributes: { name: "gc-test-ws" } },
        }),
      })
    );
    const wsBody = await wsRes.json();
    workspaceId = wsBody.data.id;
  });

  test("should create multiple state versions and enforce retention policy GC", async () => {
    // Create 3 state versions
    for (let serial = 1; serial <= 3; serial++) {
      const rawState = JSON.stringify({ version: 4, serial, lineage: "gc-123", resources: [] });
      const b64State = Buffer.from(rawState).toString("base64");
      await app.handle(
        new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${userToken}`,
            "Content-Type": "application/vnd.api+json",
          },
          body: JSON.stringify({
            data: { attributes: { serial, state: b64State } },
          }),
        })
      );
    }

    // Set retention limit to 2
    const drpRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/relationships/data-retention-policy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              "state-versions-count": 2,
            },
          },
        }),
      })
    );

    expect(drpRes.status).toBe(201);
    const drpBody = await drpRes.json();
    expect(drpBody.data.meta.gc.softDeleted).toBe(1);

    // Trigger GC again to move soft-deleted to permanently deleted
    const gcRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/gc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(gcRes.status).toBe(200);
    const gcBody = await gcRes.json();
    expect(gcBody.data.permanentlyDeleted).toBe(1);
  });
});
