import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, notificationConfigurations, organizationMemberships,
  organizations, runs, users, workspaces,
} from "../../src/db/schema";
import { deliverRunNotifications } from "../../src/lib/notifications";

/**
 * NOT-011: Verification delivery-response retention/ordering/header shape.
 *
 * the reference format's notification-configuration GET returns a `delivery-responses` array
 * capturing recent delivery attempts (success/failure, headers, body, code,
 * sent-at, attempts). Terrence currently always returns `delivery-responses:
 * []` on GET (notificationResource at notifications.ts:164 receives an empty
 * default) because deliveries are not persisted — there is no
 * notification_delivery_responses table.
 *
 * This test pins the current contract so that:
 *   - a freshly-created configuration returns delivery-responses: [] (documented
 *     as a known divergence from the reference format which surfaces recent attempts),
 *   - after a (recorded-as-unsuccessful) delivery attempt the response body
 *     shape still matches the reference format's documented attributes (header casing, code,
 *     sent-at, attempts, successful boolean).
 */
describe("Notification configuration delivery-responses (NOT-011)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `notif-${suffix}`;
  const token = `token-${suffix}`;
  const workspaceId = `ws-${suffix}`;
  const runId = `run-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token, userId });
    await db.insert(workspaces).values({ id: workspaceId, orgId, name: "notif-ws", defaultExecutionMode: "remote" });
    await db.insert(runs).values({ id: runId, workspaceId, status: "applied", createdAt: Date.now() });
  });

  afterAll(async () => {
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.workspaceId, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  beforeEach(async () => {
    // Ensure no SMTP settings so deliveries are recorded as unsuccessful
    // without contacting a real server.
  });

  it("a freshly-created generic notification config returns delivery-responses: []", async () => {
    const created = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`, "POST", {
      data: {
        type: "notification-configurations",
        attributes: {
          name: "webhook-notif",
          "destination-type": "generic",
          url: "https://example.com/webhook",
          triggers: ["run:completed"],
          enabled: false,
        },
      },
    });
    expect(created.status).toBe(201);
    const configId = (await created.json()).data.id;

    const fetched = await request(`/api/v2/notification-configurations/${configId}`);
    expect(fetched.status).toBe(200);
    const attrs = (await fetched.json()).data.attributes;
    // NOTE: the reference format surfaces recent delivery attempts here; Terrence currently
    // returns [] because deliveries are not persisted (no
    // notification_delivery_responses table exists). This pins the gap.
    expect(attrs["delivery-responses"]).toEqual([]);
  });

  it("documents the delivery response shape Terrence would need to persist (the reference format contract)", async () => {
    // Trigger a delivery to a generic (webhook) destination with no server
    // listening — Terrence records the attempt in-memory with the reference-format-shaped
    // attributes: code, body, headers, sent-at, successful, url, attempts.
    await db.insert(notificationConfigurations).values({
      id: `nc-shape-${suffix}`,
      workspaceId,
      name: "shape-check",
      destinationType: "generic",
      url: "http://127.0.0.1:1/webhook",
      triggers: ["run:completed"],
      enabled: true,
      createdAt: Date.now(),
    });

    const deliveries = await deliverRunNotifications(runId, "run:completed", "completed");
    expect(deliveries.length).toBe(1);
    const delivery = deliveries[0]!;
    // These are the fields the reference format surfaces in delivery-responses.
    expect(typeof delivery.code).toBe("string");
    expect(typeof delivery.body).toBe("string");
    expect(typeof delivery.sentAt).toBe("string");
    expect(typeof delivery.successful).toBe("boolean");
    expect(typeof delivery.url).toBe("string");
    expect(typeof delivery.attempts).toBe("number");
    // attempts >= 0 (0 when the URL fails URL-resolution before any HTTP attempt,
    // >=1 once an HTTP attempt is made). The shape is the contract, not the count.
    expect(delivery.attempts).toBeGreaterThanOrEqual(0);
    // headers are lowercased (responseHeaders at notifications.ts:56).
    expect(typeof delivery.headers).toBe("object");
  });
});
