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

describe("single workspace current-run include (audit finding 9)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `current-run-org-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const workspaceName = `CurrentRun-${suffix}`;
  const oldRunId = `run-old-${suffix}`;
  const newRunId = `run-new-${suffix}`;
  const token = `token-${suffix}`;

  const request = (path: string) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: { Authorization: "Bearer " + token },
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: `current-run-${suffix}`, passwordHash: "unused" });
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
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceName, orgId });
    const now = Date.now();
    await db.insert(runs).values([
      { id: oldRunId, workspaceId, status: "applied", message: "old", isDestroy: false, createdAt: now - 1_000 },
      { id: newRunId, workspaceId, status: "planned", message: "new", isDestroy: false, createdAt: now },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  const currentRunIdOf = async (res: Response): Promise<unknown> => {
    const body = await res.json() as {
      data: { relationships?: { "current-run"?: { data: { id: string } | null } } };
    };
    return body.data.relationships?.["current-run"]?.data;
  };

  it("attaches the newest run on the by-id read with include=current_run", async () => {
    const res = await request(`/api/v2/workspaces/${workspaceId}?include=current_run`);
    expect(res.status).toBe(200);
    expect(await currentRunIdOf(res)).toEqual({ id: newRunId, type: "runs" });
  });

  it("attaches the newest run on the by-org/name read with include=current_run", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces/${workspaceName}?include=current_run`);
    expect(res.status).toBe(200);
    expect(await currentRunIdOf(res)).toEqual({ id: newRunId, type: "runs" });
  });

  it("omits the relationship without the include", async () => {
    const res = await request(`/api/v2/workspaces/${workspaceId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { relationships?: Record<string, unknown> };
    };
    expect(body.data.relationships?.["current-run"]).toBeUndefined();
  });
});
