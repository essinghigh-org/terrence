import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  apiTokens,
  notificationConfigurations,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";
import { _breakerState, _dedup, _resetSharedDeliveryState, deliverRunNotifications } from "../../src/lib/notifications";

describe("Notification circuit breaker & dedup (kanban 7.8 / 7.9)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const organizationName = `ntf-sweep-${suffix}`;
  const workspaceId = `ws-ntf-${suffix}`;

  // Same auth token pattern as ssh_notifications.test.ts (unused by the direct
  // deliver* calls below, but kept for parity with the notification fixtures).
  const authToken = `user-token-${suffix}`;

  beforeAll(async () => {
    process.env.TERRENCE_ALLOW_PRIVATE_URLS = "true";
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: organizationName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token: authToken, userId }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId }]);
    _dedup(true);
    await _resetSharedDeliveryState();
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.token, authToken));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
    _dedup(true);
    await _resetSharedDeliveryState();
  });

  it("7.8 tripped circuit breaker skips delivery to a dead destination", async () => {
    // A URL that returns 503 forever (Bun.serve on a free port).
    let calls = 0;
    const deadWebhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls += 1;
        return new Response("boom", { status: 503 });
      },
    });
    const configId = crypto.randomUUID();
    const deadRunId = `run-dead-${suffix}-${crypto.randomUUID()}`;
    try {
      await db.insert(notificationConfigurations).values({
        id: configId,
        workspaceId,
        name: `Dead ${suffix}`,
        destinationType: "generic",
        url: deadWebhook.url.toString(),
        triggers: ["run:errored"],
        enabled: true,
      });
      await db.insert(runs).values({
        id: deadRunId,
        workspaceId,
        status: "errored",
        message: "breaker trigger",
        createdBy: userId,
        createdAt: Date.now(),
      });

      // Three consecutive failed deliveries trip the breaker (each delivery
      // makes BREAKER_FAILURE_LIMIT internal HTTP attempts, all failing).
      for (let i = 0; i < 3; i += 1) {
        const delivery = await deliverRunNotifications(deadRunId, "run:errored", `errored-${i}`);
        expect(delivery).toHaveLength(1);
        expect(delivery[0]?.successful).toBeFalse();
        expect(delivery[0]?.attempts ?? 0).toBe(3);
      }
      expect(_breakerState(configId).open).toBeTrue();
      expect(_breakerState(configId).failures).toBe(3);
      expect(calls).toBe(9); // 3 deliveries × 3 attempts

      // Fourth delivery: the breaker is open, so NO HTTP call happens.
      const tripped = await deliverRunNotifications(deadRunId, "run:errored", "tripped");
      expect(tripped).toHaveLength(1);
      expect(tripped[0]?.successful).toBeFalse();
      expect(tripped[0]?.attempts).toBe(0);
      expect(calls).toBe(9); // unchanged: short-circuited before fetch
    } finally {
      await deadWebhook.stop(true);
      await db.delete(runs).where(eq(runs.id, deadRunId));
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, configId));
    }
  });

  it("7.8 a successful delivery resets the failure count", async () => {
    let serving = 0;
    const flakyWebhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        serving += 1;
        // Fail two full deliveries (6 HTTP attempts), then recover.
        return serving <= 6 ? new Response("down", { status: 503 }) : new Response(null, { status: 204 });
      },
    });
    const configId = crypto.randomUUID();
    const flakyRunId = `run-flaky-${suffix}-${crypto.randomUUID()}`;
    try {
      await db.insert(notificationConfigurations).values({
        id: configId,
        workspaceId,
        name: `Flaky ${suffix}`,
        destinationType: "generic",
        url: flakyWebhook.url.toString(),
        triggers: ["run:errored"],
        enabled: true,
      });
      await db.insert(runs).values({
        id: flakyRunId,
        workspaceId,
        status: "errored",
        message: "breaker reset",
        createdBy: userId,
        createdAt: Date.now(),
      });

      // Two failed deliveries accumulate failures.
      await deliverRunNotifications(flakyRunId, "run:errored");
      expect(_breakerState(configId).failures).toBe(1);
      await deliverRunNotifications(flakyRunId, "run:errored", "canceled");
      expect(_breakerState(configId).failures).toBe(2);
      expect(_breakerState(configId).open).toBeFalse();

      // The destination recovers: one successful delivery resets to zero and
      // the breaker never opens.
      const recovered = await deliverRunNotifications(flakyRunId, "run:errored", "failed");
      expect(recovered[0]?.successful).toBeTrue();
      const state = _breakerState(configId);
      expect(state.open).toBeFalse();
      expect(state.failures).toBe(0);
    } finally {
      await flakyWebhook.stop(true);
      await db.delete(runs).where(eq(runs.id, flakyRunId));
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, configId));
    }
  });

  it("7.9 repeated status writes do not emit duplicate logical notifications within the window", async () => {
    let deliveries = 0;
    const webhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        deliveries += 1;
        return new Response(null, { status: 204 });
      },
    });
    const configId = crypto.randomUUID();
    const runId = `run-dedup-${suffix}-${crypto.randomUUID()}`;
    try {
      await db.insert(notificationConfigurations).values({
        id: configId,
        workspaceId,
        name: `Dedup ${suffix}`,
        destinationType: "generic",
        url: webhook.url.toString(),
        triggers: ["run:errored"],
        enabled: true,
      });
      await db.insert(runs).values({
        id: runId,
        workspaceId,
        status: "errored",
        message: "dedup trigger",
        createdBy: userId,
        createdAt: Date.now(),
      });

      _dedup(true);
      await _resetSharedDeliveryState();
      // Same (run, trigger, status) twice in a row → deduped on second call.
      const first = await deliverRunNotifications(runId, "run:errored");
      const second = await deliverRunNotifications(runId, "run:errored");
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0); // duplicate suppressed
      expect(deliveries).toBe(1);

      // A different status override (canceled vs errored) is a distinct
      // logical notification and must still be emitted.
      const third = await deliverRunNotifications(runId, "run:errored", "canceled");
      expect(third).toHaveLength(1);
      expect(deliveries).toBe(2);
    } finally {
      await webhook.stop(true);
      await db.delete(runs).where(eq(runs.id, runId));
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, configId));
    }
  });
});
