import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  organizationMembershipRoles,
  organizationMemberships,
  organizationRoles,
  organizations,
  projects,
  teamMemberships,
  teamProjects,
  teamWorkspaces,
  teams,
  users,
  workspaces,
} from "../../src/db/schema";
import {
  checkProjectPermission,
  checkProjectWorkspaceOperation,
  checkWorkspacePermission,
  workspaceAllows,
  workspacePermissionSets,
} from "../../src/lib/utils";

describe("project and direct-role authorization", () => {
  const suffix = crypto.randomUUID();
  const orgId = `auth-org-${suffix}`;
  const roleUserId = `auth-role-user-${suffix}`;
  const projectUserId = `auth-project-user-${suffix}`;
  const roleMembershipId = `auth-role-membership-${suffix}`;
  const projectMembershipId = `auth-project-membership-${suffix}`;
  const roleId = `auth-role-${suffix}`;
  const teamId = `auth-team-${suffix}`;
  const teamMembershipId = `auth-team-membership-${suffix}`;
  const projectId = `auth-project-${suffix}`;
  const unrelatedProjectId = `auth-project-other-${suffix}`;
  const workspaceId = `auth-workspace-${suffix}`;
  const unrelatedWorkspaceId = `auth-workspace-other-${suffix}`;
  const teamProjectId = `auth-team-project-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: roleUserId, username: roleUserId, passwordHash: "unused" },
      { id: projectUserId, username: projectUserId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: `auth-${suffix}` });
    await db.insert(organizationMemberships).values([
      { id: roleMembershipId, userId: roleUserId, orgId, role: "member" },
      { id: projectMembershipId, userId: projectUserId, orgId, role: "member" },
    ]);
    await db.insert(organizationRoles).values({
      id: roleId,
      orgId,
      name: "Workspace operator",
      permissions: { "manage-workspaces": true },
    });
    await db.insert(organizationMembershipRoles).values({ membershipId: roleMembershipId, roleId });
    await db.insert(projects).values([
      { id: projectId, orgId, name: `project-${suffix}` },
      { id: unrelatedProjectId, orgId, name: `other-${suffix}` },
    ]);
    await db.insert(workspaces).values([
      { id: workspaceId, orgId, projectId, name: `workspace-${suffix}` },
      { id: unrelatedWorkspaceId, orgId, projectId: unrelatedProjectId, name: `other-workspace-${suffix}` },
    ]);
    await db.insert(teams).values({
      id: teamId,
      orgId,
      name: `project-team-${suffix}`,
      organizationAccess: {},
    });
    await db.insert(teamMemberships).values({
      id: teamMembershipId,
      teamId,
      userId: projectUserId,
      createdAt: Date.now(),
    });
    await db.insert(teamProjects).values({
      id: teamProjectId,
      teamId,
      projectId,
      organizationId: orgId,
      access: "maintain",
    });
  });

  afterAll(async () => {
    await db.delete(teamProjects).where(eq(teamProjects.id, teamProjectId));
    await db.delete(teamMemberships).where(eq(teamMemberships.id, teamMembershipId));
    await db.delete(teams).where(eq(teams.id, teamId));
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(projects).where(eq(projects.orgId, orgId));
    await db
      .delete(organizationMembershipRoles)
      .where(
        and(
          eq(organizationMembershipRoles.membershipId, roleMembershipId),
          eq(organizationMembershipRoles.roleId, roleId),
        ),
      );
    await db.delete(organizationRoles).where(eq(organizationRoles.id, roleId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, roleUserId));
    await db.delete(users).where(eq(users.id, projectUserId));
  });

  it("applies a direct organization manage-workspaces role to single and batched workspace checks", async () => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    expect(workspace).toBeDefined();

    expect(await checkWorkspacePermission(workspace!, roleUserId, null, null, "read")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, roleUserId, null, null, "admin")).toBe(true);

    const sets = await workspacePermissionSets(orgId, roleUserId, null, null);
    expect(workspaceAllows(sets.read, workspaceId)).toBe(true);
    expect(workspaceAllows(sets.admin, workspaceId)).toBe(true);
    expect(workspaceAllows(sets.admin, unrelatedWorkspaceId)).toBe(true);

    await db
      .update(organizationRoles)
      .set({ permissions: { "read-workspaces": true } })
      .where(eq(organizationRoles.id, roleId));
    expect(await checkWorkspacePermission(workspace!, roleUserId, null, null, "read")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, roleUserId, null, null, "admin")).toBe(false);

    await db
      .delete(organizationMembershipRoles)
      .where(
        and(
          eq(organizationMembershipRoles.membershipId, roleMembershipId),
          eq(organizationMembershipRoles.roleId, roleId),
        ),
      );
    expect(await checkWorkspacePermission(workspace!, roleUserId, null, null, "read")).toBe(false);

    await db
      .update(organizationRoles)
      .set({ permissions: { "manage-workspaces": true } })
      .where(eq(organizationRoles.id, roleId));
    await db.insert(organizationMembershipRoles).values({ membershipId: roleMembershipId, roleId });
  });

  it("applies every team-project preset/custom map and composes direct workspace grants", async () => {
    const [workspace, unrelatedWorkspace] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
      db.query.workspaces.findFirst({ where: eq(workspaces.id, unrelatedWorkspaceId) }),
    ]);
    expect(workspace).toBeDefined();
    expect(unrelatedWorkspace).toBeDefined();

    const setAccess = async (
      access: string,
      projectAccess: Record<string, string> | null = null,
      workspaceAccess: Record<string, unknown> | null = null,
    ): Promise<void> => {
      await db
        .update(teamProjects)
        .set({ access, projectAccess, workspaceAccess })
        .where(eq(teamProjects.id, teamProjectId));
    };

    await setAccess("read");
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "read")).toBe(true);
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "update")).toBe(false);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "read")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "apply")).toBe(false);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "admin")).toBe(false);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "create")).toBe(false);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "move")).toBe(false);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "delete")).toBe(false);

    await setAccess("write");
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "apply")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "lock")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "state-write")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "admin")).toBe(false);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "create")).toBe(false);

    await setAccess("maintain");
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "update")).toBe(false);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "admin")).toBe(true);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "create")).toBe(true);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "delete")).toBe(true);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "move")).toBe(false);

    await setAccess("admin");
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "update")).toBe(true);
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "delete")).toBe(true);
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "manage-teams")).toBe(true);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "move")).toBe(true);

    await setAccess(
      "custom",
      { settings: "update", teams: "manage" },
      {
        create: true,
        move: false,
        locking: true,
        delete: false,
        runs: "plan",
        variables: "read",
        "state-versions": "read-outputs",
        "sentinel-mocks": "none",
        "run-tasks": false,
        "policy-overrides": false,
      },
    );
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "read")).toBe(true);
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "update")).toBe(true);
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "delete")).toBe(false);
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "manage-teams")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "plan")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "apply")).toBe(false);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "lock")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "variables-read")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "variables-write")).toBe(false);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "state-outputs")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "state-read")).toBe(false);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "admin")).toBe(false);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "create")).toBe(true);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "move")).toBe(false);
    expect(await checkProjectWorkspaceOperation(projectId, orgId, projectUserId, null, null, "delete")).toBe(false);

    expect(await checkWorkspacePermission(workspace!, undefined, null, teamId, "read")).toBe(true);
    expect(await checkProjectPermission(projectId, orgId, undefined, null, teamId, "update")).toBe(true);
    expect(await checkProjectPermission(unrelatedProjectId, orgId, projectUserId, null, null, "read")).toBe(false);

    const directGrantId = `auth-direct-workspace-${suffix}`;
    await db.insert(teamWorkspaces).values({
      id: directGrantId,
      teamId,
      workspaceId: unrelatedWorkspaceId,
      access: "read",
      permissions: null,
    });
    expect(await checkWorkspacePermission(unrelatedWorkspace!, projectUserId, null, null, "read")).toBe(true);
    expect(await checkWorkspacePermission(unrelatedWorkspace!, projectUserId, null, null, "plan")).toBe(false);

    const sets = await workspacePermissionSets(orgId, projectUserId, null, null);
    expect(workspaceAllows(sets.read, workspaceId)).toBe(true);
    expect(workspaceAllows(sets.read, unrelatedWorkspaceId)).toBe(true);
    expect(workspaceAllows(sets.plan, workspaceId)).toBe(true);
    expect(workspaceAllows(sets.plan, unrelatedWorkspaceId)).toBe(false);

    await db.delete(teamProjects).where(eq(teamProjects.id, teamProjectId));
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "read")).toBe(false);
    expect(await checkWorkspacePermission(unrelatedWorkspace!, projectUserId, null, null, "read")).toBe(true);
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "read")).toBe(false);

    await db.insert(teamProjects).values({
      id: teamProjectId,
      teamId,
      projectId,
      organizationId: null,
      access: "read",
    });
    expect(await checkProjectPermission(projectId, orgId, projectUserId, null, null, "read")).toBe(true);
    expect(await checkWorkspacePermission(workspace!, projectUserId, null, null, "read")).toBe(true);

    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.id, directGrantId));
    await db.delete(teamProjects).where(eq(teamProjects.id, teamProjectId));
  });
});
