import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, organizations, organizationMemberships, projects, workspaces, users,
  runs,
} from "../../src/db/schema";

const suffix = crypto.randomUUID();

describe("permission fuzzing — cross-org IDOR guard", () => {
  let orgA = "", orgB = "";
  let wsA = "", wsB = "";
  let projA = "";
  let ownerToken = "", otherToken = "";

  const req = (path: string, token: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/vnd.api+json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));

  beforeAll(async () => {
    const ownerId = `fuzz-owner-${suffix}`;
    const otherId = `fuzz-other-${suffix}`;
    orgA = `org-fuzz-a-${suffix}`;
    orgB = `org-fuzz-b-${suffix}`;
    wsA = `ws-fuzz-a-${suffix}`;
    wsB = `ws-fuzz-b-${suffix}`;
    projA = `prj-fuzz-a-${suffix}`;
    ownerToken = `tok-fuzz-owner-${suffix}`;
    otherToken = `tok-fuzz-other-${suffix}`;

    await db.insert(users).values([
      { id: ownerId, username: ownerId, passwordHash: "h" },
      { id: otherId, username: otherId, passwordHash: "h" },
    ]);
    await db.insert(organizations).values([{ id: orgA, name: orgA }, { id: orgB, name: orgB }]);
    await db.insert(organizationMemberships).values([
      { id: `om-fuzz-a-${suffix}`, userId: ownerId, orgId: orgA, role: "owner" },
      { id: `om-fuzz-b-${suffix}`, userId: otherId, orgId: orgB, role: "owner" },
    ]);
    await db.insert(projects).values({ id: projA, orgId: orgA, name: `proj-${suffix}` });
    await db.insert(workspaces).values([
      { id: wsA, orgId: orgA, projectId: projA, name: `ws-a-${suffix}` },
      { id: wsB, orgId: orgB, name: `ws-b-${suffix}` },
    ]);
    await db.insert(apiTokens).values([
      { id: `api-fuzz-owner-${suffix}`, token: createHash("sha256").update(ownerToken).digest("hex"), userId: ownerId },
      { id: `api-fuzz-other-${suffix}`, token: createHash("sha256").update(otherToken).digest("hex"), userId: otherId },
    ]);
  });

  afterAll(async () => {
    await db.delete(runs).where(inArray(runs.workspaceId, [wsA, wsB]));
    await db.delete(apiTokens).where(inArray(apiTokens.token, [
      createHash("sha256").update(ownerToken).digest("hex"),
      createHash("sha256").update(otherToken).digest("hex"),
    ]));
    await db.delete(workspaces).where(inArray(workspaces.id, [wsA, wsB]));
    await db.delete(projects).where(eq(projects.id, projA));
    await db.delete(organizationMemberships).where(inArray(organizationMemberships.orgId, [orgA, orgB]));
    await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB]));
    await db.delete(users).where(inArray(users.id, [`fuzz-owner-${suffix}`, `fuzz-other-${suffix}`]));
  });

  it("rejects reading another org's workspace", async () => {
    const res = await req(`/api/v2/workspaces/${wsA}`, otherToken);
    expect([403, 404]).toContain(res.status);
  });

  it("rejects creating a run in another org's workspace", async () => {
    const res = await req(`/api/v2/runs`, otherToken, "POST", {
      data: { type: "runs", relationships: { workspace: { data: { id: wsA, type: "workspaces" } } } },
    });
    expect([403, 404, 422]).toContain(res.status);
  });

  it("rejects fetching org details cross-org", async () => {
    const res = await req(`/api/v2/organizations/${orgA}`, otherToken);
    expect([403, 404]).toContain(res.status);
  });

  it("rejects listing projects cross-org", async () => {
    const res = await req(`/api/v2/organizations/${orgA}/projects`, otherToken);
    expect([403, 404]).toContain(res.status);
  });
});
