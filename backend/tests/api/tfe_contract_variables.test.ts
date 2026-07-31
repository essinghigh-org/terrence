import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { workspaceVariables, workspaces } from "../../src/db/schema";
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
  seedTfeOrg,
} from "./tfe_contract_helpers";

describe("TFE variables contract", () => {
  const seed = seedTfeOrg("var");
  const headers = jsonHeaders(seed.token);
  const workspaceId = `workspace-${seed.suffix}`;
  let variableId = "";

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: `vars-${seed.suffix}`, orgId: seed.orgId });
  });

  afterAll(async () => {
    await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  it("creates a terraform variable with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspaceId}/vars`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "vars",
            attributes: { key: "region", value: "us-east-1", category: "terraform" },
          },
        }),
      }),
      201,
      "vars",
    );
    variableId = resource.id;
    expect(resource.attributes.key).toBe("region");
    expect(resource.attributes.value).toBe("us-east-1");
    expect(resource.attributes.category).toBe("terraform");
    expect(resource.attributes.sensitive).toBe(false);
    expect(resource.attributes.hcl).toBe(false);
    expect(resource.relationships?.workspace).toMatchObject({
      data: { id: workspaceId, type: "workspaces" },
    });
    expectSelfLink(resource, "/api/v2/workspaces/");
  });

  it("creates an environment variable and hides sensitive values on read", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspaceId}/vars`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "vars",
            attributes: { key: "TOKEN", value: "super-secret", category: "env", sensitive: true },
          },
        }),
      }),
      201,
      "vars",
    );
    expect(resource.attributes.category).toBe("env");
    expect(resource.attributes.sensitive).toBe(true);
    expect(resource.attributes.value).not.toBe("super-secret");

    const shown = await expectSuccessResponse(await request(`/api/v2/workspaces/${workspaceId}/vars/${resource.id}`, { headers }), 200, "vars");
    expect(shown.attributes.value).not.toBe("super-secret");
  });

  it("lists variables with pagination metadata", async () => {
    const response = await request(`/api/v2/workspaces/${workspaceId}/vars?page[number]=1&page[size]=10`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "vars");
    expect(items.map((v) => v.id)).toContain(variableId);
    expectPaginationMeta(body);
  });

  it("updates a variable", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspaceId}/vars/${variableId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          data: {
            type: "vars",
            attributes: { value: "eu-west-1", description: "region override" },
          },
        }),
      }),
      200,
      "vars",
    );
    expect(resource.attributes.value).toBe("eu-west-1");
    expect(resource.attributes.description).toBe("region override");
  });

  it("destroys a variable with 204 and empty body", async () => {
    const createResponse = await request(`/api/v2/workspaces/${workspaceId}/vars`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: { type: "vars", attributes: { key: "temp", value: "x", category: "terraform" } },
      }),
    });
    const created = (await createResponse.json()).data as { id: string };
    await expectNoContent(await request(`/api/v2/workspaces/${workspaceId}/vars/${created.id}`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/workspaces/${workspaceId}/vars/${created.id}`, { headers }), 404);
  });

  it("rejects variables with invalid payloads", async () => {
    const response = await request(`/api/v2/workspaces/${workspaceId}/vars`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data: { type: "vars", attributes: { value: "missing-key" } } }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
