import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  policyChecks,
  projects,
  runs,
  teams,
  teamWorkspaces,
  users,
  workspaces,
} from "../../src/db/schema";

const permissionByRole = {
  none: {},
  membership: { "manage-membership": true },
  teams: { "manage-teams": true },
  organizationAccess: { "manage-organization-access": true },
  readProjects: { "read-projects": true },
  readWorkspaces: { "read-workspaces": true },
  manageProjects: { "manage-projects": true },
  manageWorkspaces: { "manage-workspaces": true },
  vcs: { "manage-vcs-settings": true },
  policies: { "manage-policies": true },
  overrides: { "manage-policy-overrides": true },
  delegateOverrides: { "delegate-policy-overrides": true },
  runTasks: { "manage-run-tasks": true },
  agentPools: { "manage-agent-pools": true },
  providers: { "manage-providers": true },
  modules: { "manage-modules": true },
} satisfies Record<string, Record<string, boolean>>;

type Role = keyof typeof permissionByRole;

describe("granular organization permissions", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-permissions-${suffix}`;
  const orgName = `permissions-${suffix}`;
  const projectId = `prj-permissions-${suffix}`;
  const workspaceId = `ws-permissions-${suffix}`;
  const otherWorkspaceId = `ws-permissions-other-${suffix}`;
  const ownerId = `usr-permissions-owner-${suffix}`;
  const memberId = `usr-permissions-member-${suffix}`;
  const ownerToken = `owner-permissions-${suffix}`;
  const organizationToken = `organization-permissions-${suffix}`;
  const teamIds = Object.fromEntries(
    Object.keys(permissionByRole).map((role): [string, string] => [role, `team-permissions-${role}-${suffix}`]),
  ) as Record<Role, string>;
  const tokens = Object.fromEntries(
    Object.keys(permissionByRole).map((role): [string, string] => [role, `token-permissions-${role}-${suffix}`]),
  ) as Record<Role, string>;
  const runIds = {
    global: `run-permissions-global-${suffix}`,
    direct: `run-permissions-direct-${suffix}`,
    unassigned: `run-permissions-unassigned-${suffix}`,
  };
  const checkIds = {
    global: `check-permissions-global-${suffix}`,
    direct: `check-permissions-direct-${suffix}`,
    unassigned: `check-permissions-unassigned-${suffix}`,
  };

  const request = (path: string, auth: string, method = "GET", body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const resource = (type: string, attributes: Record<string, unknown>): Record<string, unknown> => ({
    data: { type, attributes },
  });
  const workspaceVariable = (key: string): Record<string, unknown> => ({
    data: {
      type: "vars",
      attributes: { key, value: "value", category: "terraform" },
      relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } },
    },
  });

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerId, username: ownerId, passwordHash: "unused" },
      { id: memberId, username: memberId, email: `${memberId}@example.test`, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `membership-owner-${suffix}`,
      userId: ownerId,
      orgId,
      role: "owner",
    });
    await db.insert(projects).values({ id: projectId, orgId, name: `seed-${suffix}` });
    await db.insert(workspaces).values([
      { id: workspaceId, orgId, projectId, name: `assigned-${suffix}` },
      { id: otherWorkspaceId, orgId, projectId, name: `unassigned-${suffix}` },
    ]);
    await db.insert(teams).values(Object.entries(permissionByRole).map(([role, organizationAccess]) => ({
      id: teamIds[role as Role],
      orgId,
      name: `permissions-${role}-${suffix}`,
      organizationAccess,
    })));
    await db.insert(teamWorkspaces).values([
      {
        id: `tw-permissions-none-${suffix}`,
        teamId: teamIds.none,
        workspaceId,
        access: "custom",
        permissions: { runs: "read", "policy-overrides": true },
      },
      {
        id: `tw-permissions-delegate-${suffix}`,
        teamId: teamIds.delegateOverrides,
        workspaceId,
        access: "custom",
        permissions: { runs: "read", "policy-overrides": true },
      },
    ]);
    await db.insert(runs).values([
      { id: runIds.global, workspaceId, status: "policy_override", createdAt: Date.now() },
      { id: runIds.direct, workspaceId, status: "policy_override", createdAt: Date.now() + 1 },
      { id: runIds.unassigned, workspaceId: otherWorkspaceId, status: "policy_override", createdAt: Date.now() + 2 },
    ]);
    await db.insert(policyChecks).values([
      { id: checkIds.global, runId: runIds.global, status: "soft_failed" },
      { id: checkIds.direct, runId: runIds.direct, status: "soft_failed" },
      { id: checkIds.unassigned, runId: runIds.unassigned, status: "soft_failed" },
    ]);
    await db.insert(apiTokens).values([
      ...Object.entries(tokens).map(([role, token]) => ({
        id: `api-permissions-${role}-${suffix}`,
        token: createHash("sha256").update(token).digest("hex"),
        teamId: teamIds[role as Role],
      })),
      {
        id: `api-permissions-owner-${suffix}`,
        token: createHash("sha256").update(ownerToken).digest("hex"),
        userId: ownerId,
      },
      {
        id: `api-permissions-organization-${suffix}`,
        token: createHash("sha256").update(organizationToken).digest("hex"),
        orgId,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, memberId));
  });

  it("denies management APIs to a team without organization permissions", async () => {
    const responses = await Promise.all([
      request(`/api/v2/organizations/${orgName}/teams`, tokens.none, "POST", resource("teams", { name: "denied-team" })),
      request(`/api/v2/organizations/${orgName}/organization-memberships`, tokens.none, "POST", resource("organization-memberships", { username: memberId })),
      request(`/api/v2/organizations/${orgName}/projects`, tokens.none, "POST", resource("projects", { name: "denied-project" })),
      request(`/api/v2/organizations/${orgName}/ssh-keys`, tokens.none, "POST", resource("ssh-keys", { name: "denied-key", value: "secret" })),
      request(`/api/v2/organizations/${orgName}/policy-sets`, tokens.none, "POST", resource("policy-sets", { name: "denied-policies" })),
      request(`/api/v2/organizations/${orgName}/run-tasks`, tokens.none, "POST", resource("run-tasks", { name: "denied-task", url: "https://example.test/task" })),
      request(`/api/v2/organizations/${orgName}/varsets`, tokens.none),
      request(`/api/v2/organizations/${orgName}/varsets`, tokens.none, "POST", resource("varsets", { name: "denied-varset" })),
      request("/api/v2/vars", tokens.none, "POST", workspaceVariable(`denied-variable-${suffix}`)),
      request(`/api/v2/workspaces/${workspaceId}/relationships/run-triggers`, tokens.none, "POST", { data: [] }),
      request(`/api/v2/organizations/${orgName}/agent-pools`, tokens.none),
      request(`/api/v2/organizations/${orgName}/agent-pools`, tokens.none, "POST", resource("agent-pools", { name: "denied-pool" })),
      request(`/api/v2/organizations/${orgName}/registry-providers`, tokens.none, "POST", resource("registry-providers", { name: "denied-provider", namespace: orgName })),
      request(`/api/v2/organizations/${orgName}/registry-modules`, tokens.none, "POST", resource("registry-modules", { name: "denied-module", provider: "aws", namespace: orgName })),
      request(`/api/v2/policy-checks/${checkIds.global}/actions/override`, tokens.none, "POST"),
    ]);
    expect(responses.map(({ status }) => status)).toEqual(Array(15).fill(404));

    const workspace = await request(
      `/api/v2/organizations/${orgName}/workspaces`,
      tokens.none,
      "POST",
      resource("workspaces", { name: "denied-workspace" }),
    );
    expect(workspace.status).toBe(403);
  });

  it("enforces membership, team, and organization-access delegation", async () => {
    const invite = await request(
      `/api/v2/organizations/${orgName}/organization-memberships`,
      tokens.membership,
      "POST",
      resource("organization-memberships", { username: memberId }),
    );
    expect(invite.status).toBe(201);
    expect((await request(
      `/api/v2/teams/${teamIds.none}/relationships/users`,
      tokens.membership,
      "POST",
      { data: [{ id: memberId, type: "users" }] },
    )).status).toBe(204);
    expect((await request(
      `/api/v2/organizations/${orgName}/teams`,
      tokens.membership,
      "POST",
      resource("teams", { name: `membership-cannot-create-${suffix}` }),
    )).status).toBe(404);

    const plainTeam = await request(
      `/api/v2/organizations/${orgName}/teams`,
      tokens.teams,
      "POST",
      resource("teams", { name: `managed-team-${suffix}` }),
    );
    expect(plainTeam.status).toBe(201);
    const plainTeamId = (await plainTeam.json() as { data: { id: string } }).data.id;
    expect((await request(
      `/api/v2/teams/${plainTeamId}/relationships/users`,
      tokens.teams,
      "POST",
      { data: [{ id: memberId, type: "users" }] },
    )).status).toBe(204);
    expect((await request(
      `/api/v2/organizations/${orgName}/teams`,
      tokens.teams,
      "POST",
      resource("teams", {
        name: `team-cannot-delegate-${suffix}`,
        "organization-access": { "manage-policies": true },
      }),
    )).status).toBe(404);

    const delegatedTeam = await request(
      `/api/v2/organizations/${orgName}/teams`,
      tokens.organizationAccess,
      "POST",
      resource("teams", {
        name: `delegated-team-${suffix}`,
        "organization-access": { "manage-run-tasks": true },
      }),
    );
    expect(delegatedTeam.status).toBe(201);
    expect((await request(
      `/api/v2/teams/${plainTeamId}`,
      tokens.organizationAccess,
      "PATCH",
      resource("teams", { "organization-access": { "manage-vcs-settings": true } }),
    )).status).toBe(200);
  });

  it("applies documented project and workspace permission cascades", async () => {
    expect((await request(`/api/v2/organizations/${orgName}/projects`, tokens.readProjects)).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}`, tokens.readProjects)).status).toBe(200);
    expect((await request(`/api/v2/organizations/${orgName}/varsets`, tokens.readWorkspaces)).status).toBe(200);
    expect((await request(
      `/api/v2/organizations/${orgName}/projects`,
      tokens.readProjects,
      "POST",
      resource("projects", { name: `read-only-${suffix}` }),
    )).status).toBe(404);

    const project = await request(
      `/api/v2/organizations/${orgName}/projects`,
      tokens.manageProjects,
      "POST",
      resource("projects", { name: `managed-project-${suffix}` }),
    );
    expect(project.status).toBe(201);
    expect((await request(
      `/api/v2/organizations/${orgName}/workspaces`,
      tokens.manageProjects,
      "POST",
      resource("workspaces", { name: `project-managed-workspace-${suffix}` }),
    )).status).toBe(201);
    expect((await request(
      `/api/v2/organizations/${orgName}/workspaces`,
      tokens.manageWorkspaces,
      "POST",
      resource("workspaces", { name: `workspace-managed-${suffix}` }),
    )).status).toBe(201);
    expect((await request(
      `/api/v2/organizations/${orgName}/varsets`,
      tokens.manageWorkspaces,
      "POST",
      resource("varsets", { name: `workspace-managed-varset-${suffix}` }),
    )).status).toBe(201);
    expect((await request(
      `/api/v2/organizations/${orgName}/varsets`,
      tokens.manageProjects,
      "POST",
      resource("varsets", { name: `project-managed-varset-${suffix}` }),
    )).status).toBe(201);
    expect((await request(
      "/api/v2/vars",
      tokens.manageWorkspaces,
      "POST",
      workspaceVariable(`managed-variable-${suffix}`),
    )).status).toBe(201);
    expect((await request(
      `/api/v2/workspaces/${workspaceId}/relationships/run-triggers`,
      tokens.manageWorkspaces,
      "POST",
      { data: [] },
    )).status).toBe(204);
    expect((await request(`/api/v2/projects/${projectId}`, tokens.manageWorkspaces)).status).toBe(404);

    expect((await request(`/api/v2/projects/${projectId}`, tokens.agentPools)).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}`, tokens.agentPools)).status).toBe(200);
  });

  it("separates VCS, policy, run-task, and policy-override authority", async () => {
    const sshKey = await request(
      `/api/v2/organizations/${orgName}/ssh-keys`,
      tokens.vcs,
      "POST",
      resource("ssh-keys", { name: `managed-key-${suffix}`, value: "private-key" }),
    );
    expect(sshKey.status).toBe(201);
    expect((await request(
      `/api/v2/organizations/${orgName}/oauth-clients`,
      tokens.vcs,
      "POST",
      resource("oauth-clients", { name: `managed-vcs-${suffix}`, "service-provider": "github" }),
    )).status).toBe(201);

    const policySet = await request(
      `/api/v2/organizations/${orgName}/policy-sets`,
      tokens.policies,
      "POST",
      resource("policy-sets", { name: `managed-policies-${suffix}` }),
    );
    expect(policySet.status).toBe(201);
    expect((await request(`/api/v2/workspaces/${otherWorkspaceId}/policy-sets`, tokens.policies)).status).toBe(200);
    expect((await request(
      `/api/v2/policy-checks/${checkIds.global}/actions/override`,
      tokens.policies,
      "POST",
    )).status).toBe(404);

    const runTask = await request(
      `/api/v2/organizations/${orgName}/run-tasks`,
      tokens.runTasks,
      "POST",
      resource("run-tasks", { name: `managed-task-${suffix}`, url: "https://example.test/run-task" }),
    );
    expect(runTask.status).toBe(201);

    expect((await request(
      `/api/v2/policy-checks/${checkIds.global}/actions/override`,
      tokens.overrides,
      "POST",
    )).status).toBe(200);
    expect((await request(
      `/api/v2/policy-checks/${checkIds.direct}/actions/override`,
      tokens.none,
      "POST",
    )).status).toBe(404);
    expect((await request(
      `/api/v2/policy-checks/${checkIds.direct}/actions/override`,
      tokens.delegateOverrides,
      "POST",
    )).status).toBe(200);
    expect((await request(
      `/api/v2/policy-checks/${checkIds.unassigned}/actions/override`,
      tokens.delegateOverrides,
      "POST",
    )).status).toBe(404);
  });

  it("covers agent-pool and registry permissions and preserves privileged principals", async () => {
    expect((await request(
      `/api/v2/organizations/${orgName}/agent-pools`,
      tokens.agentPools,
    )).status).toBe(200);
    expect((await request(
      `/api/v2/organizations/${orgName}/agent-pools`,
      tokens.agentPools,
      "POST",
      resource("agent-pools", { name: `managed-pool-${suffix}` }),
    )).status).toBe(201);
    expect((await request(
      `/api/v2/organizations/${orgName}/registry-providers`,
      tokens.providers,
      "POST",
      resource("registry-providers", { name: `managed-provider-${suffix}`, namespace: orgName }),
    )).status).toBe(201);
    expect((await request(
      `/api/v2/organizations/${orgName}/registry-modules`,
      tokens.modules,
      "POST",
      resource("registry-modules", { name: `managed-module-${suffix}`, provider: "aws", namespace: orgName }),
    )).status).toBe(201);

    expect((await request(
      `/api/v2/organizations/${orgName}/run-tasks`,
      ownerToken,
      "POST",
      resource("run-tasks", { name: `owner-task-${suffix}`, url: "https://example.test/owner-task" }),
    )).status).toBe(201);
    expect((await request(
      `/api/v2/organizations/${orgName}/projects`,
      organizationToken,
      "POST",
      resource("projects", { name: `organization-project-${suffix}` }),
    )).status).toBe(201);
  });
});
