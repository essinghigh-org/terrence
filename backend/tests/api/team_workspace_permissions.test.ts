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
  users,
  workspaces,
} from "../../src/db/schema";

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
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

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

  it("validates relationship grants and blocks policy overrides from workspace admins", async () => {
    const invalidAccess = await request(
      "/api/v2/team-workspaces",
      "POST",
      relationshipBody({ access: "superuser" }),
    );
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
    const allowedDocument = await allowedCreate.json() as { data: { id: string } };
    createdRelationshipId = allowedDocument.data.id;

    const deniedPatch = await request(
      `/api/v2/team-workspaces/${createdRelationshipId}`,
      "PATCH",
      {
        data: {
          type: "team-workspaces",
          attributes: { permissions: { runs: "read", "policy-overrides": true } },
        },
      },
    );
    expect(deniedPatch.status).toBe(403);
    expect((await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, createdRelationshipId) }))?.permissions).toEqual({
      runs: "plan",
      variables: "read",
    });

    await db.update(teams).set({ organizationAccess: { "manage-policy-overrides": true } }).where(eq(teams.id, adminTeamId));
    const allowedPatch = await request(
      `/api/v2/team-workspaces/${createdRelationshipId}`,
      "PATCH",
      {
        data: {
          type: "team-workspaces",
          attributes: { permissions: { runs: "read", "policy-overrides": true } },
        },
      },
    );
    expect(allowedPatch.status).toBe(200);
    expect((await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, createdRelationshipId) }))?.permissions).toEqual({
      runs: "read",
      "policy-overrides": true,
    });
  });
});
