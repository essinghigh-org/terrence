import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  configurationVersions,
  dataRetentionPolicies,
  logs,
  organizationDataRetentionPolicies,
  organizationMemberships,
  organizations,
  runs,
  stateVersions,
  users,
  workspaces,
} from "../../src/db/schema";
import { applyDataRetentionGarbageCollection } from "../../src/lib/utils";
import { deleteRunLogArchive, runLogArchivePath } from "../../src/lib/run-logs";

describe("State storage and retention", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-storage-${suffix}`;
  const tokenId = `token-storage-${suffix}`;
  const token = `storage-${suffix}`;
  const orgId = `org-storage-${suffix}`;
  const workspaceId = `ws-storage-${suffix}`;
  const membershipId = `membership-storage-${suffix}`;
  const oldConfigurationVersionId = `cv-old-${suffix}`;
  const currentConfigurationVersionId = `cv-current-${suffix}`;
  const oldRunId = `run-old-${suffix}`;
  const activeRunId = `run-active-${suffix}`;
  const now = Date.now();
  let temporaryDirectory = "";

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/vnd.api+json",
  };

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "terrence-retention-"));
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(organizationMemberships).values({
      id: membershipId,
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({ id: tokenId, token, userId });
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId, locked: false });
  });

  afterAll(async () => {
    await db.delete(logs).where(eq(logs.runId, oldRunId));
    await db.delete(logs).where(eq(logs.runId, activeRunId));
    await deleteRunLogArchive(oldRunId);
    await deleteRunLogArchive(activeRunId);
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
    await db.delete(dataRetentionPolicies).where(eq(dataRetentionPolicies.workspaceId, workspaceId));
    await db.delete(organizationDataRetentionPolicies).where(eq(organizationDataRetentionPolicies.organizationId, orgId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, membershipId));
    await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  test("promotes the latest intermediate snapshot when the workspace unlocks", async () => {
    const createState = (serial: number, intermediate = false) => app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "state-versions",
            attributes: {
              serial,
              intermediate,
              state: Buffer.from(JSON.stringify({ version: 4, serial, resources: [] })).toString("base64"),
            },
          },
        }),
      }),
    );

    expect((await createState(1)).status).toBe(201);
    expect((await app.handle(new Request(
      `http://localhost/api/v2/workspaces/${workspaceId}/actions/lock`,
      { method: "POST", headers: authHeaders },
    ))).status).toBe(200);
    // Non-intermediate uploads are allowed while locked (the reference format semantics);
    // the intermediate snapshot is still the one that gets promoted.
    const snapshotResponse = await createState(2, true);
    expect(snapshotResponse.status).toBe(201);
    expect((await snapshotResponse.json()).data.attributes.intermediate).toBe(true);

    const currentBeforeUnlock = await app.handle(new Request(
      `http://localhost/api/v2/workspaces/${workspaceId}/current-state-version`,
      { headers: authHeaders },
    ));
    expect((await currentBeforeUnlock.json()).data.attributes.serial).toBe(1);

    expect((await app.handle(new Request(
      `http://localhost/api/v2/workspaces/${workspaceId}/actions/unlock`,
      { method: "POST", headers: authHeaders },
    ))).status).toBe(200);

    const currentAfterUnlock = await app.handle(new Request(
      `http://localhost/api/v2/workspaces/${workspaceId}/current-state-version`,
      { headers: authHeaders },
    ));
    const current = (await currentAfterUnlock.json()).data;
    expect(current.attributes.serial).toBe(2);
    expect(current.attributes.intermediate).toBe(false);
  });

  test("inherits an organization retention policy when no workspace override exists", async () => {
    const oldState = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, workspaceId),
      orderBy: [stateVersions.serial],
    });
    expect(oldState).toBeDefined();
    await db.update(stateVersions)
      .set({ createdAt: now - 2 * 86_400_000 })
      .where(eq(stateVersions.id, oldState!.id));

    const createPolicyResponse = await app.handle(new Request(
      `http://localhost/api/v2/organizations/${orgId}/relationships/data-retention-policy`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "data-retention-policy-delete-olders",
            attributes: { "delete-older-than-n-days": 1 },
          },
        }),
      },
    ));
    expect(createPolicyResponse.status).toBe(201);
    const createdPolicy = (await createPolicyResponse.json()).data;
    expect(createdPolicy.meta.gc[workspaceId]).toMatchObject({
      softDeleted: 1,
      policySource: "organization",
    });

    const getPolicyResponse = await app.handle(new Request(
      `http://localhost/api/v2/organizations/${orgId}/relationships/data-retention-policy`,
      { headers: authHeaders },
    ));
    expect(getPolicyResponse.status).toBe(200);
    expect((await getPolicyResponse.json()).data.attributes["delete-older-than-n-days"]).toBe(1);

    expect((await app.handle(new Request(
      `http://localhost/api/v2/state-versions/${oldState!.id}/actions/restore_backing_data`,
      { method: "POST", headers: authHeaders },
    ))).status).toBe(200);
    expect((await app.handle(new Request(
      `http://localhost/api/v2/organizations/${orgId}/relationships/data-retention-policy`,
      { method: "DELETE", headers: authHeaders },
    ))).status).toBe(204);
  });

  test("ages configuration archives and completed-run logs through GC", async () => {
    const oldArchivePath = join(temporaryDirectory, `${oldConfigurationVersionId}.tar.gz`);
    const currentArchivePath = join(temporaryDirectory, `${currentConfigurationVersionId}.tar.gz`);
    await writeFile(oldArchivePath, "old configuration");
    await writeFile(currentArchivePath, "current configuration");

    await db.insert(configurationVersions).values([
      {
        id: oldConfigurationVersionId,
        workspaceId,
        status: "uploaded",
        archivePath: oldArchivePath,
        createdAt: now - 2 * 86_400_000,
      },
      {
        id: currentConfigurationVersionId,
        workspaceId,
        status: "uploaded",
        archivePath: currentArchivePath,
        createdAt: now,
      },
    ]);
    await db.insert(runs).values([
      {
        id: oldRunId,
        workspaceId,
        status: "applied",
        createdAt: now - 2 * 86_400_000,
      },
      {
        id: activeRunId,
        workspaceId,
        status: "planning",
        createdAt: now - 2 * 86_400_000,
      },
    ]);
    await db.insert(logs).values([
      { id: `log-old-${suffix}`, runId: oldRunId, phase: "apply", outputText: "old", createdAt: now },
      { id: `log-active-${suffix}`, runId: activeRunId, phase: "plan", outputText: "active", createdAt: now },
    ]);
    await db.insert(dataRetentionPolicies).values({
      id: `policy-${suffix}`,
      workspaceId,
      deleteOlderThanNDays: 1,
    });

    const firstPass = await applyDataRetentionGarbageCollection(workspaceId, { now });
    expect(firstPass).toMatchObject({
      configurationVersions: { softDeleted: 1, permanentlyDeleted: 0, archivesDeleted: 0 },
      runs: { softDeleted: 1, permanentlyDeleted: 0, archivesDeleted: 0 },
      logsDeleted: 1,
      logsArchived: 1,
    });
    expect(await Bun.file(oldArchivePath).exists()).toBe(true);
    expect(await Bun.file(runLogArchivePath(oldRunId)).exists()).toBe(true);
    expect((await db.query.runs.findFirst({ where: eq(runs.id, oldRunId) }))?.softDeletedAt).toBe(now);
    expect(await db.query.logs.findFirst({ where: eq(logs.runId, oldRunId) })).toBeUndefined();
    expect(await db.query.logs.findFirst({ where: eq(logs.runId, activeRunId) })).toBeDefined();
    const archivedLogResponse = await app.handle(new Request(
      `http://localhost/api/v2/runs/${oldRunId}/apply/log`,
      { headers: authHeaders },
    ));
    expect(archivedLogResponse.status).toBe(200);
    expect(await archivedLogResponse.text()).toBe("old");

    const restoreResponse = await app.handle(new Request(
      `http://localhost/api/v2/configuration-versions/${oldConfigurationVersionId}/actions/restore_backing_data`,
      { method: "POST", headers: authHeaders },
    ));
    expect(restoreResponse.status).toBe(200);
    expect((await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, oldConfigurationVersionId),
    }))?.status).toBe("uploaded");
    expect(await applyDataRetentionGarbageCollection(workspaceId, { now })).toMatchObject({
      configurationVersions: { softDeleted: 1 },
    });

    await db.update(configurationVersions)
      .set({ softDeletedAt: now - 8 * 86_400_000 })
      .where(eq(configurationVersions.id, oldConfigurationVersionId));
    await db.update(runs)
      .set({ softDeletedAt: now - 8 * 86_400_000 })
      .where(eq(runs.id, oldRunId));
    const secondPass = await applyDataRetentionGarbageCollection(workspaceId, { now });
    expect(secondPass).toMatchObject({
      configurationVersions: { permanentlyDeleted: 1, archivesDeleted: 1 },
      runs: { permanentlyDeleted: 1, archivesDeleted: 1 },
    });
    expect(await Bun.file(oldArchivePath).exists()).toBe(false);
    expect((await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, oldConfigurationVersionId),
    }))?.status).toBe("backing_data_permanently_deleted");
    expect(await Bun.file(currentArchivePath).exists()).toBe(true);
    expect(await Bun.file(runLogArchivePath(oldRunId)).exists()).toBe(false);
    expect(await db.query.runs.findFirst({ where: eq(runs.id, oldRunId) })).toBeUndefined();
  });

  test("removes configuration archives when an organization is deleted", async () => {
    const deletedOrganizationId = `org-delete-${suffix}`;
    const deletedOrganizationName = `org-delete-${suffix}`;
    const deletedWorkspaceId = `ws-delete-${suffix}`;
    const deletedArchivePath = join(temporaryDirectory, `cv-delete-${suffix}.tar.gz`);
    await writeFile(deletedArchivePath, "delete me");
    await db.insert(organizations).values({ id: deletedOrganizationId, name: deletedOrganizationName });
    await db.insert(organizationMemberships).values({
      id: `membership-delete-${suffix}`,
      userId,
      orgId: deletedOrganizationId,
      role: "owner",
    });
    await db.insert(workspaces).values({
      id: deletedWorkspaceId,
      name: deletedWorkspaceId,
      orgId: deletedOrganizationId,
    });
    await db.insert(configurationVersions).values({
      id: `cv-delete-${suffix}`,
      workspaceId: deletedWorkspaceId,
      status: "uploaded",
      archivePath: deletedArchivePath,
    });

    const response = await app.handle(new Request(
      `http://localhost/api/v2/organizations/${deletedOrganizationName}`,
      { method: "DELETE", headers: authHeaders },
    ));
    expect(response.status).toBe(204);
    expect(await Bun.file(deletedArchivePath).exists()).toBe(false);
    expect(await db.query.organizations.findFirst({
      where: eq(organizations.id, deletedOrganizationId),
    })).toBeUndefined();
  });
});
