import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { stateVersions } from "../../src/db/schema";
import { and, eq } from "drizzle-orm";

describe("the reference format API v2 - Data Retention & Garbage Collection", () => {
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
          data: { type: "workspaces", attributes: { name: "gc-test-ws" } },
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
    expect(drpBody.data.meta.gc.permanentlyDeleted).toBe(0);

    const softDeleted = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, workspaceId),
        eq(stateVersions.status, "backing_data_soft_deleted"),
      ),
    });
    expect(softDeleted).toBeDefined();

    const restoreRes = await app.handle(
      new Request(`http://localhost/api/v2/state-versions/${softDeleted!.id}/actions/restore_backing_data`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(restoreRes.status).toBe(200);

    // The next pass marks the excess version again, but does not permanently
    // delete it until the grace period elapses.
    const gcRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/gc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(gcRes.status).toBe(200);
    const gcBody = await gcRes.json();
    expect(gcBody.data.softDeleted).toBe(1);
    expect(gcBody.data.permanentlyDeleted).toBe(0);

    await db.update(stateVersions)
      .set({ softDeletedAt: Date.now() - 8 * 86_400_000 })
      .where(eq(stateVersions.id, softDeleted!.id));

    const finalGcRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/gc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(finalGcRes.status).toBe(200);
    expect((await finalGcRes.json()).data.permanentlyDeleted).toBe(1);
  });
});
