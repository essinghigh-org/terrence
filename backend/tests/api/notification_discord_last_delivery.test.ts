import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
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

// Issue #633: Discord destinations render embeds, and the last delivery
// outcome (success or failure) surfaces on the configuration resource.
describe("Notification Discord template and last-delivery surface", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `discord-org-${suffix}`;
  const token = `user-token-${suffix}`;
  const workspaceId = `ws-discord-${suffix}`;
  const previousAllowPrivate = process.env["TERRENCE_ALLOW_PRIVATE_URLS"];

  let echoServer: ReturnType<typeof Bun.serve> | undefined;
  let echoBodies: string[] = [];

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + auth,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    process.env["TERRENCE_ALLOW_PRIVATE_URLS"] = "true";
    echoServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        echoBodies.push(await req.text());
        return new Response(null, { status: 204 });
      },
    });
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token: createHash("sha256").update(token).digest("hex"), userId }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-discord-${suffix}`, orgId }]);
  });

  afterAll(async () => {
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.token, createHash("sha256").update(token).digest("hex")));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
    await echoServer?.stop(true);
    if (previousAllowPrivate === undefined) delete process.env["TERRENCE_ALLOW_PRIVATE_URLS"];
    else process.env["TERRENCE_ALLOW_PRIVATE_URLS"] = previousAllowPrivate;
  });

  async function createConfig(url: string): Promise<string> {
    const res = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`, "POST", {
      data: {
        type: "notification-configurations",
        attributes: {
          name: `Discord ${suffix}`,
          "destination-type": "discord",
          url,
          triggers: ["run:errored"],
          enabled: true,
        },
      },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  it("accepts discord configs and reports an unknown last delivery", async () => {
    const ncId = await createConfig((echoServer!).url.toString());
    try {
      const show = await request(`/api/v2/notification-configurations/${ncId}`);
      expect(show.status).toBe(200);
      const attrs = ((await show.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes;
      expect(attrs["destination-type"]).toBe("discord");
      expect(attrs["last-delivery"]).toBeNull();
    } finally {
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, ncId));
    }
  });

  it("posts the fixture as Discord embeds and records the success", async () => {
    const ncId = await createConfig((echoServer!).url.toString());
    try {
      echoBodies = [];
      const verifyRes = await request(`/api/v2/notification-configurations/${ncId}/actions/verify`, "POST");
      expect(verifyRes.status).toBe(200);
      expect(echoBodies).toHaveLength(1);
      const posted = JSON.parse(echoBodies[0] ?? "{}") as { content?: string; embeds?: { title?: string }[] };
      expect(typeof posted.content).toBe("string");
      expect(posted.embeds?.[0]?.title).toBe("Run Errored");

      const show = await request(`/api/v2/notification-configurations/${ncId}`);
      const last = ((await show.json()) as { data: { attributes: { "last-delivery": { successful: boolean; code: string } } } }).data.attributes["last-delivery"];
      expect(last.successful).toBe(true);
    } finally {
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, ncId));
    }
  });

  it("records failed deliveries for the workspace tab", async () => {
    const ncId = await createConfig("http://127.0.0.1:1/closed");
    try {
      const verifyRes = await request(`/api/v2/notification-configurations/${ncId}/actions/verify`, "POST");
      expect(verifyRes.status).toBe(400);
      const show = await request(`/api/v2/notification-configurations/${ncId}`);
      const last = ((await show.json()) as { data: { attributes: { "last-delivery": { successful: boolean; code: string; error: string | null } } } }).data.attributes["last-delivery"];
      expect(last.successful).toBe(false);
      expect(typeof last.error).toBe("string");
    } finally {
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, ncId));
    }
  });
});
