import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiIdempotencyKeys,
  apiTokens,
  configurationVersions,
  organizationMemberships,
  organizations,
  stateVersions,
  users,
  workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

describe("remote write idempotency contract", () => {
  const suffix = crypto.randomUUID();
  const workspaceId = `ws-idempotency-${suffix}`;
  const orgId = `org-idempotency-${suffix}`;
  const ownerId = `user-idempotency-${suffix}`;
  const otherId = `user-idempotency-other-${suffix}`;
  const ownerToken = `token-idempotency-${suffix}`;
  const otherToken = `token-idempotency-other-${suffix}`;
  const ownerMembershipId = `membership-idempotency-${suffix}`;
  const otherMembershipId = `membership-idempotency-other-${suffix}`;
  const key = `create-cv-${suffix}`;

  const request = (token: string, body: Record<string, unknown>, idempotencyKey = key): Promise<Response> => app.handle(new Request(
    `http://terrence.test/api/v2/workspaces/${workspaceId}/configuration-versions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.api+json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  ));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerId, username: `idempotency-owner-${suffix}`, passwordHash: "unused" },
      { id: otherId, username: `idempotency-other-${suffix}`, passwordHash: "unused" },
    ]);
    await db.insert(apiTokens).values([
      { id: `token-row-owner-${suffix}`, token: hashAuthenticationToken(ownerToken), userId: ownerId },
      { id: `token-row-other-${suffix}`, token: hashAuthenticationToken(otherToken), userId: otherId },
    ]);
    await db.insert(organizations).values({ id: orgId, name: `idempotency-${suffix}` });
    await db.insert(organizationMemberships).values([
      { id: ownerMembershipId, userId: ownerId, orgId, role: "owner", status: "active" },
      { id: otherMembershipId, userId: otherId, orgId, role: "owner", status: "active" },
    ]);
    await db.insert(workspaces).values({ id: workspaceId, name: `idempotency-${suffix}`, orgId });
    const lock = await app.handle(new Request(`http://terrence.test/api/v2/workspaces/${workspaceId}/actions/lock`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    }));
    expect(lock.status).toBe(200);
  });

  afterAll(async () => {
    await db.delete(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.scope, `configuration-versions:${workspaceId}`));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(organizationMemberships).where(and(eq(organizationMemberships.orgId, orgId), eq(organizationMemberships.id, ownerMembershipId)));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, otherMembershipId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, ownerId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, otherId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, otherId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("replays one committed configuration version and marks the replay", async () => {
    const body = { data: { type: "configuration-versions", attributes: { source: "tfe-api" } } };
    const first = await request(ownerToken, body);
    const replay = await request(ownerToken, body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const firstBody = await first.json() as { data: { id: string } };
    const replayBody = await replay.json() as { data: { id: string } };
    expect(replayBody.data.id).toBe(firstBody.data.id);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await db.query.configurationVersions.findMany({ where: eq(configurationVersions.workspaceId, workspaceId) })).toHaveLength(1);
  });

  test("rejects a changed body and a different principal for the same key", async () => {
    const changed = await request(ownerToken, { data: { type: "configuration-versions", attributes: { source: "github" } } });
    expect(changed.status).toBe(409);
    expect((await changed.json() as { errors: [{ detail: string }] }).errors[0].detail).toContain("different principal");

    const differentPrincipal = await request(otherToken, { data: { type: "configuration-versions", attributes: { source: "tfe-api" } } });
    expect(differentPrincipal.status).toBe(409);
    expect((await differentPrincipal.json() as { errors: [{ detail: string }] }).errors[0].detail).toContain("different principal");
  });

  test("canonical request hashing ignores JSON object key order", async () => {
    const bodyA = { data: { type: "configuration-versions", attributes: { source: "tfe-api", speculative: false } } };
    const bodyB = { data: { attributes: { speculative: false, source: "tfe-api" }, type: "configuration-versions" } };
    const canonicalKey = `canonical-${suffix}`;
    const first = await request(ownerToken, bodyA, canonicalKey);
    const replay = await request(ownerToken, bodyB, canonicalKey);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect((await replay.json() as { data: { id: string } }).data.id).toBe((await first.json() as { data: { id: string } }).data.id);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  });

  test("replays an inline state version without reserving a second serial", async () => {
    const state = JSON.stringify({ version: 4, serial: 1, lineage: `lineage-${suffix}`, resources: [] });
    const body = {
      data: {
        type: "state-versions",
        attributes: { serial: 1, state, md5: createMd5(state) },
      },
    };
    const makeRequest = (): Promise<Response> => app.handle(new Request(
      `http://terrence.test/api/v2/workspaces/${workspaceId}/state-versions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/vnd.api+json",
          "Idempotency-Key": `state-${suffix}`,
        },
        body: JSON.stringify(body),
      },
    ));
    const first = await makeRequest();
    const replay = await makeRequest();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect((await replay.json() as { data: { id: string } }).data.id).toBe((await first.json() as { data: { id: string } }).data.id);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId) })).toHaveLength(1);
  });

  test("replays a raw state import after the serial has advanced", async () => {
    const rawState = JSON.stringify({ version: 4, serial: 2, lineage: `lineage-${suffix}`, resources: [] });
    const makeRequest = (): Promise<Response> => app.handle(new Request(
      `http://terrence.test/api/v2/workspaces/${workspaceId}/state-versions/upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `raw-state-${suffix}`,
        },
        body: rawState,
      },
    ));
    const first = await makeRequest();
    const replay = await makeRequest();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect((await replay.json() as { data: { id: string } }).data.id).toBe((await first.json() as { data: { id: string } }).data.id);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId) })).toHaveLength(2);
  });
});

function createMd5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}
