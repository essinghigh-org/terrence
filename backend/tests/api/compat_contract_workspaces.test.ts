import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { workspaces } from "../../src/db/schema";
import {
  cleanupSeed,
  expectCollection,
  expectErrorResponse,
  expectNoContent,
  expectPaginationMeta,
  expectSelfLink,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedOrg,
} from "./compat_contract_helpers";

describe("remote-workflow workspaces contract", () => {
  const seed = seedOrg("ws");
  const headers = jsonHeaders(seed.token);
  const workspaceName = `ws-${seed.suffix}`;

  beforeAll(async () => {
    await persistSeed(seed);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId));
    await cleanupSeed(seed);
  });

  it("creates a workspace with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "workspaces",
            attributes: { name: workspaceName },
          },
        }),
      }),
      201,
      "workspaces",
    );
    // the reference format emits ids prefixed with "ws-"; Terrence uses bare UUIDs (opaque to clients).
    expect(resource.id).toBeTypeOf("string");
    expect(resource.id).not.toBe("");
    expect(resource.attributes["name"]).toBe(workspaceName);
    expect(resource.attributes["auto-apply"]).toBe(false);
    expect(resource.attributes["locked"]).toBe(false);
    expect(resource.attributes["operations"]).toBe(true);
    expect(resource.attributes["execution-mode"]).toBe("remote");
    expect(resource.attributes["created-at"]).toBeTypeOf("string");
    expect(resource.attributes["permissions"]).toMatchObject({
      "can-queue-run": true,
      "can-update": true,
      "can-lock": true,
    });
    expect(resource.relationships?.["organization"]).toMatchObject({
      data: { id: seed.orgName, type: "organizations" },
    });
    expectSelfLink(resource, "/api/v2/workspaces/");
  });

  it("shows a workspace by id", async () => {
    const listResponse = await request(`/api/v2/organizations/${seed.orgName}/workspaces`, { headers });
    const [workspace] = expectCollection(await listResponse.json(), "workspaces");
    expect(workspace).toBeDefined();
    const resource = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspace!.id}`, { headers }),
      200,
      "workspaces",
    );
    expect(resource.attributes["name"]).toBe(workspaceName);
    expect(resource.relationships?.["organization"]).toMatchObject({
      data: { id: seed.orgName, type: "organizations" },
    });
  });

  it("shows a workspace by organization name and workspace name", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/workspaces/${workspaceName}`, { headers }),
      200,
      "workspaces",
    );
    expect(resource.attributes["name"]).toBe(workspaceName);
    expect(resource.attributes["auto-apply"]).toBe(false);
  });

  it("lists workspaces with pagination metadata", async () => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/workspaces?page[number]=1&page[size]=20`, {
      headers,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "workspaces");
    expect(items.length).toBeGreaterThanOrEqual(1);
    expectPaginationMeta(body);
  });

  it("filters workspaces with search[name]", async () => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/workspaces?search[name]=${workspaceName}`, {
      headers,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "workspaces");
    expect(items.length).toBe(1);
    expect(items[0]!.attributes["name"]).toBe(workspaceName);
  });

  it("does not leak workspaces from other organizations", async () => {
    const response = await request(`/api/v2/organizations/other-org-${seed.suffix}/workspaces`, { headers });
    await expectErrorResponse(response, 404);
  });

  it("updates workspace attributes", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/workspaces/${workspaceName}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          data: {
            type: "workspaces",
            attributes: { "auto-apply": true, description: "updated" },
          },
        }),
      }),
      200,
      "workspaces",
    );
    expect(resource.attributes["auto-apply"]).toBe(true);
    expect(resource.attributes["description"]).toBe("updated");
  });

  it("persists provider HYOK metadata and forbids reversing enablement", async () => {
    const name = `hyok-${seed.suffix}`;
    const created = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ data: { type: "workspaces", attributes: { name } } }),
      }),
      201,
      "workspaces",
    );
    const byId = `/api/v2/workspaces/${created.id}`;
    const byName = `/api/v2/organizations/${seed.orgName}/workspaces/${name}`;
    const patch = (path: string, attributes: Readonly<Record<string, unknown>>): Promise<Response> =>
      request(path, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ data: { type: "workspaces", attributes } }),
      });
    expect(created.attributes["hyok-enabled"]).toBe(false);
    for (const value of ["true", 1, null]) await expectErrorResponse(await patch(byId, { "hyok-enabled": value }), 422);
    await expectErrorResponse(
      await request(byId, {
        method: "PATCH",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({ data: { type: "workspaces", attributes: { "hyok-enabled": true } } }),
      }),
      404,
    );
    const enabled = await expectSuccessResponse(await patch(byId, { "hyok-enabled": true }), 200, "workspaces");
    expect(enabled.attributes["hyok-enabled"]).toBe(true);
    const responses = await Promise.all([
      patch(byName, { description: "retained enablement" }),
      patch(byId, { "hyok-enabled": true }),
      patch(byName, { "hyok-enabled": false, description: "must not save" }),
    ]);
    expect(responses.map((response): number => response.status)).toEqual([200, 200, 422]);
    for (const path of [byId, byName]) {
      const resource = await expectSuccessResponse(await request(path, { headers }), 200, "workspaces");
      expect(resource.attributes["hyok-enabled"]).toBe(true);
    }
    const persisted = await db.query.workspaces.findFirst({ where: eq(workspaces.id, created.id) });
    expect(persisted?.hyokEnabled).toBe(true);
    expect(persisted?.description).not.toBe("must not save");
  });

  it("validates and persists lock reasons, then clears them when unlocked", async () => {
    const lockWorkspaceId = `lock-workspace-${seed.suffix}`;
    await db.insert(workspaces).values({ id: lockWorkspaceId, name: `lock-${seed.suffix}`, orgId: seed.orgId });
    try {
      const response = await request(`/api/v2/workspaces/${lockWorkspaceId}/actions/lock`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "x".repeat(301) }),
      });
      await expectErrorResponse(response, 422);

      const locked = await expectSuccessResponse(
        await request(`/api/v2/workspaces/${lockWorkspaceId}/actions/lock`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: "Migrating state" }),
        }),
        200,
        "workspaces",
      );
      expect(locked.attributes["locked"]).toBe(true);
      expect(locked.attributes["locked-reason"]).toBe("Migrating state");

      const unlocked = await expectSuccessResponse(
        await request(`/api/v2/workspaces/${lockWorkspaceId}/actions/unlock`, { method: "POST", headers }),
        200,
        "workspaces",
      );
      expect(unlocked.attributes["locked"]).toBe(false);
      expect(unlocked.attributes["locked-reason"]).toBeNull();
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, lockWorkspaceId));
    }
  });

  it("destroys a workspace with 204 and empty body", async () => {
    const createResponse = await request(`/api/v2/organizations/${seed.orgName}/workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data: { type: "workspaces", attributes: { name: `delete-me-${seed.suffix}` } } }),
    });
    const created = (await createResponse.json()).data as { id: string };
    await expectNoContent(await request(`/api/v2/workspaces/${created.id}`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/workspaces/${created.id}`, { headers }), 404);
  });
});
