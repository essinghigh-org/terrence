import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, notificationConfigurations, organizationMemberships,
  organizations, users, workspaces,
} from "../../src/db/schema";
import { RUN_NOTIFICATION_TRIGGERS } from "../../src/lib/constants";

/**
 * NOT-003 / NOT-004: default `enabled` and `triggers` must match the reference
 * format. A freshly-created notification configuration defaults to enabled=true
 * and to the standard run-trigger set when neither is supplied.
 *
 * Email destinations skip ownership verification regardless of `enabled`, so we
 * use them to exercise the *defaults* path without needing a reachable webhook.
 */
describe("Notification configuration defaults (NOT-003 / NOT-004)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `notif-defaults-${suffix}`;
  const token = `token-${suffix}`;
  const workspaceId = `ws-${suffix}`;

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
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "x" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: `m-${suffix}`, userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId });
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.workspaceId, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("defaults enabled=true and triggers to the standard run set when omitted", async () => {
    const created = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`, "POST", {
      data: {
        type: "notification-configurations",
        attributes: {
          name: "defaults-notif",
          "destination-type": "email",
          "email-addresses": ["ops@example.com"],
        },
      },
    });
    expect(created.status).toBe(201);
    const id = (await created.json()).data.id;

    const fetched = await request(`/api/v2/notification-configurations/${id}`);
    expect(fetched.status).toBe(200);
    const attrs = (await fetched.json()).data.attributes;
    expect(attrs.enabled).toBe(true);
    expect(attrs.triggers).toEqual([...RUN_NOTIFICATION_TRIGGERS]);
  });

  it("honors an explicitly supplied triggers list", async () => {
    const created = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`, "POST", {
      data: {
        type: "notification-configurations",
        attributes: {
          name: "explicit-notif",
          "destination-type": "email",
          "email-addresses": ["ops@example.com"],
          triggers: ["run:errored"],
        },
      },
    });
    expect(created.status).toBe(201);
    const id = (await created.json()).data.id;

    const fetched = await request(`/api/v2/notification-configurations/${id}`);
    const attrs = (await fetched.json()).data.attributes;
    expect(attrs.triggers).toEqual(["run:errored"]);
    expect(attrs.enabled).toBe(true);
  });
});