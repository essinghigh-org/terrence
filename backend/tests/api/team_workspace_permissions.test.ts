import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  teamMemberships,
  teams,
  teamWorkspaces,
  workspaceVariables,
  users,
  workspaces,
} from "../../src/db/schema";
import { workspaceIdsForPermission } from "../../src/lib/authorization";

describe("team workspace permission validation", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-team-workspace-permissions-${suffix}`;
  const workspaceId = `ws-team-workspace-permissions-${suffix}`;
  const adminTeamId = `team-workspace-admin-${suffix}`;
  const targetTeamId = `team-workspace-target-${suffix}`;
  const userId = `user-team-workspace-permissions-${suffix}`;
  const token = `token-team-workspace-permissions-${suffix}`;
  const adminMembershipId = `tm-team-workspace-admin-${suffix}`;
  let createdRelationshipId: string | undefined;

  const request = (path: string, method: string, body?: unknown): Promise<Response> =>
    app.handle(
      new Request(`http://terrence.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const relationshipBody = (attributes: Record<string, unknown>): Record<string, unknown> => ({
    data: {
      type: "team-workspaces",
      attributes,
      relationships: {
        team: { data: { id: targetTeamId, type: "teams" } },
        workspace: { data: { id: workspaceId, type: "workspaces" } },
      },
    },
  });

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: `team-workspace-permissions-${suffix}` });
    await db.insert(organizationMemberships).values({
      id: `om-team-workspace-permissions-${suffix}`,
      userId,
      orgId,
      role: "member",
    });
    await db.insert(workspaces).values({ id: workspaceId, name: `workspace-${suffix}`, orgId });
    await db.insert(teams).values([
      { id: adminTeamId, orgId, name: `workspace-admin-${suffix}`, organizationAccess: {} },
      { id: targetTeamId, orgId, name: `workspace-target-${suffix}`, organizationAccess: {} },
    ]);
    await db.insert(teamMemberships).values({
      id: adminMembershipId,
      teamId: adminTeamId,
      userId,
      createdAt: Date.now(),
    });
    await db.insert(teamWorkspaces).values({
      id: `tw-team-workspace-admin-${suffix}`,
      teamId: adminTeamId,
      workspaceId,
      access: "admin",
      permissions: null,
    });
    await db.insert(apiTokens).values({
      id: `token-team-workspace-permissions-${suffix}`,
      token: createHash("sha256").update(token).digest("hex"),
      userId,
    });
  });

  afterAll(async () => {
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.workspaceId, workspaceId));
    await db.delete(teamMemberships).where(eq(teamMemberships.id, adminMembershipId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(teams).where(eq(teams.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("bounds team workspace grants and global variable queries to the selected organization", async () => {
    const otherOrgId = `org-other-${suffix}`;
    const otherWorkspaceId = `ws-other-${suffix}`;
    const otherTeamId = `team-other-${suffix}`;
    const scopeId = `scope-team-${suffix}`;
    const scopeToken = `scope-team-${crypto.randomUUID()}`;
    await db.insert(organizations).values({ id: otherOrgId, name: otherOrgId });
    try {
      await db.insert(organizationMemberships).values({ id: otherOrgId, orgId: otherOrgId, userId, role: "member" });
      await db.insert(workspaces).values({ id: otherWorkspaceId, orgId: otherOrgId, name: otherWorkspaceId });
      await db.insert(teams).values({ id: otherTeamId, orgId: otherOrgId, name: otherTeamId, organizationAccess: {} });
      await db.insert(teamMemberships).values({ id: otherTeamId, teamId: otherTeamId, userId });
      await db
        .insert(teamWorkspaces)
        .values({ id: otherTeamId, teamId: otherTeamId, workspaceId: otherWorkspaceId, access: "read" });
      await db.insert(workspaceVariables).values([
        { id: `${scopeId}-local`, workspaceId, key: "LOCAL_FIXTURE", value: "local" },
        { id: `${scopeId}-other`, workspaceId: otherWorkspaceId, key: "OTHER_FIXTURE", value: "other" },
      ]);
      const ids = await workspaceIdsForPermission(orgId, userId, null, null, "variables-read");
      expect(ids).toContain(workspaceId);
      expect(ids).not.toContain(otherWorkspaceId);
      await db.insert(apiTokens).values({
        id: scopeId,
        userId,
        token: createHash("sha256").update(scopeToken).digest("hex"),
        scopes: JSON.stringify({ version: 1, orgs: [orgId], permissions: { "variables:read": true } }),
        expiresAt: Date.now() + 60_000,
      });
      const response = await app.handle(
        new Request("http://terrence.test/api/v2/vars", { headers: { Authorization: `Bearer ${scopeToken}` } }),
      );
      expect(response.status).toBe(200);
      const document = (await response.json()) as { data: { id: string }[] };
      expect(document.data.map((resource): string => resource.id)).toContain(`${scopeId}-local`);
      expect(document.data.map((resource): string => resource.id)).not.toContain(`${scopeId}-other`);
    } finally {
      await db.delete(apiTokens).where(eq(apiTokens.id, scopeId));
      await db.delete(workspaceVariables).where(eq(workspaceVariables.id, `${scopeId}-local`));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
  });

  it("validates relationship grants and blocks policy overrides from workspace admins", async () => {
    const invalidAccess = await request("/api/v2/team-workspaces", "POST", relationshipBody({ access: "superuser" }));
    expect(invalidAccess.status).toBe(422);

    const invalidPermissions = await request(
      "/api/v2/team-workspaces",
      "POST",
      relationshipBody({ access: "custom", permissions: { runs: "execute" } }),
    );
    expect(invalidPermissions.status).toBe(422);

    const deniedCreate = await request(
      "/api/v2/team-workspaces",
      "POST",
      relationshipBody({
        access: "custom",
        permissions: { runs: "read", "policy-overrides": true },
      }),
    );
    expect(deniedCreate.status).toBe(403);
    expect(await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.teamId, targetTeamId) })).toBeUndefined();

    const allowedCreate = await request(
      "/api/v2/team-workspaces",
      "POST",
      relationshipBody({
        access: "custom",
        permissions: { runs: "plan", variables: "read" },
      }),
    );
    expect(allowedCreate.status).toBe(201);
    const allowedDocument = (await allowedCreate.json()) as { data: { id: string } };
    createdRelationshipId = allowedDocument.data.id;

    const deniedPatch = await request(`/api/v2/team-workspaces/${createdRelationshipId}`, "PATCH", {
      data: {
        type: "team-workspaces",
        attributes: { permissions: { runs: "read", "policy-overrides": true } },
      },
    });
    expect(deniedPatch.status).toBe(403);
    expect(
      (await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, createdRelationshipId) }))?.permissions,
    ).toEqual({
      runs: "plan",
      variables: "read",
    });

    await db
      .update(teams)
      .set({ organizationAccess: { "manage-policy-overrides": true } })
      .where(eq(teams.id, adminTeamId));
    const allowedPatch = await request(`/api/v2/team-workspaces/${createdRelationshipId}`, "PATCH", {
      data: {
        type: "team-workspaces",
        attributes: { permissions: { runs: "read", "policy-overrides": true } },
      },
    });
    expect(allowedPatch.status).toBe(200);
    expect(
      (await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, createdRelationshipId) }))?.permissions,
    ).toEqual({
      runs: "read",
      "policy-overrides": true,
    });
  });
});
