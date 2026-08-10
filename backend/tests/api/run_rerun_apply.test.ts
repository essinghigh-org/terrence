import { createHash } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, workspaces, runs } from "../../src/db/schema";
import { eq } from "drizzle-orm";

// Covers kanban 15.13 (re-run queues a fresh run from the same workspace) and
// the additive workspace-locked fields on run detail (15.10 explainer).
describe("run detail lock fields + re-run (kanban 15.10 / 15.13)", () => {
  const suffix = Date.now().toString(36);
  const adminId = `rr-admin-${suffix}`;
  const orgId = `org-rr-${suffix}`;
  const workspaceId = `ws-rr-${suffix}`;
  const token = `rr-token-${suffix}`;

  const requestWithToken = (path: string, init: RequestInit = {}): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/vnd.api+json" } : {}),
      },
      body: init.body ?? null,
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: createHash("sha256").update(token).digest("hex"), userId: adminId },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: `rr-org-${suffix}`, email: "ops@example.com" },
    ]);
    await db.insert(workspaces).values([
      { id: workspaceId, name: "rr-workspace", orgId, autoApply: false },
    ]);
  });

  afterAll(async () => {
    await db.delete(runs);
    await db.delete(workspaces);
    await db.delete(organizations);
    await db.delete(apiTokens);
    await db.delete(users);
  });

  it("surfaces workspace-locked fields on run detail", async () => {
    const inserted = await db.insert(runs).values({
      id: `run-rr-detail-${suffix}`,
      workspaceId,
      status: "applied",
      message: "rr detail",
      createdAt: Date.now(),
    }).returning();
    const res = await requestWithToken(`/api/v2/runs/${inserted[0]!.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes["workspace-locked"]).toBe(false);
    expect(body.data.attributes["workspace-locked-reason"]).toBeNull();
  });

  it("reflects a locked workspace in run detail", async () => {
    await db.update(workspaces).set({ locked: true, lockedReason: "Maintenance window" }).where(eq(workspaces.id, workspaceId));
    const inserted = await db.insert(runs).values({
      id: `run-rr-locked-${suffix}`,
      workspaceId,
      status: "planned",
      message: "rr locked",
      createdAt: Date.now(),
    }).returning();
    const res = await requestWithToken(`/api/v2/runs/${inserted[0]!.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes["workspace-locked"]).toBe(true);
    expect(body.data.attributes["workspace-locked-reason"]).toBe("Maintenance window");
    await db.update(workspaces).set({ locked: false, lockedReason: null }).where(eq(workspaces.id, workspaceId));
  });

  it("rejects run creation and apply while the workspace is locked", async () => {
    await db.update(workspaces).set({ locked: true, lockedReason: "Maintenance window" }).where(eq(workspaces.id, workspaceId));
    try {
      const createRes = await requestWithToken("/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: { message: "should-not-queue" },
            relationships: { workspace: { data: { type: "workspaces", id: workspaceId } } },
          },
        }),
      });
      expect(createRes.status).toBe(422);
      const createBody = await createRes.json() as { errors: { detail?: string }[] };
      expect(createBody.errors[0]?.detail).toBe("Workspace is locked: Maintenance window");

      const inserted = await db.insert(runs).values({
        id: `run-rr-lockapply-${suffix}`,
        workspaceId,
        status: "planned",
        message: "rr lock apply",
        createdAt: Date.now(),
      }).returning();
      const applyRes = await requestWithToken(`/api/v2/runs/${inserted[0]!.id}/actions/apply`, { method: "POST" });
      expect(applyRes.status).toBe(422);
      const applyBody = await applyRes.json() as { errors: { detail?: string }[] };
      expect(applyBody.errors[0]?.detail).toBe("Workspace is locked: Maintenance window");
    } finally {
      await db.update(workspaces).set({ locked: false, lockedReason: null }).where(eq(workspaces.id, workspaceId));
    }
  });

  it("queues a re-run via POST /api/v2/runs with workspace relationship", async () => {
    const res = await requestWithToken("/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({
        data: {
          attributes: { message: "Re-run of run-abc" },
          relationships: { workspace: { data: { type: "workspaces", id: workspaceId } } },
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; attributes: { message: string; status: string } } };
    expect(body.data.attributes.message).toBe("Re-run of run-abc");
    expect(body.data.id.startsWith("run-")).toBe(true);
    const row = await db.query.runs.findFirst({ where: eq(runs.id, body.data.id) });
    expect(row?.workspaceId).toBe(workspaceId);
    expect(row?.message).toBe("Re-run of run-abc");
  });
});