import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { teams, teamWorkspaces, workspaces } from "../../src/db/schema";
import {
  cleanupSeed,
  expectCollection,
  expectErrorResponse,
  expectNoContent,
  expectPaginationMeta,
  expectResource,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedTfeOrg,
} from "./tfe_contract_helpers";

describe("TFE teams contract", () => {
  const seed = seedTfeOrg("team");
  const headers = jsonHeaders(seed.token);
  const workspaceId = `workspace-${seed.suffix}`;
  let teamId = "";
  let workspaceAccessId = "";

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: `teams-${seed.suffix}`, orgId: seed.orgId });
  });

  afterAll(async () => {
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.teamId, teamId));
    await db.delete(teams).where(eq(teams.id, teamId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  it("creates a team with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/teams`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "teams",
            attributes: { name: `contract-team-${seed.suffix}` },
          },
        }),
      }),
      201,
      "teams",
    );
    teamId = resource.id;
    expect(teamId.startsWith("team-")).toBe(true);
    expect(resource.attributes.name).toBe(`contract-team-${seed.suffix}`);
    expect(resource.attributes.visibility).toBe("organization");
    expect(resource.attributes["users-count"]).toBe(0);
    expect(resource.attributes["sso-team-id"]).toBeNull();
    expect(resource.attributes["organization-access"]).toMatchObject({
      "manage-policies": false,
      "manage-policy-overrides": false,
      "manage-run-tasks": false,
      "manage-workspaces": false,
      "manage-vcs-settings": false,
    });
    expect(resource.attributes.permissions).toMatchObject({
      "can-update": true,
      "can-destroy": true,
    });
    expect(resource.relationships?.users).toMatchObject({
      data: [],
    });
  });

  it("shows a team", async () => {
    const resource = await expectSuccessResponse(await request(`/api/v2/teams/${teamId}`, { headers }), 200, "teams");
    expect(resource.attributes.name).toBe(`contract-team-${seed.suffix}`);
    expect(resource.attributes["users-count"]).toBe(0);
  });

  it("lists teams with pagination metadata", async () => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/teams?page[number]=1&page[size]=10`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "teams");
    expect(items.map((t) => t.id)).toContain(teamId);
    expectPaginationMeta(body);
  });

  it("adds a user to the team", async () => {
    const response = await request(`/api/v2/teams/${teamId}/relationships/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: [
          { type: "users", id: seed.userId },
        ],
      }),
    });
    expect(response.status).toBe(204);
    const team = await expectSuccessResponse(await request(`/api/v2/teams/${teamId}`, { headers }), 200, "teams");
    expect(team.attributes["users-count"]).toBe(1);
  });

  it("creates a team workspace access relationship", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/team-workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "team-workspaces",
            attributes: { access: "write" },
            relationships: {
              team: { data: { type: "teams", id: teamId } },
              workspace: { data: { type: "workspaces", id: workspaceId } },
            },
          },
        }),
      }),
      201,
      "team-workspaces",
    );
    workspaceAccessId = resource.id;
    expect(resource.attributes.access).toBe("write");
    expect(resource.relationships?.team).toMatchObject({ data: { type: "teams", id: teamId } });
    expect(resource.relationships?.workspace).toMatchObject({ data: { type: "workspaces", id: workspaceId } });
  });

  it("shows and lists team workspace access", async () => {
    const shown = await expectSuccessResponse(
      await request(`/api/v2/team-workspaces/${workspaceAccessId}`, { headers }),
      200,
      "team-workspaces",
    );
    expect(shown.attributes.access).toBe("write");

    const response = await request(`/api/v2/team-workspaces?filter[workspace][id]=${workspaceId}`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expectResource((body as { data: unknown[] }).data[0], "team-workspaces");
  });

  it("creates and shows a team token", async () => {
    const created = await expectSuccessResponse(
      await request(`/api/v2/teams/${teamId}/authentication-token`, { method: "POST", headers }),
      201,
      "authentication-tokens",
    );
    expect(created.attributes.token).toBeTypeOf("string");
    expect(created.attributes.token).not.toBeNull();

    const shown = await expectSuccessResponse(
      await request(`/api/v2/teams/${teamId}/authentication-token`, { headers }),
      200,
      "authentication-tokens",
    );
    expect(shown.attributes.token === null || shown.attributes.token === undefined).toBe(true);
    expect(shown.attributes["created-at"]).toBeTypeOf("string");
  });

  it("deletes the team token", async () => {
    await expectNoContent(await request(`/api/v2/teams/${teamId}/authentication-token`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/teams/${teamId}/authentication-token`, { headers }), 404);
  });

  it("destroys a team", async () => {
    await expectNoContent(await request(`/api/v2/teams/${teamId}`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/teams/${teamId}`, { headers }), 404);
  });
});
