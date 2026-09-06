import { expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { apiTokens, projects, runs, teams, teamWorkspaces, workspaces, workspaceTags } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { cleanupSeed, jsonHeaders, persistSeed, request, seedOrg } from "./compat_contract_helpers";

test("workspace pages filter before slicing and aggregate only authorized organization rows", async () => {
  const seed = seedOrg("list-query");
  const other = seedOrg("list-other");
  const id = (name: string): string => `${name}-${seed.suffix}`;
  const headers = jsonHeaders(seed.token);
  const list = async (query: string, credential = headers) => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/workspaces?${query}`, { headers: credential });
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    await persistSeed(seed);
    await persistSeed(other);
    await db.insert(projects).values({ id: id("project"), orgId: seed.orgId, name: "Platform" });
    await db.insert(workspaces).values([
      { id: id("alpha"), name: "alpha", orgId: seed.orgId, projectId: id("project"), locked: true },
      { id: id("beta"), name: "beta", orgId: seed.orgId },
      { id: id("gamma"), name: "gamma", orgId: seed.orgId },
      { id: id("hidden"), name: "alpha-secret", orgId: other.orgId, locked: true },
    ]);
    await db.insert(workspaceTags).values({ id: id("tag"), workspaceId: id("gamma"), key: "prod_%", value: "true" });
    await db.insert(runs).values([
      { id: id("old"), workspaceId: id("alpha"), status: "errored", createdAt: 1 },
      { id: id("new-a"), workspaceId: id("alpha"), status: "applying", createdAt: 2 },
      { id: id("new-b"), workspaceId: id("alpha"), status: "errored", createdAt: 2 },
      { id: id("beta-run"), workspaceId: id("beta"), status: "errored", createdAt: 3 },
      { id: id("other-run"), workspaceId: id("hidden"), status: "errored", createdAt: 3 },
    ]);
    const expectedSummary = { total: 3, locked: 1, "run-statuses": { applying: 1, errored: 1 } };
    const first = await list("page[size]=1&include=current_run,workspace_summary");
    expect(first.data.map((row: { id: string }) => row.id)).toEqual([id("alpha")]);
    expect(first.included.map((row: { id: string }) => row.id)).toEqual([id("new-a")]);
    expect(first.meta.pagination["total-count"]).toBe(3);
    expect(first.meta["workspace-summary"]).toEqual(expectedSummary);
    const last = await list("page[size]=1&sort=-name&include=workspace_summary");
    expect(last.data[0].id).toBe(id("gamma"));
    const filtered = await list("page[size]=1&filter[current-run][status]=errored&include=workspace_summary");
    expect(filtered.data.map((row: { id: string }) => row.id)).toEqual([id("beta")]);
    expect(filtered.meta.pagination["total-count"]).toBe(1);
    expect(filtered.meta["workspace-summary"]).toEqual(expectedSummary);
    expect((await list("filter[locked]=true&filter[project][id]=" + id("project"))).data[0].id).toBe(id("alpha"));
    expect((await list("search[query]=PROD_%25")).data[0].id).toBe(id("gamma"));
    expect((await list("search[query]=a&filter[locked]=false")).data.map((row: { id: string }) => row.id)).toEqual([id("beta"), id("gamma")]);
    expect((await list("search[query]=absent&include=workspace_summary")).meta["workspace-summary"]).toEqual(expectedSummary);
    for (const invalid of ["sort=unsupported", "filter[locked]=perhaps"]) {
      expect((await request(`/api/v2/organizations/${seed.orgName}/workspaces?${invalid}`, { headers })).status).toBe(400);
    }
    // A team credential sees the same permission boundary in rows AND totals.
    const teamToken = `team-token-${seed.suffix}`;
    await db.insert(teams).values({ id: id("team"), orgId: seed.orgId, name: "Readers" });
    await db.insert(teamWorkspaces).values({ id: id("grant"), teamId: id("team"), workspaceId: id("beta"), access: "read" });
    await db.insert(apiTokens).values({ id: id("token"), token: hashAuthenticationToken(teamToken), teamId: id("team"), orgId: seed.orgId });
    const restricted = await list("include=current_run,workspace_summary", jsonHeaders(teamToken));
    expect(restricted.data.map((row: { id: string }) => row.id)).toEqual([id("beta")]);
    expect(restricted.meta["workspace-summary"]).toEqual({ total: 1, locked: 0, "run-statuses": { errored: 1 } });
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.id, id("grant")));
    const revoked = await list("include=workspace_summary", jsonHeaders(teamToken));
    expect(revoked.data).toEqual([]);
    expect(revoked.meta["workspace-summary"]).toEqual({ total: 0, locked: 0, "run-statuses": {} });
  } finally {
    await db.delete(apiTokens).where(eq(apiTokens.id, id("token")));
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.teamId, id("team")));
    await db.delete(teams).where(eq(teams.id, id("team")));
    await db.delete(runs).where(inArray(runs.workspaceId, [id("alpha"), id("beta"), id("hidden")]));
    await db.delete(workspaces).where(inArray(workspaces.orgId, [seed.orgId, other.orgId]));
    await db.delete(projects).where(eq(projects.id, id("project")));
    await cleanupSeed(seed);
    await cleanupSeed(other);
  }
});
