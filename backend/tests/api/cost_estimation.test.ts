import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import {
  deleteCostEstimateArtifact,
  parseInfracostOutput,
  writeCostEstimateArtifact,
} from "../../src/lib/cost-estimate";

describe("Cost estimate API persistence", () => {
  const suffix = crypto.randomUUID();
  const userId = `cost-user-${suffix}`;
  const orgId = `cost-org-${suffix}`;
  const workspaceId = `cost-workspace-${suffix}`;
  const runId = `cost-run-${suffix}`;
  const token = `cost-token-${suffix}`;
  const pendingAt = "2026-07-28T09:00:00.000Z";
  const finishedAt = "2026-07-28T09:00:01.000Z";

  const request = (path: string): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(organizationMemberships).values({ id: `membership-${suffix}`, userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: `token-${suffix}`, token, userId });
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId });
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "cost_estimated",
      statusTimestamps: {
        "planned-at": "2026-07-28T08:59:59.000Z",
        "cost-estimating-at": pendingAt,
        "cost-estimated-at": finishedAt,
      },
      createdAt: Date.now(),
    });
    await writeCostEstimateArtifact(runId, parseInfracostOutput({
      currency: "USD",
      pastTotalMonthlyCost: "100.00",
      totalMonthlyCost: "125.50",
      diffTotalMonthlyCost: "25.50",
      summary: {
        totalDetectedResources: 2,
        totalSupportedResources: 1,
        totalUnsupportedResources: 1,
      },
      projects: [{
        name: "production",
        diff: {
          resources: [{
            name: "aws_instance.app",
            resourceType: "aws_instance",
            monthlyCost: "25.50",
            action: "modify",
          }],
        },
      }],
    }, {
      "queued-at": "2026-07-28T08:59:59.000Z",
      "pending-at": pendingAt,
      "finished-at": finishedAt,
    }));
  });

  afterAll(async () => {
    await deleteCostEstimateArtifact(runId);
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  for (const path of [
    `/api/v2/runs/${runId}/cost-estimate`,
    `/api/v2/cost-estimates/ce-${runId}`,
  ]) {
    it(`returns the persisted estimate from ${path}`, async () => {
      const response = await request(path);
      expect(response.status).toBe(200);
      const body = await response.json();
      const attributes = body.data.attributes;

      expect(attributes.status).toBe("finished");
      expect(attributes["prior-monthly-cost"]).toBe("100.00");
      expect(attributes["proposed-monthly-cost"]).toBe("125.50");
      expect(attributes["delta-monthly-cost"]).toBe("25.50");
      expect(attributes["resources-count"]).toBe(2);
      expect(attributes["matched-resources-count"]).toBe(1);
      expect(attributes["unmatched-resources-count"]).toBe(1);
      expect(attributes["status-timestamps"]["finished-at"]).toBe(finishedAt);
      expect(attributes.resources.projects[0].diff.resources[0]).toMatchObject({
        name: "aws_instance.app",
        action: "modify",
      });
    });
  }
});
