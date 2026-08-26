import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  adminSettings,
  apiTokens,
  notificationConfigurations,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";
import { invalidateSettingsCache } from "../../src/lib/settings";
import { deliverRunNotifications } from "../../src/lib/notifications";

describe("Email notification configurations (API + SMTP delivery)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `email-org-${suffix}`;
  const token = `user-token-${suffix}`;
  const workspaceId = `ws-email-${suffix}`;
  const runId = `run-email-${suffix}`;
  const runId2 = `run-email2-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  /** Minimal SMTP server capturing the delivered message. */
  let smtpServer: { port: number; stop(force?: boolean): void } | undefined;
  let smtpPort = 0;
  let received: string[] = [];

  beforeAll(async () => {
    smtpServer = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket: import("bun").Socket): void {
          socket.write("220 test-smtp ready\r\n");
        },
        data(socket: import("bun").Socket, chunk: Uint8Array): void {
          const text = chunk.toString();
          for (const rawLine of text.split("\r\n")) {
            if (rawLine === "") continue;
            const line = rawLine.trim();
            if (line === ".") {
              socket.write("250 accepted\r\n");
            } else if (line.startsWith("EHLO")) {
              socket.write("250-test-smtp\r\n250 AUTH PLAIN\r\n");
            } else if (line === "STARTTLS") {
              socket.write("502 STARTTLS not supported\r\n");
            } else if (line.startsWith("AUTH PLAIN")) {
              socket.write("235 authenticated\r\n");
            } else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) {
              socket.write("250 ok\r\n");
            } else if (line === "DATA") {
              socket.write("354 end with .\r\n");
            } else if (line === "QUIT") {
              socket.write("221 bye\r\n");
            } else {
              received.push(line);
            }
          }
        },
      },
    });
    smtpPort = smtpServer.port;

    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token, userId }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-email-${suffix}`, orgId }]);
    await db.insert(runs).values([{
      id: runId,
      workspaceId,
      status: "completed",
      message: "email delivery test",
      createdBy: userId,
      createdAt: Date.now(),
    }, {
      id: runId2,
      workspaceId,
      status: "completed",
      message: "email delivery test two",
      createdBy: userId,
      createdAt: Date.now(),
    }]);
  });

  afterAll(async () => {
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.workspaceId, workspaceId));
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(runs).where(eq(runs.id, runId2));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(adminSettings).where(eq(adminSettings.id, "smtp"));
    await db.delete(users).where(eq(users.username, userId));
    invalidateSettingsCache();
    smtpServer?.stop(true);
  });

  const emailPayload = (attributes: Record<string, unknown>): unknown => ({
    data: {
      type: "notification-configurations",
      attributes: {
        name: "drift",
        "destination-type": "email",
        triggers: ["run:completed"],
        ...attributes,
      },
    },
  });

  it("creates an email configuration with email-addresses and no url", async () => {
    const response = await request(
      `/api/v2/workspaces/${workspaceId}/notification-configurations`,
      "POST",
      emailPayload({ "email-addresses": ["alice@example.com", "bob@example.com"] }),
    );
    expect(response.status).toBe(201);
    const body = await response.json() as { data: { id: string; attributes: Record<string, unknown> } };
    expect(body.data.attributes["email-addresses"]).toEqual(["alice@example.com", "bob@example.com"]);
    expect(body.data.attributes["destination-type"]).toBe("email");
  });

  it("rejects an email configuration without email-addresses", async () => {
    const response = await request(
      `/api/v2/workspaces/${workspaceId}/notification-configurations`,
      "POST",
      emailPayload({}),
    );
    expect(response.status).toBe(422);
    const body = await response.json() as { errors: { source?: { pointer?: string } }[] };
    expect(body.errors.some((error) => error.source?.pointer === "/data/attributes/email-addresses")).toBe(true);
  });

  it("rejects an email configuration with an invalid address", async () => {
    const response = await request(
      `/api/v2/workspaces/${workspaceId}/notification-configurations`,
      "POST",
      emailPayload({ "email-addresses": ["not-an-email"] }),
    );
    expect(response.status).toBe(422);
  });

  it("still requires a url for generic destinations", async () => {
    const response = await request(
      `/api/v2/workspaces/${workspaceId}/notification-configurations`,
      "POST",
      {
        data: {
          type: "notification-configurations",
          attributes: { name: "webhook", "destination-type": "generic", triggers: ["run:created"] },
        },
      },
    );
    expect(response.status).toBe(422);
  });

  it("updates email-addresses via PATCH", async () => {
    const created = await (await request(
      `/api/v2/workspaces/${workspaceId}/notification-configurations`,
      "POST",
      emailPayload({ "email-addresses": ["alice@example.com"] }),
    )).json() as { data: { id: string } };
    const response = await request(`/api/v2/notification-configurations/${created.data.id}`, "PATCH", {
      data: { type: "notification-configurations", attributes: { "email-addresses": ["carol@example.com"] } },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes["email-addresses"]).toEqual(["carol@example.com"]);
  });

  it("records an unsuccessful delivery when SMTP is not configured", async () => {
    invalidateSettingsCache();
    await db.delete(adminSettings).where(eq(adminSettings.id, "smtp"));
    await db.insert(notificationConfigurations).values([{
      id: `nc-email-nosmtp-${suffix}`,
      workspaceId,
      name: "no-smtp",
      destinationType: "email",
      url: "",
      emailAddresses: ["alice@example.com"],
      triggers: ["run:completed"],
      enabled: true,
      createdAt: Date.now(),
    }]);
    const deliveries = await deliverRunNotifications(runId, "run:completed", "completed");
    const delivery = deliveries.find((item) => item.url === "" && item.body.startsWith("Email delivery skipped"));
    expect(delivery).toBeDefined();
    expect(delivery?.successful).toBe(false);
    expect(delivery?.body).toContain("SMTP is disabled");
  });

  it("delivers a run notification via SMTP end to end", async () => {
    invalidateSettingsCache();
    await db.delete(adminSettings).where(eq(adminSettings.id, "smtp"));
    await db.insert(adminSettings).values([{
      id: "smtp",
      values: {
        enabled: true,
        host: "127.0.0.1",
        port: smtpPort,
        username: "terrence",
        password: "test-pass",
        "sender-email": "terrence@example.com",
        auth: "plain",
      },
      updatedAt: Date.now(),
    }]);
    received = [];
    await db.insert(notificationConfigurations).values([{
      id: `nc-email-smtp-${suffix}`,
      workspaceId,
      name: "with-smtp",
      destinationType: "email",
      url: "",
      emailAddresses: ["alice@example.com"],
      triggers: ["run:completed"],
      enabled: true,
      createdAt: Date.now(),
    }]);

    const deliveries = await deliverRunNotifications(runId2, "run:completed", "completed");
    const delivery = deliveries.find((item) => item.successful);
    expect(delivery).toBeDefined();
    expect(delivery?.body).toContain("Sent to alice@example.com");

    expect(received).toContain("From: terrence@example.com");
    expect(received).toContain("To: alice@example.com");
    expect(received.some((line) => line.startsWith("Subject:") && line.includes("Run Completed"))).toBe(true);
    expect(received.some((line) => line.includes("Run: " + runId2))).toBe(true);
  });
});
