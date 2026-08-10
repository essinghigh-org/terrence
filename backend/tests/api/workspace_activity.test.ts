import { createHash } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, organizationMemberships, workspaces, runs, auditLogs } from "../../src/db/schema";

describe("workspace activity feed (kanban 16.9)", () => {
  const suffix = Date.now().toString(36);
  const ownerId = `act-owner-${suffix}`;
  const ownerToken = `act-owner-token-${suffix}`;
  const orgId = `org-act-${suffix}`;
  const wsId = `ws-act-${suffix}`;

  const request = (path: string, token: string): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: ownerId, username: ownerId, passwordHash: "unused" });
    await db.insert(apiTokens).values({
      id: crypto.randomUUID(), token: createHash("sha256").update(ownerToken).digest("hex"), userId: ownerId,
    });
    await db.insert(organizations).values({ id: orgId, name: `act-${suffix}` });
    await db.insert(organizationMemberships).values({
      id: crypto.randomUUID(), userId: ownerId, orgId, role: "owner",
    });
    await db.insert(workspaces).values({
      id: wsId, name: `act-ws-${suffix}`, orgId, createdAt: Date.now() - 60_000,
    });
    await db.insert(runs).values({
      id: `run-act-${suffix}`, workspaceId: wsId, status: "applied", message: "deploy", createdAt: Date.now() - 30_000,
    });
    await db.insert(auditLogs).values({
      id: `aud-act-${suffix}`, orgId, userId: ownerId, action: "lock", resourceType: "workspaces",
      resourceId: wsId, details: { reason: "maintenance" }, createdAt: Date.now() - 10_000,
    });
  });

  afterAll(async () => {
    await db.delete(auditLogs);
    await db.delete(runs);
    await db.delete(workspaces);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(apiTokens);
    await db.delete(users);
  });

  it("merges run and audit events newest first", async () => {
    const res = await request(`/api/v2/workspaces/${wsId}/activity`, ownerToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; attributes: Record<string, unknown> }[] };
    expect(body.data.length).toBe(2);
    // Newest first: audit lock (10s ago), then the run (30s ago).
    expect(body.data[0]!.attributes.kind).toBe("audit");
    expect(body.data[0]!.attributes.action).toBe("lock");
    expect(body.data[0]!.attributes.details).toEqual({ reason: "maintenance" });
    expect(body.data[1]!.attributes.kind).toBe("run");
    expect(body.data[1]!.attributes.status).toBe("applied");
    expect(body.data[1]!.attributes.message).toBe("deploy");
  });

  it("returns 404 for unknown workspaces", async () => {
    const res = await request("/api/v2/workspaces/ws-nope/activity", ownerToken);
    expect(res.status).toBe(404);
  });
});