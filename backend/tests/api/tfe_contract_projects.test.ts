import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { projects } from "../../src/db/schema";
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

describe("TFE projects contract", () => {
  const seed = seedTfeOrg("prj");
  const headers = jsonHeaders(seed.token);
  let projectId = "";

  beforeAll(async () => {
    await persistSeed(seed);
  });

  afterAll(async () => {
    await db.delete(projects).where(eq(projects.id, projectId));
    await cleanupSeed(seed);
  });

  it("creates a project with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "projects",
            attributes: { name: `contract-project-${seed.suffix}` },
          },
        }),
      }),
      201,
      "projects",
    );
    projectId = resource.id;
    expect(projectId.startsWith("prj-")).toBe(true);
    expect(resource.attributes.name).toBe(`contract-project-${seed.suffix}`);
    expect(resource.attributes.description === "" || resource.attributes.description === null).toBe(true);
    expect(resource.attributes["workspace-count"]).toBe(0);
    expect(resource.attributes["team-count"]).toBe(0);
    expect(resource.attributes["default-execution-mode"]).toBe("remote");
    expect(resource.attributes["setting-overwrites"]).toMatchObject({
      "execution-mode": false,
    });
    expect(resource.attributes.permissions).toMatchObject({
      "can-update": true,
      "can-destroy": true,
      "can-create-workspace": true,
    });
    expect(resource.relationships?.organization).toMatchObject({
      data: { id: seed.orgName, type: "organizations" },
    });
    expectSelfLink(resource, "/api/v2/projects/");
  });

  it("shows a project", async () => {
    const resource = await expectSuccessResponse(await request(`/api/v2/projects/${projectId}`, { headers }), 200, "projects");
    expect(resource.attributes.name).toBe(`contract-project-${seed.suffix}`);
    expect(resource.relationships?.organization).toMatchObject({
      data: { id: seed.orgName, type: "organizations" },
    });
  });

  it("lists projects with pagination metadata", async () => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/projects?page[number]=1&page[size]=10`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "projects");
    expect(items.map((p) => p.id)).toContain(projectId);
    expectPaginationMeta(body);
  });

  it("updates a project", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/projects/${projectId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          data: {
            type: "projects",
            attributes: { description: "updated description" },
          },
        }),
      }),
      200,
      "projects",
    );
    expect(resource.attributes.description).toBe("updated description");
  });

  it("destroys a project", async () => {
    await expectNoContent(await request(`/api/v2/projects/${projectId}`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/projects/${projectId}`, { headers }), 404);
  });
});
