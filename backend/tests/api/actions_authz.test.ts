import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";

import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  actions,
  actionInvocations,
  apiTokens,
  organizationMemberships,
  organizations,
  users,
  workspaces,
} from "../../src/db/schema";

// The /api/v2/actions surface previously served list/detail/output/invocation
// reads to UNAUTHENTICATED callers and leaked cross-org rows. These tests pin
// the corrected authorization:
//   - every route 401s without credentials
//   - org-scoped reads are limited to the caller's own organizations
describe("actions api authorization", () => {
  const suffix = crypto.randomUUID();
  const userId = `act-user-${suffix}`;
  const otherUserId = `act-other-${suffix}`;
  const orgId = `act-org-${suffix}`;
  const otherOrgId = `act-other-org-${suffix}`;
  const workspaceId = `act-ws-${suffix}`;
  const userToken = `act-tok-user-${suffix}`;
  const outsiderToken = `act-tok-out-${suffix}`;
  const actionId = `action-${suffix}`;
  const invocationId = `actinv-${suffix}`;

  const request = (path: string, token?: string): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: token !== undefined ? { Authorization: `Bearer ${token}` } : {},
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, username: `act-u-${suffix}@test`, passwordHash: "unused" },
      { id: otherUserId, username: `act-o-${suffix}@test`, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: `act-org-${suffix}` },
      { id: otherOrgId, name: `act-other-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values([
      { id: `act-mem-${suffix}`, userId, orgId, role: "owner" },
      { id: `act-mem2-${suffix}`, userId: otherUserId, orgId: otherOrgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([
      { id: `act-t1-${suffix}`, token: hashAuthenticationToken(userToken), userId },
      { id: `act-t2-${suffix}`, token: hashAuthenticationToken(outsiderToken), userId: otherUserId },
    ]);
    await db.insert(workspaces).values({ id: workspaceId, name: `act-ws-${suffix}`, orgId });
    await db.insert(actions).values({
      id: actionId,
      orgId,
      name: "probe-action",
      actionType: "custom",
      status: "active",
      configuration: { command: "echo hi" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.insert(actionInvocations).values({
      id: invocationId,
      actionId,
      orgId,
      status: "pending",
      output: { result: "secret-output" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  afterAll(async () => {
    await db.delete(actionInvocations).where(eq(actionInvocations.actionId, actionId));
    await db.delete(actions).where(eq(actions.id, actionId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, otherOrgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, userToken));
    await db.delete(apiTokens).where(eq(apiTokens.token, outsiderToken));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  it("401s an unauthenticated list of all actions", async () => {
    const res = await request("/api/v2/actions");
    expect(res.status).toBe(401);
  });

  it("401s an unauthenticated read of a single action", async () => {
    const res = await request(`/api/v2/actions/${actionId}`);
    expect(res.status).toBe(401);
  });

  it("401s an unauthenticated read of action output", async () => {
    const res = await request(`/api/v2/actions/${actionId}/output`);
    expect(res.status).toBe(401);
  });

  it("401s an unauthenticated read of run action invocations", async () => {
    const res = await request(`/api/v2/runs/run-xyz/actions`);
    expect(res.status).toBe(401);
  });

  it("401s an unauthenticated read of stack action invocations", async () => {
    const res = await request(`/api/v2/stacks/stack-xyz/actions`);
    expect(res.status).toBe(401);
  });

  it("hides other organizations' actions from an unscoped listing", async () => {
    // The caller (userId) only belongs to orgId; the fixture has no actions
    // in other orgs, but the response must not include them either way.
    const res = await request("/api/v2/actions", userToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string }[] };
    expect(body.data.some((row): boolean => row.id === actionId)).toBeTrue();

    // A user from another organization must not see this org's action.
    const res2 = await request("/api/v2/actions", outsiderToken);
    const body2 = await res2.json() as { data: { id: string }[] };
    expect(body2.data.some((row): boolean => row.id === actionId)).toBeFalse();
  });

  it("404s a single-action read from a non-member", async () => {
    const res = await request(`/api/v2/actions/${actionId}`, outsiderToken);
    expect(res.status).toBe(404);
  });

  it("200s a single-action read for a member of the owning org", async () => {
    const res = await request(`/api/v2/actions/${actionId}`, userToken);
    expect(res.status).toBe(200);
  });
});