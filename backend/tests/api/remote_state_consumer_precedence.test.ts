import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  projects,
  remoteStateConsumers,
  runs,
  stateVersions,
  users,
  workspaces,
} from "../../src/db/schema";
import { canConsumeRemoteState } from "../../src/lib/utils";
import { mintRunToken } from "../../src/lib/run-token";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";

// STATE-005: global/project/explicit consumer precedence.
//
// A workspace may read another workspace's state when at least one of these
// grants holds (OR-combined, matching the reference format's remote-state sharing model):
//   1. an explicit consumer link (remote_state_consumers)
//   2. project-remote-state: both workspaces share the same project
//   3. global-remote-state: the producer workspace grants org-wide access
//
// Cross-organization reads are never allowed. Denied reads fall through to
// the state module's normal 404 convention (never 403), consistent with the
// rest of this codebase's state-access denial handling.

const STATE = JSON.stringify({ version: 4, terraform_version: "1.7.0", outputs: {} });

describe("remote-state consumer precedence (STATE-005)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const username = `rscons-${suffix}`;
  const orgId = `org-rscons-${suffix}`;
  const otherOrgId = `org-rscons-other-${suffix}`;
  const projectId = `proj-rscons-${suffix}`;
  const producer = `ws-rscons-prod-${suffix}`;
  const explicitConsumer = `ws-rscons-explicit-${suffix}`;
  const projectConsumer = `ws-rscons-project-${suffix}`;
  const globalConsumer = `ws-rscons-global-${suffix}`;
  const unrelatedConsumer = `ws-rscons-unrelated-${suffix}`;
  const crossOrgConsumer = `ws-rscons-crossorg-${suffix}`;
  const runInConsumer = `run-rscons-${suffix}`;
  const userTokenId = `utok-rscons-${suffix}`;
  const userToken = `rscons-user-${suffix}`;
  let consumerRunToken = "";
  let noGrantRunToken = "";

  const request = (path: string, auth: string) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth}` },
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: `user-rscons-${suffix}`, username, passwordHash: "unused" });
    await db.insert(organizations).values([{ id: orgId, name: orgId }, { id: otherOrgId, name: otherOrgId }]);
    await db.insert(organizationMemberships).values([
      { id: `mem-rscons-${suffix}`, userId: `user-rscons-${suffix}`, orgId, role: "owner" },
      { id: `mem-rscons-other-${suffix}`, userId: `user-rscons-${suffix}`, orgId: otherOrgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values({ id: userTokenId, token: hashAuthenticationToken(userToken), userId: `user-rscons-${suffix}` });
    await db.insert(projects).values({ id: projectId, name: projectId, orgId });
    await db.insert(workspaces).values([
      { id: producer, name: producer, orgId, projectId, globalRemoteState: false, projectRemoteState: false },
      { id: explicitConsumer, name: explicitConsumer, orgId, projectId: null },
      { id: projectConsumer, name: projectConsumer, orgId, projectId },
      { id: globalConsumer, name: globalConsumer, orgId, projectId: null },
      { id: unrelatedConsumer, name: unrelatedConsumer, orgId, projectId: null },
      { id: crossOrgConsumer, name: crossOrgConsumer, orgId: otherOrgId, projectId: null },
    ]);
    await db.insert(runs).values([
      { id: runInConsumer, workspaceId: explicitConsumer, status: "planned", isDestroy: false, createdAt: Date.now() },
    ]);
    consumerRunToken = await mintRunToken(runInConsumer, explicitConsumer, orgId);
    await db.insert(remoteStateConsumers).values([
      { id: `rsc-${suffix}`, workspaceId: producer, consumerWorkspaceId: explicitConsumer },
    ]);
    const lock = await app.handle(new Request(`http://terrence.test/api/v2/workspaces/${producer}/actions/lock`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    }));
    if (lock.status !== 200) throw new Error(`workspace lock failed: ${lock.status}`);
    const state = JSON.stringify({ ...JSON.parse(STATE), serial: 1, resources: [] });
    const post = await app.handle(new Request(`http://terrence.test/api/v2/workspaces/${producer}/state-versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { type: "state-versions", attributes: { serial: 1, state, md5: createHash("md5").update(state).digest("base64") } } }),
    }));
    expect(post.status).toBe(201);
  });

  afterAll(async () => {
    await db.delete(remoteStateConsumers).where(eq(remoteStateConsumers.workspaceId, producer));
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, producer));
    await db.delete(runs).where(eq(runs.id, runInConsumer));
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(workspaces).where(eq(workspaces.orgId, otherOrgId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-rscons-${suffix}`));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-rscons-other-${suffix}`));
    await db.delete(apiTokens).where(eq(apiTokens.id, userTokenId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(users).where(eq(users.id, `user-rscons-${suffix}`));
  });

  // --- Precedence, pinned against the resolver directly ---

  test("explicit consumer link grants access", async () => {
    expect(await canConsumeRemoteState(producer, explicitConsumer)).toBe(true);
  });

  test("project-remote-state grants access to a workspace sharing the project", async () => {
    await db.update(workspaces).set({ projectRemoteState: true }).where(eq(workspaces.id, producer));
    try {
      expect(await canConsumeRemoteState(producer, projectConsumer)).toBe(true);
      // A workspace in a different project with no explicit link is denied.
      expect(await canConsumeRemoteState(producer, unrelatedConsumer)).toBe(false);
    } finally {
      await db.update(workspaces).set({ projectRemoteState: false }).where(eq(workspaces.id, producer));
    }
  });

  test("global-remote-state grants org-wide access", async () => {
    await db.update(workspaces).set({ globalRemoteState: true }).where(eq(workspaces.id, producer));
    try {
      // Any workspace in the same org is granted, even without an explicit link.
      expect(await canConsumeRemoteState(producer, globalConsumer)).toBe(true);
      expect(await canConsumeRemoteState(producer, unrelatedConsumer)).toBe(true);
      // Cross-org consumers remain denied even with global enabled.
      expect(await canConsumeRemoteState(producer, crossOrgConsumer)).toBe(false);
    } finally {
      await db.update(workspaces).set({ globalRemoteState: false }).where(eq(workspaces.id, producer));
    }
  });

  test("a workspace with no grant is denied", async () => {
    expect(await canConsumeRemoteState(producer, unrelatedConsumer)).toBe(false);
  });

  test("cross-organization consumers are always denied", async () => {
    await db.update(workspaces).set({ globalRemoteState: true }).where(eq(workspaces.id, producer));
    try {
      expect(await canConsumeRemoteState(producer, crossOrgConsumer)).toBe(false);
    } finally {
      await db.update(workspaces).set({ globalRemoteState: false }).where(eq(workspaces.id, producer));
    }
  });

  // --- HTTP-level enforcement via the run-scoped consumer grant ---

  test("a run in an explicit consumer workspace can read the producer's current state", async () => {
    const res = await request(`/api/v2/workspaces/${producer}/current-state-version`, consumerRunToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.serial).toBe(1);
  });

  test("a run without a consumer grant cannot read another workspace's state (404)", async () => {
    const runNoGrant = `run-nogrant-${suffix}`;
    await db.insert(runs).values([
      { id: runNoGrant, workspaceId: unrelatedConsumer, status: "planned", isDestroy: false, createdAt: Date.now() },
    ]);
    noGrantRunToken = await mintRunToken(runNoGrant, unrelatedConsumer, orgId);
    try {
      const res = await request(`/api/v2/workspaces/${producer}/current-state-version`, noGrantRunToken);
      expect(res.status).toBe(404);
    } finally {
      await db.delete(runs).where(eq(runs.id, runNoGrant));
    }
  });

  test("a run in an explicit consumer workspace can read the producer's current state outputs", async () => {
    const res = await request(`/api/v2/workspaces/${producer}/current-state-version-outputs`, consumerRunToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("a run without a consumer grant cannot read another workspace's state outputs (404)", async () => {
    const runNoGrant = `run-nogrant-out-${suffix}`;
    await db.insert(runs).values([
      { id: runNoGrant, workspaceId: unrelatedConsumer, status: "planned", isDestroy: false, createdAt: Date.now() },
    ]);
    const noGrantOutToken = await mintRunToken(runNoGrant, unrelatedConsumer, orgId);
    try {
      const res = await request(`/api/v2/workspaces/${producer}/current-state-version-outputs`, noGrantOutToken);
      expect(res.status).toBe(404);
    } finally {
      await db.delete(runs).where(eq(runs.id, runNoGrant));
    }
  });
});