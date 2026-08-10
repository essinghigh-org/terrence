import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "../../src/db";
import { users, organizations, organizationMemberships, teams, teamWorkspaces, teamMemberships, workspaces } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { checkWorkspacePermission } from "../../src/lib/utils";

describe("delegated override expiration (kanban 18.7)", () => {
  const suffix = Date.now().toString(36);
  const ownerId = `ovr-owner-${suffix}`;
  const delegateId = `ovr-delegate-${suffix}`;
  const orgId = `org-ovr-${suffix}`;
  const teamId = `team-ovr-${suffix}`;
  const wsId = `ws-ovr-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerId, username: ownerId, passwordHash: "unused" },
      { id: delegateId, username: delegateId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: `ovr-${suffix}` });
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId: ownerId, orgId, role: "owner" },
      { id: crypto.randomUUID(), userId: delegateId, orgId, role: "member" },
    ]);
    await db.insert(workspaces).values({
      id: wsId, name: `ovr-ws-${suffix}`, orgId, createdAt: Date.now(),
    });
    await db.insert(teams).values({
      id: teamId, orgId, name: "override-team",
      organizationAccess: { "delegate-policy-overrides": true },
    });
    await db.insert(teamWorkspaces).values({
      id: crypto.randomUUID(), teamId, workspaceId: wsId, access: "custom",
      permissions: { "policy-overrides": true, runs: "apply", "workspace-locking": true },
    });
  });

  afterAll(async () => {
    await db.delete(teamWorkspaces);
    await db.delete(teams);
    await db.delete(workspaces);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(users);
  });

  it("grants delegation while unexpired and revokes it after expiry", async () => {
    await db.insert(teamMemberships).values({
      id: `mem-ovr-${suffix}`, teamId, userId: delegateId,
    });
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    expect(workspace).toBeDefined();

    // No expiry set: delegation is active (permanent default).
    expect(await checkWorkspacePermission(workspace!, delegateId, null, null, "policy-override")).toBe(true);

    // Future expiry: still active.
    await db.update(teams).set({ policyOverrideDelegationExpiresAt: Date.now() + 60_000 }).where(eq(teams.id, teamId));
    expect(await checkWorkspacePermission(workspace!, delegateId, null, null, "policy-override")).toBe(true);

    // Expired: delegation revoked, custom access alone is not enough for
    // policy-override (override power requires an active delegation).
    await db.update(teams).set({ policyOverrideDelegationExpiresAt: Date.now() - 1000 }).where(eq(teams.id, teamId));
    expect(await checkWorkspacePermission(workspace!, delegateId, null, null, "policy-override")).toBe(false);
    // Custom workspace access is unaffected by the expiry for other actions.
    expect(await checkWorkspacePermission(workspace!, delegateId, null, null, "apply")).toBe(true);

    // Clearing the expiry restores the permanent grant.
    await db.update(teams).set({ policyOverrideDelegationExpiresAt: null }).where(eq(teams.id, teamId));
    expect(await checkWorkspacePermission(workspace!, delegateId, null, null, "policy-override")).toBe(true);
  });
});