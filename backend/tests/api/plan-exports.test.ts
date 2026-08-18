import { describe, expect, it, beforeEach } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  users, organizations, organizationMemberships, teams,
  workspaces, runs, planExports, apiTokens,
} from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { writePlanJsonArtifact, deletePlanJsonArtifact } from "../../src/lib/plan-json";

describe("the reference format API v2 - Plan Exports Download", () => {
  let userToken: string;
  let userId: string;
  let orgId: string;
  let workspaceId: string;
  let runId: string;
  let planId: string;
  let exportId: string;

  beforeEach(async () => {
    // Clean up in reverse dependency order
    await db.delete(planExports);
    await db.delete(runs);
    await db.delete(workspaces);
    await db.delete(teams);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(apiTokens);
    await db.delete(users).where(eq(users.username, "export-owner"));

    userId = `usr-${crypto.randomUUID()}`;
    userToken = `test-user-token-${crypto.randomUUID()}`;
    orgId = `org-${crypto.randomUUID()}`;
    workspaceId = `ws-${crypto.randomUUID()}`;
    runId = `run-${crypto.randomUUID()}`;
    planId = `plan-${runId}`;
    exportId = `pe-${crypto.randomUUID()}`;

    // Create user
    await db.insert(users).values({
      id: userId,
      username: "export-owner",
      email: "owner@export.local",
      passwordHash: "hashed",
      isSiteAdmin: true,
    });

    // Create API token for auth
    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: userToken,
      userId,
      createdAt: Date.now(),
    });

    // Create org, workspace, and run
    await db.insert(organizations).values({
      id: orgId,
      name: `export-org-${crypto.randomUUID().substring(0, 8)}`,
    });

    await db.insert(organizationMemberships).values({
      id: `orgmem-export-owner`,
      orgId,
      userId,
      role: "owner",
      status: "active",
    });

    await db.insert(workspaces).values({
      id: workspaceId,
      name: "export-workspace",
      orgId,
      autoApply: false,
      terraformVersion: "latest",
    });

    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "planned",
      message: "Export test run",
      createdAt: Date.now(),
    });

    // Write the plan JSON artifact that the download handler will read
    await writePlanJsonArtifact(runId, {
      format_version: "1.2",
      terraform_version: "1.9.8",
      resource_changes: [{ address: "terraform_data.example" }],
    });
  });

  describe("GET /api/v2/plan-exports/:export_id/download", () => {
    it("returns 401 when unauthenticated", async () => {
      const res = await app.handle(
        new Request(`http://localhost/api/v2/plan-exports/${exportId}/download`),
      );
      expect(res.status).toBe(401);
    });

    it("returns 404 when export does not exist", async () => {
      const res = await app.handle(
        new Request(`http://localhost/api/v2/plan-exports/nonexistent/download`, {
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when user has no access to the associated workspace", async () => {
      // Create a non-admin user in a different org who has no access to the main workspace
      const otherUserId = `usr-${crypto.randomUUID()}`;
      const otherToken = `test-other-token-${crypto.randomUUID()}`;
      const otherOrgId = `org-${crypto.randomUUID()}`;
      const otherWorkspaceId = `ws-${crypto.randomUUID()}`;
      const otherRunId = `run-${crypto.randomUUID()}`;
      const otherPlanId = `plan-${otherRunId}`;
      const otherExportId = `pe-${crypto.randomUUID()}`;

      await db.insert(users).values({
        id: otherUserId,
        username: "other-user",
        email: "other@export.local",
        passwordHash: "hashed",
        isSiteAdmin: false,
      });

      await db.insert(apiTokens).values({
        id: `tok-${crypto.randomUUID()}`,
        token: otherToken,
        userId: otherUserId,
        createdAt: Date.now(),
      });

      await db.insert(organizations).values({
        id: otherOrgId,
        name: `other-export-org-${crypto.randomUUID().substring(0, 8)}`,
      });

      await db.insert(organizationMemberships).values({
        id: `orgmem-other-user`,
        orgId: otherOrgId,
        userId: otherUserId,
        role: "member",
        status: "active",
      });

      await db.insert(workspaces).values({
        id: otherWorkspaceId,
        name: "other-export-workspace",
        orgId: otherOrgId,
      });

      await db.insert(runs).values({
        id: otherRunId,
        workspaceId: otherWorkspaceId,
        status: "planned",
        createdAt: Date.now(),
      });

      await writePlanJsonArtifact(otherRunId, { format_version: "1.0" });

      await db.insert(planExports).values({
        id: otherExportId,
        planId: otherPlanId,
        dataType: "sentinel-mock-bundle-v0",
        status: "finished",
        expiresAt: Date.now() + 3600 * 1000,
        createdAt: Date.now(),
      });

      const res = await app.handle(
        new Request(`http://localhost/api/v2/plan-exports/${otherExportId}/download`, {
          headers: { Authorization: `Bearer ${otherToken}` },
        }),
      );
      expect(res.status).toBe(404);

      // Cleanup
      await db.delete(planExports).where(eq(planExports.id, otherExportId));
      await db.delete(runs).where(eq(runs.id, otherRunId));
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, otherUserId));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
      await db.delete(apiTokens).where(eq(apiTokens.token, otherToken));
      await db.delete(users).where(eq(users.username, "other-user"));
      await deletePlanJsonArtifact(otherRunId);
    });

    it("returns 410 when export is expired", async () => {
      await db.insert(planExports).values({
        id: exportId,
        planId,
        dataType: "sentinel-mock-bundle-v0",
        status: "finished",
        expiresAt: Date.now() - 1000, // expired
        createdAt: Date.now(),
      });

      const res = await app.handle(
        new Request(`http://localhost/api/v2/plan-exports/${exportId}/download`, {
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.errors[0].title).toBe("Gone");
    });

    it("returns 404 when plan JSON artifact is unavailable", async () => {
      // Export references a plan whose run has no artifact on disk
      const missingRunId = `run-${crypto.randomUUID()}`;
      const missingPlanId = `plan-${missingRunId}`;
      const missingExportId = `pe-${crypto.randomUUID()}`;

      await db.insert(runs).values({
        id: missingRunId,
        workspaceId,
        status: "planned",
        createdAt: Date.now(),
      });

      await db.insert(planExports).values({
        id: missingExportId,
        planId: missingPlanId,
        dataType: "sentinel-mock-bundle-v0",
        status: "finished",
        expiresAt: Date.now() + 3600 * 1000,
        createdAt: Date.now(),
      });

      const res = await app.handle(
        new Request(`http://localhost/api/v2/plan-exports/${missingExportId}/download`, {
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.errors[0].detail).toBe("Plan export artifact is unavailable");

      // Cleanup
      await db.delete(planExports).where(eq(planExports.id, missingExportId));
      await db.delete(runs).where(eq(runs.id, missingRunId));
    });

    it("returns 200 with plan JSON and attachment headers for a valid export", async () => {
      await db.insert(planExports).values({
        id: exportId,
        planId,
        dataType: "sentinel-mock-bundle-v0",
        status: "finished",
        expiresAt: Date.now() + 3600 * 1000,
        createdAt: Date.now(),
      });

      const res = await app.handle(
        new Request(`http://localhost/api/v2/plan-exports/${exportId}/download`, {
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );
      expect(res.status).toBe(200);

      const contentType = res.headers.get("Content-Type");
      expect(contentType).toBe("application/json");

      const contentDisposition = res.headers.get("Content-Disposition");
      expect(contentDisposition).toBe(`attachment; filename=plan-export-${exportId}.json`);

      const body = await res.json();
      expect(body.version).toBe(1);
      expect(body.dataType).toBe("sentinel-mock-bundle-v0");
      expect(body.planId).toBe(planId);
      expect(body.plan).toBeDefined();
      expect(body.plan.format_version).toBe("1.2");
    });

    it("returns a Response object (not a JSON envelope) so Content-Disposition is honored", async () => {
      await db.insert(planExports).values({
        id: exportId,
        planId,
        dataType: "sentinel-mock-bundle-v0",
        status: "finished",
        expiresAt: Date.now() + 3600 * 1000,
        createdAt: Date.now(),
      });

      const res = await app.handle(
        new Request(`http://localhost/api/v2/plan-exports/${exportId}/download`, {
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );
      // The download route returns a raw Response, not a JSON { data: ... } envelope
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename=plan-export-${exportId}.json`);
    });
  });
});
