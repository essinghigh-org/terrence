import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";

describe("run include workspace sideload (audit finding 8)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `sideload-org-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const runId = `run-${suffix}`;
  const token = `token-${suffix}`;

  const request = (path: string) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: { Authorization: "Bearer " + token },
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: `sideload-${suffix}`, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `membership-${suffix}`,
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({
      id: `token-${suffix}`,
      token: hashAuthenticationToken(token),
      userId,
    });
    await db.insert(workspaces).values({ id: workspaceId, name: "Sideload", orgId });
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "planned",
      message: "sideload check",
      isDestroy: false,
      createdAt: Date.now(),
    });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("carries structured-run-output-enabled matching the full workspace resource", async () => {
    const res = await request(`/api/v2/runs/${runId}?include=workspace`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      included: { id: string; type: string; attributes: Record<string, unknown> }[];
    };
    expect(Array.isArray(body.included)).toBe(true);
    const sideload = body.included.find((item): boolean => item.type === "workspaces");
    expect(sideload?.id).toBe(workspaceId);
    expect(sideload?.attributes["name"]).toBe("Sideload");
    expect(sideload?.attributes["locked"]).toBe(false);
    expect(sideload?.attributes["structured-run-output-enabled"]).toBe(true);
  });
});
