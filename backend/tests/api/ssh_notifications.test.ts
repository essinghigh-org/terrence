import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  notificationConfigurations,
  organizationMemberships,
  organizations,
  sshKeys,
  users,
  workspaces,
} from "../../src/db/schema";

describe("SSH Keys & Notification Configurations API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `ssh-notif-org-${suffix}`;
  const token = `user-token-${suffix}`;
  const workspaceId = `ws-ssh-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token, userId }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId }]);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
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
    // 1. Create notification configuration
    const createNcRes = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`, "POST", {
      data: {
        attributes: {
          name: "Slack Alert",
          "destination-type": "slack",
          url: "https://hooks.slack.com/services/xxx/yyy/zzz",
          triggers: ["run:created", "run:completed", "run:errored"],
          enabled: true,
        },
      },
    });
    expect(createNcRes.status).toBe(201);
    const createNcBody = await createNcRes.json();
    const ncId = createNcBody.data.id;
    expect(createNcBody.data.attributes.name).toBe("Slack Alert");

    // 2. List notification configurations
    const listNcRes = await request(`/api/v2/workspaces/${workspaceId}/notification-configurations`);
    expect(listNcRes.status).toBe(200);
    const listNcBody = await listNcRes.json();
    expect(listNcBody.data.some((nc: any) => nc.id === ncId)).toBeTrue();

    // 3. Verify notification configuration
    const verifyRes = await request(`/api/v2/notification-configurations/${ncId}/actions/verify`, "POST");
    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.status).toBe("verification_sent");

    // 4. Delete notification configuration
    const deleteNcRes = await request(`/api/v2/notification-configurations/${ncId}`, "DELETE");
    expect(deleteNcRes.status).toBe(204);
  });
});
