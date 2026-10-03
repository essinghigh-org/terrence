import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, controlPlaneNodes, durableJobs, users } from "../../src/db/schema";
import { BACKUP_REHEARSAL_RECORD_KIND } from "../../src/lib/backup-rehearsal-jobs";
import { hashAuthenticationToken } from "../../src/lib/token-service";

describe("admin backup verification API", () => {
  const suffix = crypto.randomUUID();
  const adminId = `backup-admin-${suffix}`;
  const memberId = `backup-member-${suffix}`;
  const adminToken = `backup-admin-token-${suffix}`;
  const memberToken = `backup-member-token-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: memberId, username: memberId, passwordHash: "unused", isSiteAdmin: false },
    ]);
    await db.insert(apiTokens).values([
      { id: `backup-at-${suffix}`, userId: adminId, token: hashAuthenticationToken(adminToken) },
      { id: `backup-mt-${suffix}`, userId: memberId, token: hashAuthenticationToken(memberToken) },
    ]);
  });

  afterAll(async () => {
    await db.delete(durableJobs).where(eq(durableJobs.kind, BACKUP_REHEARSAL_RECORD_KIND));
    await db.delete(controlPlaneNodes).where(eq(controlPlaneNodes.id, `backup-remote-node-${suffix}`));
    await db.delete(apiTokens).where(inArray(apiTokens.userId, [adminId, memberId]));
    await db.delete(users).where(inArray(users.id, [adminId, memberId]));
  });

  const request = (path: string, token = adminToken, method = "GET", body?: unknown): Promise<Response> =>
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

  test("creates an admin-only manifest without exposing key values and reports restore state", async () => {
    expect((await request("/api/v2/admin/backups/status", memberToken)).status).toBe(404);
    const created = await request("/api/v2/admin/backups/manifests", adminToken, "POST", {
      data: { attributes: { persist: false } },
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      data: {
        attributes: {
          manifest: { version: number; manifestSha256: string; keys: unknown };
          "manifest-path": string | null;
        };
      };
    };
    expect(body.data.attributes.manifest.version).toBe(1);
    expect(body.data.attributes.manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain(process.env["ENCRYPTION_PASSWORD"] ?? "definitely-not-a-password");
    expect(body.data.attributes["manifest-path"]).toBeNull();

    const status = await request("/api/v2/admin/backups/status");
    expect(status.status).toBe(200);
    expect((await status.json()).data.attributes["last-verified-restore-at"]).toBeNull();
  });

  test("does not expose a live restore endpoint and validates rehearsal input", async () => {
    expect(
      (await request("/api/v2/admin/backups/restore", adminToken, "POST", { data: { attributes: {} } })).status,
    ).toBe(404);
    const response = await request("/api/v2/admin/backups/restore-rehearsals", adminToken, "POST", {
      data: { attributes: {} },
    });
    expect(response.status).toBe(422);
  });

  test("shares rehearsal status and singleton admission across replicas, then exposes owner interruption", async () => {
    const now = Date.now();
    const remoteNodeId = `backup-remote-node-${suffix}`;
    const remoteInstanceId = `backup-remote-instance-${suffix}`;
    const rehearsalId = `backup-rehearsal-${suffix}`;
    await db.insert(controlPlaneNodes).values({
      id: remoteNodeId,
      hostname: remoteNodeId,
      instanceId: remoteInstanceId,
      status: "active",
      registeredAt: now,
      lastHeartbeatAt: now,
    });
    await db.insert(durableJobs).values({
      id: rehearsalId,
      kind: BACKUP_REHEARSAL_RECORD_KIND,
      dedupeKey: "active",
      status: "running",
      payload: {
        ownerNodeId: remoteNodeId,
        ownerInstanceId: remoteInstanceId,
        startedAt: new Date(now).toISOString(),
        source: { sourcePath: "/shared/backups/rehearsal.tar" },
      },
      payloadSchemaVersion: 1,
      attempts: 0,
      runAfter: now,
      lockedBy: remoteInstanceId,
      heartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // This request represents a poll landing on another API replica: status is
    // resolved entirely from the shared durable record, not process memory.
    const remotePoll = await request(`/api/v2/admin/backups/restore-rehearsals/${rehearsalId}`);
    expect(remotePoll.status).toBe(200);
    expect((await remotePoll.json()).data.attributes.status).toBe("running");

    const concurrent = await request("/api/v2/admin/backups/restore-rehearsals", adminToken, "POST", {
      data: { attributes: { "backup-path": "/another/shared/backup.tar" } },
    });
    expect(concurrent.status).toBe(409);

    // Once the owning replica is outside the cluster heartbeat window, any
    // replica converts the row to an explicit interrupted terminal state and
    // releases the singleton key for a new rehearsal.
    await db.update(controlPlaneNodes).set({ lastHeartbeatAt: 0 }).where(eq(controlPlaneNodes.id, remoteNodeId));
    const interrupted = await request(`/api/v2/admin/backups/restore-rehearsals/${rehearsalId}`);
    expect(interrupted.status).toBe(200);
    const interruptedBody = await interrupted.json();
    expect(interruptedBody.data.attributes.status).toBe("interrupted");
    expect(interruptedBody.data.attributes.error.code).toBe("owner-interrupted");

    const retry = await request("/api/v2/admin/backups/restore-rehearsals", adminToken, "POST", {
      data: { attributes: { "backup-path": "/definitely/missing/backup.tar" } },
    });
    expect(retry.status).toBe(202);
  });
});
