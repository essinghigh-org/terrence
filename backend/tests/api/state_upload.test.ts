import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { stateVersions, workspaces } from "../../src/db/schema";
import {
  cleanupSeed,
  expectErrorResponse,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedOrg,
} from "./compat_contract_helpers";

describe("Terraform/OpenTofu state import", () => {
  const seed = seedOrg("state-upload");
  const workspaceId = `workspace-${seed.suffix}`;
  const headers = jsonHeaders(seed.token);

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: "state-import", orgId: seed.orgId });
    const lock = await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers });
    expect(lock.status).toBe(200);
  });

  afterAll(async () => {
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  it("accepts a structurally valid partial state and preserves it", async () => {
    const state = JSON.stringify({
      version: 4,
      serial: 1,
      lineage: "migration-lineage",
      resources: [{
        mode: "managed",
        type: "null_resource",
        name: "example",
        provider: "provider[\"registry.terraform.io/hashicorp/null\"]",
        instances: [{ schema_version: 0, attributes: { id: "example" }, sensitive_attributes: [], dependencies: [] }],
      }],
    });
    const resource = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspaceId}/state-versions/upload`, {
        method: "POST",
        headers,
        body: state,
      }),
      201,
      "state-versions",
    );
    expect(resource.attributes["serial"]).toBe(1);
    expect(resource.attributes["state-version"]).toBe(4);
    expect(resource.attributes["lineage"]).toBe("migration-lineage");

    const downloaded = await request(`/api/v2/state-versions/${resource.id}/download`, { headers });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(state);
  });

  it("rejects JSON that is not a Terraform/OpenTofu state shape", async () => {
    for (const state of [
      { version: 4, serial: 1, lineage: "lineage", resources: [{}] },
      { version: 4, serial: 1, lineage: "lineage", resources: "not-an-array" },
      { version: 3, serial: 1, lineage: "lineage", resources: [] },
    ]) {
      await expectErrorResponse(
        await request(`/api/v2/workspaces/${workspaceId}/state-versions/upload`, {
          method: "POST",
          headers,
          body: JSON.stringify(state),
        }),
        400,
      );
    }
    expect(await db.select({ id: stateVersions.id }).from(stateVersions).where(eq(stateVersions.workspaceId, workspaceId))).toHaveLength(1);
  });
});
