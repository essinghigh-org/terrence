import { beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db, getQueryCount, resetQueryCount } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  projects,
  runs,
  teams,
  teamWorkspaces,
  users,
  workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { jsonHeaders, persistSeed, request, seedOrg } from "./compat_contract_helpers";

describe("authorized operations search candidates", () => {
  const seed = seedOrg("search");
  const needle = `hunt-${seed.suffix}`;
  const workspaceId = `ws-${seed.suffix}`;
  const hiddenWorkspaceId = `hidden-${workspaceId}`;
  const projectId = `prj-${seed.suffix}`;
  const runId = `run-${seed.suffix}`;
  const teamId = `team-${seed.suffix}`;
  const orgToken = `org-secret-${seed.suffix}`;
  const teamToken = `team-secret-${seed.suffix}`;
  const scopedToken = `scoped-secret-${seed.suffix}`;

  async function search(token: string, path = "/api/v2/search"): Promise<string[]> {
    const response = await request(`${path}?q=${needle}`, { headers: jsonHeaders(token) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string }[] };
    return body.data.map((resource): string => resource.id).sort();
  }

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(projects).values({ id: projectId, orgId: seed.orgId, name: needle });
    await db.insert(workspaces).values([
      { id: workspaceId, orgId: seed.orgId, projectId, name: `zzz-${needle}` },
      { id: hiddenWorkspaceId, orgId: seed.orgId, name: `zzz-${needle}-hidden` },
    ]);
    await db.insert(runs).values({ id: runId, workspaceId, message: needle, status: "applied", createdAt: Date.now() });
    await db.insert(teams).values({ id: teamId, orgId: seed.orgId, name: "search-readers" });
    await db.insert(teamWorkspaces).values({
      id: `grant-${seed.suffix}`,
      teamId,
      workspaceId,
      access: "read",
    });
    await db.insert(apiTokens).values([
      { id: `org-token-${seed.suffix}`, token: hashAuthenticationToken(orgToken), orgId: seed.orgId },
      { id: `team-token-${seed.suffix}`, token: hashAuthenticationToken(teamToken), teamId },
      {
        id: `scoped-token-${seed.suffix}`,
        token: hashAuthenticationToken(scopedToken),
        userId: seed.userId,
        scopes: JSON.stringify({
          version: 1,
          orgs: [seed.orgId],
          workspaces: [workspaceId],
          permissions: { "workspaces:read": true },
        }),
      },
    ]);
    // Each foreign tenant sorts before the readable workspaces. The old
    // global cap both hid our results and evaluated all 500 foreign tenants.
    for (let offset = 0; offset < 500; offset += 50) {
      const foreignOrganizations = Array.from({ length: 50 }, (_, index) => ({
        id: `foreign-${seed.suffix}-${offset + index}`,
        name: `foreign-${seed.suffix}-${offset + index}`,
      }));
      await db.insert(organizations).values(foreignOrganizations);
      await db.insert(workspaces).values(
        foreignOrganizations.map((organization) => ({
          id: `ws-${organization.id}`,
          orgId: organization.id,
          name: `aaa-${needle}-${organization.id}`,
        })),
      );
    }
  });

  it("searches the user's readable workspaces before applying the candidate cap", async () => {
    const previous = process.env["TERRENCE_QUERY_COUNT"];
    process.env["TERRENCE_QUERY_COUNT"] = "1";
    try {
      resetQueryCount();
      const ids = await search(seed.token);
      // Permission work depends on the user's organizations, not on the
      // 500 unrelated organizations seeded above.
      expect(getQueryCount()).toBeGreaterThan(0);
      expect(getQueryCount()).toBeLessThan(20);
      expect(ids).toEqual([hiddenWorkspaceId, projectId, runId, workspaceId].sort());
    } finally {
      if (previous === undefined) delete process.env["TERRENCE_QUERY_COUNT"];
      else process.env["TERRENCE_QUERY_COUNT"] = previous;
    }
  });

  it("supports organization tokens on the operations search alias", async () => {
    expect(await search(orgToken, "/api/v2/operations/search")).toEqual(
      [hiddenWorkspaceId, projectId, runId, workspaceId].sort(),
    );
  });

  it("keeps team tokens within their readable workspace grants", async () => {
    expect(await search(teamToken)).toEqual([projectId, runId, workspaceId].sort());
  });

  it("applies fine-grained workspace scopes for owners and site administrators", async () => {
    expect(await search(scopedToken)).toEqual([projectId, runId, workspaceId].sort());
    await db.update(users).set({ isSiteAdmin: true }).where(eq(users.id, seed.userId));
    try {
      expect(await search(scopedToken)).toEqual([projectId, runId, workspaceId].sort());
    } finally {
      await db.update(users).set({ isSiteAdmin: false }).where(eq(users.id, seed.userId));
    }
  });

  it("excludes inactive organization memberships", async () => {
    await db
      .update(organizationMemberships)
      .set({ status: "invited" })
      .where(eq(organizationMemberships.id, seed.membershipId));
    try {
      expect(await search(seed.token)).toEqual([]);
      expect(await search(scopedToken)).toEqual([]);
    } finally {
      await db
        .update(organizationMemberships)
        .set({ status: "active" })
        .where(eq(organizationMemberships.id, seed.membershipId));
    }
  });
});
