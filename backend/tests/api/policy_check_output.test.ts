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
  users,
  workspaces,
} from "../../src/db/schema";

describe("policy check output (audit finding 4)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const outsiderId = `outsider-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `policy-output-org-${suffix}`;
  const foreignOrgId = `foreign-org-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const runId = `run-${suffix}`;
  const checkId = `pchk-${suffix}`;
  const token = `token-${suffix}`;
  const outsiderToken = `outsider-${suffix}`;

  const request = (path: string, auth?: string) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: auth === undefined ? {} : { Authorization: "Bearer " + auth },
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, username: `policy-output-${suffix}`, passwordHash: "unused" },
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
    await db.insert(workspaces).values({ id: workspaceId, name: "PolicyOutput", orgId });
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "policy_checked",
      message: "policy output check",
      isDestroy: false,
      createdAt: Date.now(),
    });
    await db.insert(policyChecks).values({
      id: checkId,
      runId,
      status: "passed",
      result: { passed: 2, failed: 0 },
    });
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, foreignOrgId]));
    await db.delete(users).where(inArray(users.id, [userId, outsiderId]));
  });

  it("returns the stored outcome as plain text for go-tfe Logs", async () => {
    const res = await request(`/api/v2/policy-checks/${checkId}/output`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain(`status: passed`);
    expect(text).toContain("passed");
  });

  it("hides output from outsiders, strangers, and unknown checks", async () => {
    expect((await request(`/api/v2/policy-checks/${checkId}/output`, outsiderToken)).status).toBe(404);
    expect((await request(`/api/v2/policy-checks/${checkId}/output`)).status).toBe(404);
    expect((await request(`/api/v2/policy-checks/missing-${suffix}/output`, token)).status).toBe(404);
  });
});
