import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  notificationConfigurations,
  organizationMemberships,
  organizations,
  projects,
  runs,
  sshKeys,
  users,
  workspaces,
} from "../../src/db/schema";
import { decryptSecret, isEncryptedSecret } from "../../src/lib/secrets";
import { deliverRunNotifications } from "../../src/lib/notifications";

describe("SSH Keys & Notification Configurations API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `ssh-notif-org-${suffix}`;
  const token = `user-token-${suffix}`;
  const workspaceId = `ws-ssh-${suffix}`;
  const projectId = `prj-notif-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    process.env.TERRENCE_ALLOW_PRIVATE_URLS = "true";
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token: hashAuthenticationToken(token), userId }]);
    await db.insert(projects).values([{ id: projectId, orgId, name: `project-${suffix}` }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId, projectId }]);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("creates, lists, updates SSH keys and assigns to workspace", async () => {
    // 1. Create SSH Key
    const createKeyRes = await request(`/api/v2/organizations/${orgName}/ssh-keys`, "POST", {
      data: {
        attributes: {
          name: "deploy-key",
          value: "-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQ...\n-----END RSA PRIVATE KEY-----",
        },
      },
    });
    expect(createKeyRes.status).toBe(201);
    const createKeyBody = await createKeyRes.json();
    const sshKeyId = createKeyBody.data.id;
    expect(createKeyBody.data.attributes.name).toBe("deploy-key");
    const storedKey = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) });
    expect(storedKey).toBeDefined();
    expect(storedKey?.value).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(isEncryptedSecret(storedKey?.value ?? "")).toBeTrue();
    expect(await decryptSecret(storedKey?.value ?? "")).toContain("BEGIN RSA PRIVATE KEY");

    // 2. List SSH Keys
    const listKeysRes = await request(`/api/v2/organizations/${orgName}/ssh-keys`);
    expect(listKeysRes.status).toBe(200);
    const listKeysBody = await listKeysRes.json();
    expect(listKeysBody.data.some((k: any) => k.id === sshKeyId)).toBeTrue();

    // 3. Assign SSH key to workspace
    const assignRes = await request(`/api/v2/workspaces/${workspaceId}/relationships/ssh-key`, "PATCH", {
      data: { id: sshKeyId, type: "ssh-keys" },
    });
    expect(assignRes.status).toBe(200);
    const assignBody = await assignRes.json();
    expect(assignBody.data.relationships["ssh-key"].data.id).toBe(sshKeyId);

    // 4. Unassign SSH key from workspace
    const unassignRes = await request(`/api/v2/workspaces/${workspaceId}/relationships/ssh-key`, "PATCH", {
      data: null,
    });
    expect(unassignRes.status).toBe(200);
    const unassignBody = await unassignRes.json();
    expect(unassignBody.data.relationships["ssh-key"].data).toBeNull();

    // 5. Delete SSH Key
    const deleteKeyRes = await request(`/api/v2/ssh-keys/${sshKeyId}`, "DELETE");
    expect(deleteKeyRes.status).toBe(204);
  });

  it("creates, lists, updates, verifies and deletes notification configurations", async () => {
    const deliveries: { body: string; signature: string | null }[] = [];
    let attempts = 0;
    const webhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(webhookRequest) {
        attempts += 1;
        deliveries.push({
          body: await webhookRequest.text(),
          signature: webhookRequest.headers.get("X-TFE-Notification-Signature"),
        });
        return new Response(attempts < 3 ? "retry" : "ok", { status: attempts < 3 ? 503 : 200 });
      },
    });
    let ncId = "";

    try {
      // 1. Create notification configuration. Created disabled so the
      // create-time verification-before-save probe (NOT-002) does not fire;
      // the explicit verify action below exercises the retry behaviour in
      // isolation (3 attempts: 503, 503, then 200).
      const createNcRes = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`, "POST", {
        data: {
          type: "notification-configurations",
          attributes: {
            name: "Generic Alert",
            "destination-type": "generic",
            url: webhook.url.toString(),
            token: "notification-secret",
            triggers: ["run:created", "run:completed", "run:errored"],
            enabled: false,
          },
        },
      });
      expect(createNcRes.status).toBe(201);
      const createNcBody = await createNcRes.json();
      ncId = createNcBody.data.id;
      expect(createNcBody.data.attributes.name).toBe("Generic Alert");
      expect(createNcBody.data.attributes.token).toBeNull();

      // 2. List notification configurations
      const listNcRes = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`);
      expect(listNcRes.status).toBe(200);
      const listNcBody = await listNcRes.json();
      expect(listNcBody.data.some((nc: any) => nc.id === ncId)).toBeTrue();
      expect(listNcBody.data.find((nc: any) => nc.id === ncId).attributes.token).toBeNull();

      // 3. Verify notification configuration
      const verifyRes = await request(`/api/v2/notification-configurations/${ncId}/actions/verify`, "POST");
      expect(verifyRes.status).toBe(200);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.status).toBe("verification_sent");
      expect(verifyBody.data.attributes["delivery-responses"][0].successful).toBeTrue();
      expect(attempts).toBe(3);
      for (const delivery of deliveries) {
        expect(delivery.signature).toBe(
          createHmac("sha512", "notification-secret").update(delivery.body).digest("hex"),
        );
      }

      // 4. Delete notification configuration
      const deleteNcRes = await request(`/api/v2/notification-configurations/${ncId}`, "DELETE");
      expect(deleteNcRes.status).toBe(204);
    } finally {
      await webhook.stop(true);
      if (ncId !== "") await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, ncId));
    }
  });

  // 7.10: template preview returns the exact webhook body without sending it.
  it("previews the webhook payload without posting (7.10)", async () => {
    let hits = 0;
    const webhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hits += 1;
        return new Response(null, { status: 204 });
      },
    });
    const createdIds: string[] = [];
    try {
      const createRes = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`, "POST", {
        data: {
          type: "notification-configurations",
          attributes: {
            name: `Preview ${suffix}`,
            "destination-type": "generic",
            url: webhook.url.toString(),
            triggers: ["run:errored"],
            // Disabled so the create-time verification probe (NOT-002) does not
            // hit the destination — the point of this test is that preview and
            // verify do, and only when the caller explicitly asks.
            enabled: false,
          },
        },
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json();
      const ncId = createBody.data.id as string;
      createdIds.push(ncId);

      // Preview the payload: no POST should reach the destination.
      const previewRes = await request(`/api/v2/notification-configurations/${ncId}/actions/verify?preview=true`, "POST");
      expect(previewRes.status).toBe(200);
      const previewBody = await previewRes.json();
      expect(previewBody.status).toBe("preview");
      const preview = previewBody.data.preview as Record<string, unknown>;
      expect(preview.payload_version).toBe(1);
      expect(preview.run_id).toBe("test-notification");
      expect(preview.workspace_name).toBe("sample-workspace");
      expect((preview.notifications as Record<string, unknown>[])?.[0]?.trigger).toBe("run:errored");
      // The destination must NOT have been contacted in preview mode.
      expect(hits).toBe(0);

      // A real verify still posts and reaches the destination.
      const verifyRes = await request(`/api/v2/notification-configurations/${ncId}/actions/verify`, "POST");
      expect(verifyRes.status).toBe(200);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.status).toBe("verification_sent");
      expect(hits).toBe(1);
    } finally {
      await webhook.stop(true);
      for (const id of createdIds) {
        await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, id));
      }
    }
  });

  it("delivers versioned run notifications for workspace and project configurations", async () => {
    const payloads: Record<string, any>[] = [];
    const webhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(webhookRequest) {
        payloads.push(JSON.parse(await webhookRequest.text()));
        return new Response(null, { status: 204 });
      },
    });
    const createdIds: string[] = [];
    const runId = `run-notif-${suffix}`;

    try {
      for (const [path, name] of [
        [`/api/v2/workspaces/${workspaceId}/notification-configurations`, "Workspace Alert"],
        [`/api/v2/projects/${projectId}/notification-configurations`, "Project Alert"],
      ]) {
        const response = await request(path!, "POST", {
          data: {
            type: "notification-configurations",
            attributes: {
              name,
              "destination-type": "generic",
              url: webhook.url.toString(),
              triggers: ["run:completed"],
              enabled: true,
            },
          },
        });
        const responseBody = await response.json();
        if (response.status !== 201) {
          throw new Error(`Notification create returned ${response.status}: ${JSON.stringify(responseBody)}`);
        }
        createdIds.push(responseBody.data.id);
      }

      // Creating enabled fires the reference format's verification-before-save probe once per
      // config, which posts a minimal probe body to the webhook. Those probes
      // are not the run deliveries under test, so drop them before delivering.
      payloads.length = 0;

      const projectList = await request(`/api/v2/projects/${projectId}/notification-configurations`);
      expect(projectList.status).toBe(200);
      const projectListBody = await projectList.json();
      expect(projectListBody.data).toHaveLength(1);
      expect(projectListBody.data[0].relationships.subscribable.data).toEqual({
        id: projectId,
        type: "projects",
      });

      await db.insert(runs).values({
        id: runId,
        workspaceId,
        status: "applied",
        message: "Notification delivery",
        createdBy: userId,
        createdAt: Date.now(),
      });
      const results = await deliverRunNotifications(runId, "run:completed");
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.successful)).toBeTrue();
      expect(payloads).toHaveLength(2);
      expect(payloads.every((payload) => payload.payload_version === 1)).toBeTrue();
      expect(payloads.every((payload) => payload.run_id === runId)).toBeTrue();
      expect(new Set(payloads.map((payload) => payload.notification_configuration_id))).toEqual(
        new Set(createdIds),
      );
    } finally {
      await db.delete(runs).where(eq(runs.id, runId));
      for (const id of createdIds) {
        await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, id));
      }
      await webhook.stop(true);
    }
  });

  it("does not deliver to a private URL unless the private-URL escape hatch is enabled (SSRF guard)", async () => {
    // Deliveries read the escape-hatch env at call time, so clearing it here
    // exercises the default (blocking) path regardless of what beforeAll set.
    const previous = process.env.TERRENCE_ALLOW_PRIVATE_URLS;
    process.env.TERRENCE_ALLOW_PRIVATE_URLS = "false";
    const ssrfsRunId = `run-ssrf-${crypto.randomUUID()}`;
    let configId = "";
    try {
      await db.insert(runs).values({
        id: ssrfsRunId,
        workspaceId,
        status: "applied",
        message: "SSRF guard",
        createdBy: userId,
        createdAt: Date.now(),
      });
      const configIdCrypto = `nc-ssrf-${crypto.randomUUID()}`;
      await db.insert(notificationConfigurations).values({
        id: configIdCrypto,
        workspaceId,
        projectId: null,
        name: "SSRF probe",
        destinationType: "generic",
        url: "http://127.0.0.1:9/internal",
        triggers: ["run:completed"],
        enabled: true,
        emailAddresses: null,
        emailAllMembers: false,
        emailUserIds: [],
        createdAt: Date.now(),
      });
      configId = configIdCrypto;
      const deliveries = await deliverRunNotifications(ssrfsRunId, "run:completed");
      expect(deliveries[0]).toBeDefined();
      const results = deliveries[0];
      if (results === undefined) throw new Error("expected a delivery result");
      expect(results.successful).toBeFalse();
      expect(results.code).toBe("422");
      expect(results.body).toContain("private or loopback");
    } finally {
      process.env.TERRENCE_ALLOW_PRIVATE_URLS = previous;
      await db.delete(runs).where(eq(runs.id, ssrfsRunId));
      if (configId !== "") await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, configId));
    }
  });
});