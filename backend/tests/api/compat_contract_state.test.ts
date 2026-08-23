import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { stateVersions, workspaces } from "../../src/db/schema";
import {
  cleanupSeed,
  expectCollection,
  expectErrorResponse,
  expectPaginationMeta,
  expectSelfLink,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedOrg,
} from "./compat_contract_helpers";

describe("remote-workflow state versions contract", () => {
  const seed = seedOrg("sv");
  const headers = jsonHeaders(seed.token);
  const workspaceId = `workspace-${seed.suffix}`;
  let stateVersionId = "";
  const stateJson = (serial: number) =>
    JSON.stringify({ version: 4, serial, lineage: "test-lineage", outputs: {} });
  const stateMd5 = (serial: number) => createHash("md5").update(stateJson(serial)).digest("base64");

  const statePayload = {
    data: {
      type: "state-versions",
      attributes: {
        serial: 1,
        md5: stateMd5(1),
        lineage: "test-lineage",
        state: stateJson(1),
        "json-state-outputs": "{\"outputs\":{}}",
      },
    },
  };

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: `state-${seed.suffix}`, orgId: seed.orgId });
    const lock = await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers });
    expect(lock.status).toBe(200);
  });

  afterAll(async () => {
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  it("creates a state version with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers,
        body: JSON.stringify(statePayload),
      }),
      201,
      "state-versions",
    );
    stateVersionId = resource.id;
    // the reference format emits ids prefixed with "sv-"; Terrence uses bare UUIDs (opaque to clients).
    expect(stateVersionId).toBeTypeOf("string");
    expect(stateVersionId).not.toBe("");
    expect(resource.attributes.serial).toBe(1);
    // the reference format returns the MD5 digest of the state payload.
    expect(resource.attributes.md5).toBe(
      createHash("md5").update('{"version":4,"serial":1,"lineage":"test-lineage","outputs":{}}').digest("hex"),
    );
    expect(resource.attributes.lineage).toBe("test-lineage");
    expect(resource.attributes.status).toBe("finalized");
    expect(resource.attributes["created-at"]).toBeTypeOf("string");
    expect(resource.attributes["hosted-state-download-url"]).toBeTypeOf("string");
    expect(resource.relationships?.workspace).toMatchObject({
      data: { id: workspaceId, type: "workspaces" },
    });
    expectSelfLink(resource, "/api/v2/state-versions/");
  });

  it("shows a state version", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/state-versions/${stateVersionId}`, { headers }),
      200,
      "state-versions",
    );
    expect(resource.attributes.serial).toBe(1);
    expect(resource.attributes.status).toBe("finalized");
    expect(resource.attributes["created-at"]).toBeTypeOf("string");
    expectSelfLink(resource, "/api/v2/state-versions/");
  });

  it("lists state versions for a workspace with pagination metadata", async () => {
    const response = await request(
      `/api/v2/workspaces/${workspaceId}/state-versions?page[number]=1&page[size]=10`,
      { headers },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "state-versions");
    expect(items.map((s) => s.id)).toContain(stateVersionId);
    expectPaginationMeta(body);
  });

  it("shows the current state version", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers }),
      200,
      "state-versions",
    );
    expect(resource.attributes.serial).toBe(1);
  });

  it("lists state version outputs", async () => {
    const response = await request(`/api/v2/state-versions/${stateVersionId}/outputs`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "state-version-outputs");
    for (const item of items) {
      expect(item.attributes).toMatchObject({
        name: expect.any(String),
        sensitive: expect.any(Boolean),
        type: expect.any(String),
      });
      expect(item).toHaveProperty("attributes.value");
    }
  });

  it("shows current state version outputs for a workspace", async () => {
    const response = await request(`/api/v2/workspaces/${workspaceId}/current-state-version-outputs`, { headers });
    expect(response.status).toBe(200);
    expectCollection(await response.json(), "state-version-outputs");
  });

  it("shows the json state download", async () => {
    const response = await request(`/api/v2/state-versions/${stateVersionId}/json-download`, { headers });
    expect(response.status).toBe(200);
  });

  it("soft deletes, restores, and permanently deletes a state version", async () => {
    const newer = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "state-versions",
            attributes: {
              serial: 2,
              md5: stateMd5(2),
              lineage: "test-lineage",
              state: stateJson(2),
              "json-state-outputs": "{\"outputs\":{}}",
            },
          },
        }),
      }),
      201,
      "state-versions",
    );
    expect(newer.attributes.serial).toBe(2);

    const softDeleted = await expectSuccessResponse(
      await request(`/api/v2/state-versions/${stateVersionId}/actions/soft_delete_backing_data`, {
        method: "POST",
        headers,
        body: JSON.stringify({ data: { type: "state-versions", attributes: { "delete-older-than-n-days": 23 } } }),
      }),
      200,
      "state-versions",
    );
    expect(softDeleted.attributes.status).toBe("backing_data_soft_deleted");
    await expectErrorResponse(await request(`/api/v2/state-versions/${stateVersionId}`, { headers }), 404);

    const restored = await expectSuccessResponse(
      await request(`/api/v2/state-versions/${stateVersionId}/actions/restore_backing_data`, {
        method: "POST",
        headers,
      }),
      200,
      "state-versions",
    );
    expect(restored.attributes.status).toBe("finalized");

    await request(`/api/v2/state-versions/${stateVersionId}/actions/soft_delete_backing_data`, {
      method: "POST",
      headers,
    });
    const permanentlyDeleted = await expectSuccessResponse(
      await request(`/api/v2/state-versions/${stateVersionId}/actions/permanently_delete_backing_data`, {
        method: "POST",
        headers,
      }),
      200,
      "state-versions",
    );
    expect(permanentlyDeleted.attributes.status).toBe("backing_data_permanently_deleted");
    await expectErrorResponse(await request(`/api/v2/state-versions/${stateVersionId}`, { headers }), 404);
  });
});
