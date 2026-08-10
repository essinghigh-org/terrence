import { createHash } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, organizationMemberships, workspaces, workspaceTags, policySetWorkspaces, policySets } from "../../src/db/schema";

describe("workspace scorecards (kanban 21.12)", () => {
  const suffix = Date.now().toString(36);
  const ownerId = `score-owner-${suffix}`;
  const ownerToken = `score-owner-token-${suffix}`;
  const orgId = `org-score-${suffix}`;
  const wsGoodId = `ws-good-${suffix}`;
  const wsBadId = `ws-bad-${suffix}`;
  const policySetId = `polset-score-${suffix}`;

  const request = (path: string, token: string): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: ownerId, username: ownerId, passwordHash: "unused" });
    await db.insert(apiTokens).values({
      id: crypto.randomUUID(), token: createHash("sha256").update(ownerToken).digest("hex"), userId: ownerId,
    });
    await db.insert(organizations).values({ id: orgId, name: `score-${suffix}` });
    await db.insert(organizationMemberships).values({
      id: crypto.randomUUID(), userId: ownerId, orgId, role: "owner",
    });
    await db.insert(workspaces).values([
      {
        id: wsGoodId, name: `good-${suffix}`, orgId,
        vcsRepo: { identifier: "acme/infra" } as never,
        assessmentsEnabled: true,
        terraformVersion: "1.9",
        createdAt: Date.now(),
      },
      { id: wsBadId, name: `bad-${suffix}`, orgId, terraformVersion: "0.12", createdAt: Date.now() },
    ]);
    await db.insert(policySets).values({
      id: policySetId, orgId, name: `score-policies-${suffix}`,
      kind: "sentinel", createdAt: Date.now(),
    });
    await db.insert(policySetWorkspaces).values({
      id: crypto.randomUUID(), policySetId, workspaceId: wsGoodId,
    });
    await db.insert(workspaceTags).values({
      id: crypto.randomUUID(), workspaceId: wsGoodId, key: "owner", value: "platform",
    });
  });

  afterAll(async () => {
    await db.delete(workspaceTags);
    await db.delete(policySetWorkspaces);
    await db.delete(policySets);
    await db.delete(workspaces);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(apiTokens);
    await db.delete(users);
  });

  it("scores a compliant workspace 5/5 and a bare workspace 0/5", async () => {
    const res = await request(
      `/api/v2/organizations/score-${suffix}/workspace-scorecards`,
      ownerToken,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; attributes: Record<string, unknown> }[] };
    const byName = new Map(body.data.map((entry): [string, string] => [entry.attributes["workspace-name"] as string, entry.id]));
    const good = body.data.find((entry): boolean => entry.attributes["workspace-name"] === `good-${suffix}`);
    const bad = body.data.find((entry): boolean => entry.attributes["workspace-name"] === `bad-${suffix}`);
    expect(good).toBeDefined();
    expect(bad).toBeDefined();
    expect(good!.attributes["vcs-connected"]).toBe(true);
    expect(good!.attributes["policy-attached"]).toBe(true);
    expect(good!.attributes["assessment-enabled"]).toBe(true);
    expect(good!.attributes["owner-tag-present"]).toBe(true);
    expect(good!.attributes["engine-version-supported"]).toBe(true);
    expect(good!.attributes.score).toBe(5);
    expect(bad!.attributes.score).toBe(0);
    expect(bad!.attributes["policy-attached"]).toBe(false);
    expect(byName.has(`good-${suffix}`)).toBe(true);
  });
});