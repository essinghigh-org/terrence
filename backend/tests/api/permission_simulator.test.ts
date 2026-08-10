import { createHash } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, organizationMemberships, teams, teamWorkspaces, workspaces } from "../../src/db/schema";

describe("permission simulator (kanban 20.5)", () => {
  const suffix = Date.now().toString(36);
  const ownerId = `sim-owner-${suffix}`;
  const ownerToken = `sim-owner-token-${suffix}`;
  const orgId = `org-sim-${suffix}`;
  const teamReadOnlyId = `team-ro-${suffix}`;
  const teamWriteId = `team-rw-${suffix}`;
  const wsId = `ws-sim-${suffix}`;

  const request = (path: string, token: string, body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values({
      id: ownerId, username: ownerId, passwordHash: "unused",
    });
    await db.insert(apiTokens).values({
      id: crypto.randomUUID(), token: createHash("sha256").update(ownerToken).digest("hex"), userId: ownerId,
    });
    await db.insert(organizations).values({ id: orgId, name: `sim-${suffix}` });
    await db.insert(organizationMemberships).values({
      id: crypto.randomUUID(), userId: ownerId, orgId, role: "owner",
    });
    await db.insert(teams).values([
      { id: teamReadOnlyId, orgId, name: "sim-read-only" },
      { id: teamWriteId, orgId, name: "sim-write" },
    ]);
    await db.insert(workspaces).values({
      id: wsId, name: `sim-ws-${suffix}`, orgId, createdAt: Date.now(),
    });
    await db.insert(teamWorkspaces).values([
      { id: crypto.randomUUID(), teamId: teamReadOnlyId, workspaceId: wsId, access: "read", permissions: null },
      { id: crypto.randomUUID(), teamId: teamWriteId, workspaceId: wsId, access: "write", permissions: null },
    ]);
  });

  afterAll(async () => {
    await db.delete(teamWorkspaces);
    await db.delete(workspaces);
    await db.delete(teams);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(apiTokens);
    await db.delete(users);
  });

  it("reports read-only team grants", async () => {
    const res = await request(
      `/api/v2/organizations/sim-${suffix}/simulate-permissions`,
      ownerToken,
      {
        "team-id": teamReadOnlyId,
        "workspace-name": `sim-ws-${suffix}`,
        actions: ["read", "apply", "lock"],
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { attributes: { results: { action: string; granted: boolean }[] } } };
    const byAction = new Map(body.data.attributes.results.map((result): [string, boolean] => [result.action, result.granted]));
    expect(byAction.get("read")).toBe(true);
    expect(byAction.get("apply")).toBe(false);
    expect(byAction.get("lock")).toBe(false);
  });

  it("reports write team grants", async () => {
    const res = await request(
      `/api/v2/organizations/sim-${suffix}/simulate-permissions`,
      ownerToken,
      {
        "team-id": teamWriteId,
        "workspace-name": `sim-ws-${suffix}`,
        actions: ["read", "apply", "lock", "plan"],
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { attributes: { results: { action: string; granted: boolean }[] } } };
    const byAction = new Map(body.data.attributes.results.map((result): [string, boolean] => [result.action, result.granted]));
    expect(byAction.get("read")).toBe(true);
    expect(byAction.get("apply")).toBe(true);
    expect(byAction.get("lock")).toBe(true);
    expect(byAction.get("plan")).toBe(true);
  });

  it("rejects unknown teams and workspaces", async () => {
    const badTeam = await request(
      `/api/v2/organizations/sim-${suffix}/simulate-permissions`,
      ownerToken,
      { "team-id": "team-nope", "workspace-name": `sim-ws-${suffix}`, actions: ["read"] },
    );
    expect(badTeam.status).toBe(422);
    const badWs = await request(
      `/api/v2/organizations/sim-${suffix}/simulate-permissions`,
      ownerToken,
      { "team-id": teamReadOnlyId, "workspace-name": "nope", actions: ["read"] },
    );
    expect(badWs.status).toBe(422);
  });
});