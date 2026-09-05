import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  agentJobs, agentPools, agents, apiTokens, organizationMemberships, organizations, runs, users, workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";

// Issue #568: lock metadata (owner, reason, age) must reach the UI, and
// unlock failures must carry the server reason. Non-owners get a 403 with
// "Only the lock owner can unlock this workspace"; admins recover via
// force-unlock. lockedAt is set on lock and cleared on unlock/force-unlock.
describe("workspace lock metadata and force-unlock (#568)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const ownerId = `usr-lockmeta-a-${suffix}`;
  const otherId = `usr-lockmeta-b-${suffix}`;
  const orgId = `org-lockmeta-${suffix}`;
  const orgName = `lockmeta-${suffix}`;
  const ownerToken = `token-lockmeta-a-${suffix}`;
  const otherToken = `token-lockmeta-b-${suffix}`;
  const wsId = `ws-lockmeta-${suffix}`;

  const request = (token: string, path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const attributesOf = async (token: string): Promise<Record<string, unknown>> => {
    const res = await request(token, `/api/v2/workspaces/${wsId}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes;
  };

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerId, username: ownerId, passwordHash: "unused" },
      { id: otherId, username: otherId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values([
      { id: `mem-a-${suffix}`, userId: ownerId, orgId, role: "owner", status: "active" },
      { id: `mem-b-${suffix}`, userId: otherId, orgId, role: "owner", status: "active" },
    ]);
    await db.insert(apiTokens).values([
      { id: `tok-a-${suffix}`, token: hashAuthenticationToken(ownerToken), userId: ownerId },
      { id: `tok-b-${suffix}`, token: hashAuthenticationToken(otherToken), userId: otherId },
    ]);
    await db.insert(workspaces).values([
      { id: wsId, name: `lockmeta-ws-${suffix}`, orgId, executionMode: "remote" },
    ]);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, wsId)).catch((): void => {});
    await db.delete(apiTokens).where(eq(apiTokens.userId, ownerId)).catch((): void => {});
    await db.delete(apiTokens).where(eq(apiTokens.userId, otherId)).catch((): void => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId)).catch((): void => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch((): void => {});
    await db.delete(users).where(eq(users.id, ownerId)).catch((): void => {});
    await db.delete(users).where(eq(users.id, otherId)).catch((): void => {});
  });

  it("exposes lock owner, reason, and timestamp on lock", async () => {
    const before = Date.now();
    const lockRes = await request(ownerToken, `/api/v2/workspaces/${wsId}/actions/lock`, "POST", {
      data: { attributes: { reason: "deploy freeze" } },
    });
    expect(lockRes.status).toBe(200);
    // The action response itself carries the updated metadata, not the
    // pre-update row (CodeRabbit P1-sweep review).
    const lockAttrs = ((await lockRes.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(lockAttrs["locked"]).toBe(true);
    expect(lockAttrs["locked-reason"]).toBe("deploy freeze");
    expect(lockAttrs["locked-by-id"]).toBe(ownerId);
    expect(typeof lockAttrs["locked-at"]).toBe("string");
    const attrs = await attributesOf(ownerToken);
    expect(attrs["locked"]).toBe(true);
    expect(attrs["locked-reason"]).toBe("deploy freeze");
    expect(attrs["locked-by-type"]).toBe("user");
    expect(attrs["locked-by-id"]).toBe(ownerId);
    const lockedAt = attrs["locked-at"];
    expect(typeof lockedAt).toBe("string");
    const lockedAtMs = Date.parse(lockedAt as string);
    expect(Number.isNaN(lockedAtMs)).toBe(false);
    expect(lockedAtMs).toBeGreaterThanOrEqual(before);
    expect(lockedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it("rejects a non-owner unlock with the server reason", async () => {
    const res = await request(otherToken, `/api/v2/workspaces/${wsId}/actions/unlock`, "POST");
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { errors: { detail?: string }[] };
    expect(payload.errors[0]?.detail).toContain("Only the lock owner can unlock this workspace");
  });

  it("lets an admin force-unlock and clears the lock metadata", async () => {
    const res = await request(otherToken, `/api/v2/workspaces/${wsId}/actions/force-unlock`, "POST");
    expect(res.status).toBe(200);
    const resAttrs = ((await res.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(resAttrs["locked"]).toBe(false);
    expect(resAttrs["locked-at"]).toBeNull();
    const attrs = await attributesOf(ownerToken);
    expect(attrs["locked"]).toBe(false);
    expect(attrs["locked-at"]).toBeNull();
    expect(attrs["locked-by-type"]).toBeNull();
    expect(attrs["locked-by-id"]).toBeNull();
  });

  it("clears the lock timestamp on an owner unlock", async () => {
    const lockRes = await request(ownerToken, `/api/v2/workspaces/${wsId}/actions/lock`, "POST", {
      data: { attributes: { reason: "second freeze" } },
    });
    expect(lockRes.status).toBe(200);
    expect((await attributesOf(ownerToken))["locked-at"]).not.toBeNull();
    const unlockRes = await request(ownerToken, `/api/v2/workspaces/${wsId}/actions/unlock`, "POST");
    expect(unlockRes.status).toBe(200);
    const unlockAttrs = ((await unlockRes.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(unlockAttrs["locked"]).toBe(false);
    expect(unlockAttrs["locked-at"]).toBeNull();
    expect((await attributesOf(ownerToken))["locked-at"]).toBeNull();
  });

  it("422s force-unlock on a live-run lock without force, allows it with force (#617)", async () => {
    const runId = `run-live-${suffix}`;
    await db.insert(runs).values({ id: runId, workspaceId: wsId, status: "applying", createdAt: Date.now() });
    await db.update(workspaces).set({
      locked: true, lockedReason: "Run is applying", lockOwnerType: "agent-run", lockOwnerId: runId,
    }).where(eq(workspaces.id, wsId));

    const refused = await request(otherToken, `/api/v2/workspaces/${wsId}/actions/force-unlock`, "POST");
    expect(refused.status).toBe(422);
    const payload = (await refused.json()) as { errors: { detail?: string }[] };
    expect(payload.errors[0]?.detail).toContain(runId);

    const forced = await request(otherToken, `/api/v2/workspaces/${wsId}/actions/force-unlock`, "POST", {
      data: { attributes: { force: true } },
    });
    expect(forced.status).toBe(200);
    expect((await attributesOf(ownerToken))["locked"]).toBe(false);
    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("allows force-unlock on a terminal-run lock without force (#617)", async () => {
    const runId = `run-done-${suffix}`;
    await db.insert(runs).values({ id: runId, workspaceId: wsId, status: "applied", createdAt: Date.now() });
    await db.update(workspaces).set({
      locked: true, lockedReason: "stale lock", lockOwnerType: "run", lockOwnerId: runId,
    }).where(eq(workspaces.id, wsId));

    const res = await request(otherToken, `/api/v2/workspaces/${wsId}/actions/force-unlock`, "POST");
    expect(res.status).toBe(200);
    expect((await attributesOf(ownerToken))["locked"]).toBe(false);
    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("treats a force-canceled hold with a live agent as live (#617)", async () => {
    const runId = `run-held-${suffix}`;
    const now = Date.now();
    await db.insert(agentPools).values({ id: `pool-${suffix}`, orgId, name: `pool-${suffix}` });
    await db.insert(agents).values({ id: `agent-${suffix}`, agentPoolId: `pool-${suffix}`, name: `agent-${suffix}`, status: "busy", lastPingAt: now });
    await db.insert(runs).values({ id: runId, workspaceId: wsId, status: "force_canceled", createdAt: now });
    await db.insert(agentJobs).values({
      id: `job-${suffix}`, runId, agentPoolId: `pool-${suffix}`, agentId: `agent-${suffix}`,
      phase: "apply", status: "canceled", createdAt: now,
    });
    await db.update(workspaces).set({
      locked: true, lockedReason: "Run is applying", lockOwnerType: "agent-run", lockOwnerId: runId,
    }).where(eq(workspaces.id, wsId));

    const refused = await request(otherToken, `/api/v2/workspaces/${wsId}/actions/force-unlock`, "POST");
    expect(refused.status).toBe(422);

    const forced = await request(otherToken, `/api/v2/workspaces/${wsId}/actions/force-unlock`, "POST", {
      data: { attributes: { force: true } },
    });
    expect(forced.status).toBe(200);
    await db.delete(agentJobs).where(eq(agentJobs.id, `job-${suffix}`));
    await db.delete(agents).where(eq(agents.id, `agent-${suffix}`));
    await db.delete(agentPools).where(eq(agentPools.id, `pool-${suffix}`));
    await db.delete(runs).where(eq(runs.id, runId));
  });
});
