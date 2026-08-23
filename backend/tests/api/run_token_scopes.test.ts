import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  runs,
  runTokens,
  stateVersions,
  users,
  workspaces,
} from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { hashRunToken, mintRunToken, revokeRunTokens } from "../../src/lib/run-token";

// RUN-022: run-scoped token scopes / lifetime / revocation differential.
//
// A run token grants state access ONLY for its own workspace and is denied
// when (a) explicitly revoked, (b) past its 24h expiry, or (c) used against a
// different workspace. This pins each boundary directly against the auth path.

const STATE_A = JSON.stringify({ version: 4, terraform_version: "1.7.0", outputs: { a: { value: "a", type: "string" } } });
const STATE_B = JSON.stringify({ version: 4, terraform_version: "1.7.0", outputs: { b: { value: "b", type: "string" } } });

describe("run-scoped token scope/lifetime/revocation (RUN-022)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const username = `rtokowner-${suffix}`;
  const orgName = `rtokorg-${suffix}`;
  const userTokenId = `utok-${suffix}`;
  const orgId = `org-rtok-${suffix}`;
  const wsA = `ws-rtok-a-${suffix}`;
  const wsB = `ws-rtok-b-${suffix}`;
  const runA = `run-rtok-a-${suffix}`;
  const runB = `run-rtok-b-${suffix}`;
  let userToken = "";
  let svA = "";
  let svB = "";

  const request = (path: string, auth: string) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth}` },
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: `user-rtok-${suffix}`, username, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: `mem-rtok-${suffix}`, userId: `user-rtok-${suffix}`, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: userTokenId, token: `rtok-user-${suffix}`, userId: `user-rtok-${suffix}` });
    userToken = `rtok-user-${suffix}`;
    await db.insert(workspaces).values([
      { id: wsA, name: `rtok-a-${suffix}`, orgId },
      { id: wsB, name: `rtok-b-${suffix}`, orgId },
    ]);
    await db.insert(runs).values([
      { id: runA, workspaceId: wsA, status: "planned", isDestroy: false, createdAt: Date.now() },
      { id: runB, workspaceId: wsB, status: "planned", isDestroy: false, createdAt: Date.now() },
    ]);
    for (const workspaceId of [wsA, wsB]) {
      const lock = await app.handle(new Request(`http://terrence.test/api/v2/workspaces/${workspaceId}/actions/lock`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      }));
      if (lock.status !== 200) throw new Error(`workspace lock failed: ${lock.status}`);
    }
    const stateA = JSON.stringify({ ...JSON.parse(STATE_A), serial: 1, resources: [] });
    const stateB = JSON.stringify({ ...JSON.parse(STATE_B), serial: 1, resources: [] });
    const post = await app.handle(new Request(`http://terrence.test/api/v2/workspaces/${wsA}/state-versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { type: "state-versions", attributes: { serial: 1, state: stateA, md5: createHash("md5").update(stateA).digest("base64") } } }),
    }));
    expect(post.status).toBe(201);
    svA = (await post.json()).data.id as string;

    // wsB also owns a real state version so the cross-workspace denial test
    // cannot pass merely because wsB has no state to disclose.
    const postB = await app.handle(new Request(`http://terrence.test/api/v2/workspaces/${wsB}/state-versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { type: "state-versions", attributes: { serial: 1, state: stateB, md5: createHash("md5").update(stateB).digest("base64") } } }),
    }));
    expect(postB.status).toBe(201);
    svB = (await postB.json()).data.id as string;
  });

  afterAll(async () => {
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, wsA));
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, wsB));
    await db.delete(runTokens).where(eq(runTokens.runId, runA));
    await db.delete(runTokens).where(eq(runTokens.runId, runB));
    await db.delete(runs).where(eq(runs.id, runA));
    await db.delete(runs).where(eq(runs.id, runB));
    await db.delete(workspaces).where(eq(workspaces.id, wsA));
    await db.delete(workspaces).where(eq(workspaces.id, wsB));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-rtok-${suffix}`));
    await db.delete(apiTokens).where(eq(apiTokens.id, userTokenId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, `user-rtok-${suffix}`));
  });

  it("reads its own workspace state with a valid run token", async () => {
    const token = await mintRunToken(runA, wsA, orgId);
    const res = await request(`/api/v2/state-versions/${svA}/state-version-outputs`, token);
    expect(res.status).toBe(200);
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(token)));
  });

  it("is denied after explicit revocation", async () => {
    const token = await mintRunToken(runA, wsA, orgId);
    await revokeRunTokens(runA);
    const res = await request(`/api/v2/state-versions/${svA}/state-version-outputs`, token);
    expect(res.status).toBe(401);
    // clean the revoked rows
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(token)));
  });

  it("is denied after its 24h expiry", async () => {
    const token = `trun_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    await db.insert(runTokens).values({
      id: `rtok-exp-${suffix}`,
      tokenHash: hashRunToken(token),
      runId: runA,
      workspaceId: wsA,
      organizationId: orgId,
      createdAt: now - 48 * 60 * 60 * 1000,
      expiresAt: now - 24 * 60 * 60 * 1000,
      revokedAt: null,
    });
    const res = await request(`/api/v2/state-versions/${svA}/state-version-outputs`, token);
    expect(res.status).toBe(401);
    await db.delete(runTokens).where(eq(runTokens.id, `rtok-exp-${suffix}`));
  });

  it("cannot read a different workspace's state", async () => {
    const token = await mintRunToken(runA, wsA, orgId);
    // wsB owns a real state version (svB). A 404 (not 200) confirms the token
    // is scoped to runA's workspace and cannot reach wsB's state.
    const res = await request(`/api/v2/state-versions/${svB}/state-version-outputs`, token);
    expect(res.status).toBe(404);
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(token)));
  });
});
