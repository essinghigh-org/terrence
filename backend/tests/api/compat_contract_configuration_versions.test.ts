import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { configurationVersions, workspaces } from "../../src/db/schema";
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
import { validTarGzip } from "./test-archives";

describe("remote-workflow configuration versions contract", () => {
  const seed = seedOrg("cv");
  const headers = jsonHeaders(seed.token);
  const workspaceId = `workspace-${seed.suffix}`;
  let cvId = "";
  let uploadUrl = "";

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: `cv-${seed.suffix}`, orgId: seed.orgId });
  });

  afterAll(async () => {
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  it("creates a configuration version with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspaceId}/configuration-versions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "configuration-versions",
            attributes: { speculative: true, provisional: false },
          },
        }),
      }),
      201,
      "configuration-versions",
    );
    cvId = resource.id;
    uploadUrl = resource.attributes["upload-url"] as string;
        // the reference format emits ids prefixed with "cv-"; Terrence uses bare UUIDs (opaque to clients).
    expect(cvId).toBeTypeOf("string");
    expect(cvId).not.toBe("");
    expect(resource.attributes.source).toBe("tfe-api");
    expect(resource.attributes.status).toBe("pending");
    expect(resource.attributes.speculative).toBe(true);
    expect(resource.attributes.provisional).toBe(false);
    expect(resource.attributes["auto-queue-runs"]).toBe(true);
    expect(uploadUrl).toBeTypeOf("string");
    expect(resource.relationships?.["ingress-attributes"]).toMatchObject({
      links: { related: `/api/v2/configuration-versions/${resource.id}/ingress-attributes` },
    });
    expectSelfLink(resource, "/api/v2/configuration-versions/");
  });

  it("uploads and shows a configuration version", async () => {
    const showResponse = await request(`/api/v2/configuration-versions/${cvId}`, { headers });
    const pending = await showResponse.json();
    expect(pending.data.attributes["upload-url"]).toBeTypeOf("string");
    const refreshedUploadUrl = pending.data.attributes["upload-url"] as string;
    const upload = await request(refreshedUploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${seed.token}`, "Content-Type": "application/octet-stream" },
      body: validTarGzip("compat-cv"),
    });
    expect(upload.status).toBe(200);

    const resource = await expectSuccessResponse(
      await request(`/api/v2/configuration-versions/${cvId}`, { headers }),
      200,
      "configuration-versions",
    );
    expect(resource.attributes.status).toBe("uploaded");
    expect(resource.attributes.speculative).toBe(true);
    expectSelfLink(resource, "/api/v2/configuration-versions/");
  });

  it("downloads the uploaded configuration", async () => {
    const response = await request(`/api/v2/configuration-versions/${cvId}/download`, { headers });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(validTarGzip("compat-cv"));
  });

  it("lists configuration versions with pagination metadata", async () => {
    const response = await request(
      `/api/v2/workspaces/${workspaceId}/configuration-versions?page[number]=1&page[size]=10`,
      { headers },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "configuration-versions");
    expect(items.map((c) => c.id)).toContain(cvId);
    expectPaginationMeta(body);
  });

  it("returns 404 for ingress attributes when there is no VCS connection", async () => {
    await expectErrorResponse(await request(`/api/v2/configuration-versions/${cvId}/ingress-attributes`, { headers }), 404);
  });
});
