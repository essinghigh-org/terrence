import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  apiTokens,
  configurationVersions,
  notificationConfigurations,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";
import { _dedup, deliverRunNotifications } from "../../src/lib/notifications";

describe("Notification suppression (kanban 7.8 / NOT-012)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const organizationName = `ntf-suppress-${suffix}`;
  const workspaceId = `ws-suppress-${suffix}`;
  const authToken = `user-token-${suffix}`;

  const priorAllowPrivateUrls = process.env.TERRENCE_ALLOW_PRIVATE_URLS;

  beforeAll(async () => {
    process.env.TERRENCE_ALLOW_PRIVATE_URLS = "true";
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: organizationName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token: hashAuthenticationToken(authToken), userId }]);
    await db.insert(workspaces).values([
      { id: workspaceId, name: `ws-${suffix}`, orgId },
      { id: `${workspaceId}-local`, name: `ws-local-${suffix}`, orgId, executionMode: "local" },
    ]);
  });

  afterAll(async () => {
    await db.delete(runs).where(eq(runs.id, `run-local-${suffix}`));
    await db.delete(runs).where(eq(runs.id, `run-spec-${suffix}`));
    await db.delete(runs).where(eq(runs.id, `run-remote-${suffix}`));
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.workspaceId, workspaceId));
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.workspaceId, `${workspaceId}-local`));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, `${workspaceId}-local`));
    await db.delete(apiTokens).where(eq(apiTokens.token, authToken));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
    _dedup(true);
    if (priorAllowPrivateUrls === undefined) {
      delete process.env.TERRENCE_ALLOW_PRIVATE_URLS;
    } else {
      process.env.TERRENCE_ALLOW_PRIVATE_URLS = priorAllowPrivateUrls;
    }
  });

  it("skips delivery for local-execution workspaces", async () => {
    const configId = crypto.randomUUID();
    const runId = `run-local-${suffix}`;
    try {
      await db.insert(notificationConfigurations).values({
        id: configId,
        workspaceId: `${workspaceId}-local`,
        name: `Local ${suffix}`,
        destinationType: "generic",
        url: "http://127.0.0.1:1",
        triggers: ["run:completed"],
        enabled: true,
      });
      await db.insert(runs).values({
        id: runId,
        workspaceId: `${workspaceId}-local`,
        status: "completed",
        message: "local execution run",
        createdBy: userId,
        createdAt: Date.now(),
      });
      _dedup(true);
      const deliveries = await deliverRunNotifications(runId, "run:completed", "completed");
      expect(deliveries).toEqual([]);
    } finally {
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, configId));
      await db.delete(runs).where(eq(runs.id, runId));
    }
  });

  it("skips delivery for speculative runs", async () => {
    const configId = crypto.randomUUID();
    const runId = `run-spec-${suffix}`;
    const cvId = `cv-${suffix}`;
    try {
      await db.insert(notificationConfigurations).values({
        id: configId,
        workspaceId,
        name: `Spec ${suffix}`,
        destinationType: "generic",
        url: "http://127.0.0.1:1",
        triggers: ["run:completed"],
        enabled: true,
      });
      await db.insert(configurationVersions).values({
        id: cvId,
        workspaceId,
        speculative: true,
        createdAt: Date.now(),
      });
      await db.insert(runs).values({
        id: runId,
        workspaceId,
        status: "completed",
        message: "speculative run",
        createdBy: userId,
        createdAt: Date.now(),
        configurationVersionId: cvId,
      });
      _dedup(true);
      const deliveries = await deliverRunNotifications(runId, "run:completed", "completed");
      expect(deliveries).toEqual([]);
    } finally {
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, configId));
      await db.delete(runs).where(eq(runs.id, runId));
      await db.delete(configurationVersions).where(eq(configurationVersions.id, cvId));
    }
  });

  it("still delivers for non-speculative remote-execution runs", async () => {
    const configId = crypto.randomUUID();
    const runId = `run-remote-${suffix}`;
    const cvId = `cv-remote-${suffix}`;
    try {
      await db.insert(notificationConfigurations).values({
        id: configId,
        workspaceId,
        name: `Remote ${suffix}`,
        destinationType: "generic",
        url: "http://127.0.0.1:1",
        triggers: ["run:completed"],
        enabled: true,
      });
      await db.insert(configurationVersions).values({
        id: cvId,
        workspaceId,
        speculative: false,
        createdAt: Date.now(),
      });
      await db.insert(runs).values({
        id: runId,
        workspaceId,
        status: "completed",
        message: "non-speculative remote run",
        createdBy: userId,
        createdAt: Date.now(),
        configurationVersionId: cvId,
      });
      _dedup(true);
      // Delivery should be attempted (the destination is unreachable, but a
      // delivery object is returned rather than an empty array). The run is
      // remote-execution and non-speculative, so the new suppression guards
      // must NOT short-circuit here.
      const deliveries = await deliverRunNotifications(runId, "run:completed", "completed");
      expect(deliveries).toHaveLength(1);
    } finally {
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, configId));
      await db.delete(runs).where(eq(runs.id, runId));
      await db.delete(configurationVersions).where(eq(configurationVersions.id, cvId));
    }
  });
});