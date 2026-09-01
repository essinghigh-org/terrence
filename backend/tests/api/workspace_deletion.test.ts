import { afterAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  organizationMemberships,
  organizations,
  runs,
  stackStateLocks,
  stacks,
  workloadIdentityTokens,
  workspaces,
} from "../../src/db/schema";
import { deleteOrganization, deleteWorkspace } from "../../src/lib/utils";

describe("workspace and organization deletion", () => {
  const suffix = crypto.randomUUID();
  const workspaceOrgId = `delete-workspace-org-${suffix}`;
  const workspaceId = `delete-workspace-${suffix}`;
  const workspaceRunId = `delete-workspace-run-${suffix}`;
  const workspaceStackId = `delete-workspace-stack-${suffix}`;
  const workspaceLockId = `delete-workspace-lock-${suffix}`;
  const workspaceTokenId = `delete-workspace-token-${suffix}`;
  const organizationOrgId = `delete-organization-org-${suffix}`;
  const organizationWorkspaceIds = [
    `delete-organization-workspace-a-${suffix}`,
    `delete-organization-workspace-b-${suffix}`,
  ] as const;
  const organizationRunIds = [
    `delete-organization-run-a-${suffix}`,
    `delete-organization-run-b-${suffix}`,
  ] as const;
  const organizationStackId = `delete-organization-stack-${suffix}`;
  const organizationLockId = `delete-organization-lock-${suffix}`;
  const organizationTokenId = `delete-organization-token-${suffix}`;

  afterAll(async () => {
    await db.delete(stackStateLocks).where(eq(stackStateLocks.stackId, workspaceStackId));
    await db.delete(stackStateLocks).where(eq(stackStateLocks.stackId, organizationStackId));
    await db.delete(workloadIdentityTokens).where(eq(workloadIdentityTokens.jti, workspaceTokenId));
    await db.delete(workloadIdentityTokens).where(eq(workloadIdentityTokens.jti, organizationTokenId));
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(runs).where(eq(runs.workspaceId, organizationWorkspaceIds[0]));
    await db.delete(runs).where(eq(runs.workspaceId, organizationWorkspaceIds[1]));
    await db.delete(stacks).where(eq(stacks.id, workspaceStackId));
    await db.delete(stacks).where(eq(stacks.id, organizationStackId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, organizationWorkspaceIds[0]));
    await db.delete(workspaces).where(eq(workspaces.id, organizationWorkspaceIds[1]));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, workspaceOrgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, organizationOrgId));
    await db.delete(organizations).where(eq(organizations.id, workspaceOrgId));
    await db.delete(organizations).where(eq(organizations.id, organizationOrgId));
  });

  it("deletes run-linked workload tokens and stack locks with a workspace", async () => {
    await db.insert(organizations).values({ id: workspaceOrgId, name: workspaceOrgId });
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId: workspaceOrgId });
    await db.insert(runs).values({ id: workspaceRunId, workspaceId, status: "applied", createdAt: Date.now() });
    await db.insert(stacks).values({ id: workspaceStackId, orgId: workspaceOrgId, name: workspaceStackId });
    await db.insert(stackStateLocks).values({
      id: workspaceLockId,
      stackId: workspaceStackId,
      deployment: workspaceId,
      runId: workspaceRunId,
    });
    await db.insert(workloadIdentityTokens).values({
      jti: workspaceTokenId,
      runId: workspaceRunId,
      keyId: "test-key",
      audience: "test-audience",
      subject: workspaceId,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    await deleteWorkspace(workspaceId);

    expect(await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })).toBeUndefined();
    expect(await db.query.runs.findFirst({ where: eq(runs.id, workspaceRunId) })).toBeUndefined();
    expect(await db.query.workloadIdentityTokens.findFirst({ where: eq(workloadIdentityTokens.jti, workspaceTokenId) })).toBeUndefined();
    expect(await db.query.stackStateLocks.findFirst({ where: eq(stackStateLocks.id, workspaceLockId) })).toBeUndefined();
  });

  it("deletes every workspace's run-linked records during organization deletion", async () => {
    await db.insert(organizations).values({ id: organizationOrgId, name: organizationOrgId });
    await db.insert(workspaces).values(organizationWorkspaceIds.map((id) => ({ id, name: id, orgId: organizationOrgId })));
    await db.insert(runs).values(organizationRunIds.map((id, index) => ({
      id,
      workspaceId: organizationWorkspaceIds[index]!,
      status: "applied",
      createdAt: Date.now() + index,
    })));
    await db.insert(stacks).values({ id: organizationStackId, orgId: organizationOrgId, name: organizationStackId });
    await db.insert(stackStateLocks).values({
      id: organizationLockId,
      stackId: organizationStackId,
      deployment: organizationWorkspaceIds[0],
      runId: organizationRunIds[0],
    });
    await db.insert(workloadIdentityTokens).values({
      jti: organizationTokenId,
      runId: organizationRunIds[1],
      keyId: "test-key",
      audience: "test-audience",
      subject: organizationWorkspaceIds[1],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    expect(await deleteOrganization(organizationOrgId)).toEqual([]);

    expect(await db.query.organizations.findFirst({ where: eq(organizations.id, organizationOrgId) })).toBeUndefined();
    for (const workspaceId of organizationWorkspaceIds) {
      expect(await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })).toBeUndefined();
    }
    for (const runId of organizationRunIds) {
      expect(await db.query.runs.findFirst({ where: eq(runs.id, runId) })).toBeUndefined();
    }
    expect(await db.query.workloadIdentityTokens.findFirst({ where: eq(workloadIdentityTokens.jti, organizationTokenId) })).toBeUndefined();
    expect(await db.query.stackStateLocks.findFirst({ where: eq(stackStateLocks.id, organizationLockId) })).toBeUndefined();
  });
});
