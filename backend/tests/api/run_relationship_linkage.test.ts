import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  policyChecks,
  runs,
  taskStages,
  users,
  workspaces,
} from "../../src/db/schema";

describe("run relationship linkage (audit finding 6)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const outsiderId = `outsider-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `linkage-org-${suffix}`;
  const foreignOrgId = `foreign-org-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const runId = `run-${suffix}`;
  const checkId = `pchk-${suffix}`;
  const stageId = `tstg-${suffix}`;
  const token = `token-${suffix}`;
  const outsiderToken = `outsider-${suffix}`;

  const request = (path: string, auth?: string) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: auth === undefined ? {} : { Authorization: "Bearer " + auth },
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, username: `linkage-${suffix}`, passwordHash: "unused" },
      { id: outsiderId, username: `outsider-${suffix}`, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: foreignOrgId, name: `foreign-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values([
      { id: `membership-${suffix}`, userId, orgId, role: "owner" },
      { id: `outsider-membership-${suffix}`, userId: outsiderId, orgId: foreignOrgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([
      { id: `token-${suffix}`, token: hashAuthenticationToken(token), userId },
      { id: `outsider-token-${suffix}`, token: hashAuthenticationToken(outsiderToken), userId: outsiderId },
    ]);
    await db.insert(workspaces).values({ id: workspaceId, name: "Linkage", orgId });
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "planned",
      message: "linkage check",
      isDestroy: false,
      createdAt: Date.now(),
    });
    await db.insert(policyChecks).values({
      id: checkId,
      runId,
      status: "failed",
      result: { error: "rule violated" },
    });
    await db.insert(taskStages).values({
      id: stageId,
      runId,
      stage: "post_plan",
      status: "passed",
    });
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, foreignOrgId]));
    await db.delete(users).where(inArray(users.id, [userId, outsiderId]));
  });

  it("links policy checks, task stages, and the cost estimate from the run read", async () => {
    const res = await request(`/api/v2/runs/${runId}`, token);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { relationships: Record<string, { data?: unknown; links?: Record<string, string> }> };
    };
    const rels = body.data.relationships;
    expect(rels["policy-checks"]?.data).toEqual([{ id: checkId, type: "policy-checks" }]);
    expect(rels["policy-checks"]?.links?.["related"]).toBe(`/api/v2/runs/${runId}/policy-checks`);
    expect(rels["task-stages"]?.data).toEqual([{ id: stageId, type: "task-stages" }]);
    expect(rels["task-stages"]?.links?.["related"]).toBe(`/api/v2/runs/${runId}/task-stages`);
    expect(rels["cost-estimate"]?.data).toEqual({ id: `ce-${runId}`, type: "cost-estimates" });
  });

  it("sideloads task stages on include=task_stages for the CLI stage wait", async () => {
    const res = await request(`/api/v2/runs/${runId}?include=task_stages`, token);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      included: { id: string; type: string; attributes: Record<string, unknown> }[];
    };
    const stage = body.included.find((item): boolean => item.type === "task-stages");
    expect(stage?.id).toBe(stageId);
    expect(stage?.attributes["stage"]).toBe("post_plan");
    expect(stage?.attributes["status"]).toBe("passed");
  });

  it("serializes stored failed checks as hard_failed with scope and override metadata", async () => {
    const res = await request(`/api/v2/runs/${runId}/policy-checks`, token);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { id: string; attributes: Record<string, unknown> }[];
    };
    expect(body.data).toHaveLength(1);
    const attrs = body.data[0]?.attributes ?? {};
    expect(attrs["status"]).toBe("hard_failed");
    expect(attrs["scope"]).toBe("organization");
    expect(attrs["actions"]).toEqual({ "is-overridable": false });
    expect(attrs["permissions"]).toEqual({ "can-override": true });
  });

  it("serves the linked cost estimate through the cost-estimates read route", async () => {
    const res = await request(`/api/v2/cost-estimates/ce-${runId}`, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; type: string } };
    expect(body.data.id).toBe(`ce-${runId}`);
    expect(body.data.type).toBe("cost-estimates");
  });

  it("hides linkage and linked resources from outsiders", async () => {
    expect((await request(`/api/v2/runs/${runId}`, outsiderToken)).status).toBe(404);
    expect((await request(`/api/v2/runs/${runId}/policy-checks`, outsiderToken)).status).toBe(404);
    expect((await request(`/api/v2/cost-estimates/ce-${runId}`, outsiderToken)).status).toBe(404);
  });
});
