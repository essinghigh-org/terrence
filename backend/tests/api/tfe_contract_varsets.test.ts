import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { variableSets, workspaces } from "../../src/db/schema";
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

describe("TFE variable sets contract", () => {
  const seed = seedTfeOrg("varset");
  const headers = jsonHeaders(seed.token);
  const workspaceId = `workspace-${seed.suffix}`;
  let varsetId = "";

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: `varsets-${seed.suffix}`, orgId: seed.orgId });
  });

  afterAll(async () => {
    await db.delete(variableSets).where(eq(variableSets.id, varsetId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  it("creates a variable set with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/varsets`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "varsets",
            attributes: {
              name: `contract-varset-${seed.suffix}`,
              description: "contract test varset",
              global: false,
              priority: false,
            },
          },
        }),
      }),
      201,
      "varsets",
    );
    varsetId = resource.id;
    expect(varsetId.startsWith("varset-")).toBe(true);
    expect(resource.attributes.name).toBe(`contract-varset-${seed.suffix}`);
    expect(resource.attributes.description).toBe("contract test varset");
    expect(resource.attributes.global).toBe(false);
    expect(resource.attributes.priority).toBe(false);
    expect(resource.relationships?.parent).toMatchObject({
      data: { id: seed.orgName, type: "organizations" },
    });
    expect(resource.relationships?.workspaces).toMatchObject({ data: [] });
    expectSelfLink(resource, "/api/v2/varsets/");
  });

  it("shows a variable set", async () => {
    const resource = await expectSuccessResponse(await request(`/api/v2/varsets/${varsetId}`, { headers }), 200, "varsets");
    expect(resource.attributes.name).toBe(`contract-varset-${seed.suffix}`);
    expect(resource.relationships?.parent).toMatchObject({
      data: { id: seed.orgName, type: "organizations" },
    });
  });

  it("lists variable sets with pagination metadata", async () => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/varsets?page[number]=1&page[size]=10`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "varsets");
    expect(items.map((v) => v.id)).toContain(varsetId);
    expectPaginationMeta(body);
  });

  it("assigns a workspace to the variable set", async () => {
    const response = await request(`/api/v2/varsets/${varsetId}/relationships/workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: [{ type: "workspaces", id: workspaceId }],
      }),
    });
    expect(response.status).toBe(204);

    const resource = await expectSuccessResponse(await request(`/api/v2/varsets/${varsetId}`, { headers }), 200, "varsets");
    const workspacesData = (resource.relationships?.workspaces as { data: unknown[] }).data;
    expect(workspacesData).toEqual([{ type: "workspaces", id: workspaceId }]);
  });

  it("updates a variable set", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/varsets/${varsetId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          data: { type: "varsets", attributes: { description: "updated", priority: true } },
        }),
      }),
      200,
      "varsets",
    );
    expect(resource.attributes.description).toBe("updated");
    expect(resource.attributes.priority).toBe(true);
  });

  it("destroys a variable set", async () => {
    await expectNoContent(await request(`/api/v2/varsets/${varsetId}`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/varsets/${varsetId}`, { headers }), 404);
  });
});
