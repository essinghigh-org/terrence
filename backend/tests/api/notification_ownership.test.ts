import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  notificationConfigurations,
  organizationMemberships,
  organizations,
  users,
  workspaces,
} from "../../src/db/schema";

describe("Notification destination ownership verification API (kanban 7.7)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `own-org-${suffix}`;
  const token = `user-token-${suffix}`;
  const workspaceId = `ws-own-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  let echoServer: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    process.env.TERRENCE_ALLOW_PRIVATE_URLS = "true";
    echoServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const parsed = await req.json() as { ownership_challenge?: string };
        return new Response(null, { status: 204, headers: { "X-Terrence-Ownership-Challenge": parsed.ownership_challenge ?? "" } });
      },
    });
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token, userId }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-own-${suffix}`, orgId }]);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
    await echoServer?.stop(true);
  });

  it("verifies ownership when the destination echoes the challenge, and reports it", async () => {
    const createRes = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`, "POST", {
      data: {
        type: "notification-configurations",
        attributes: {
          name: `Own ${suffix}`,
          "destination-type": "generic",
          url: (echoServer as ReturnType<typeof Bun.serve>).url.toString(),
          triggers: ["run:errored"],
          enabled: true,
        },
      },
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    const ncId = createBody.data.id as string;
    try {
      // Initially unverified.
      const before = await request(`/api/v2/notification-configurations/${ncId}/ownership-verified`);
      expect(before.status).toBe(200);
      expect((await before.json()).data.ownership_verified).toBe(false);

      // Successful challenge/echo handshake.
      const verifyRes = await request(`/api/v2/notification-configurations/${ncId}/actions/verify-ownership`, "POST");
      expect(verifyRes.status).toBe(200);
      expect((await verifyRes.json()).data.ownership_verified).toBe(true);

      // Reported verified afterward.
      const after = await request(`/api/v2/notification-configurations/${ncId}/ownership-verified`);
      expect((await after.json()).data.ownership_verified).toBe(true);
    } finally {
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, ncId));
    }
  });

  it("returns 400 when the destination does not echo the challenge", async () => {
    const deadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    const createRes = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`, "POST", {
      data: {
        type: "notification-configurations",
        attributes: {
          name: `NoEcho ${suffix}`,
          "destination-type": "generic",
          url: deadServer.url.toString(),
          triggers: ["run:errored"],
          enabled: true,
        },
      },
    });
    expect(createRes.status).toBe(201);
    const ncId = (await createRes.json()).data.id as string;
    try {
      const verifyRes = await request(`/api/v2/notification-configurations/${ncId}/actions/verify-ownership`, "POST");
      expect(verifyRes.status).toBe(400);
      const body = await verifyRes.json();
      expect(body.errors?.[0]?.title).toBe("Ownership Not Verified");
      expect(body.errors?.[0]?.ownership_verified).toBe(false);
    } finally {
      await deadServer.stop(true);
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, ncId));
    }
  });
});