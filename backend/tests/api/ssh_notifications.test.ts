import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  notificationDeliveries,
  notificationDestinations,
  notificationRules,
  notificationTemplates,
  organizationMemberships,
  organizations,
  projects,
  sshKeys,
  users,
  workspaces,
} from "../../src/db/schema";

describe("SSH Keys & Notification API contract", () => {
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
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token, userId }]);
    await db.insert(projects).values([{ id: projectId, orgId, name: `project-${suffix}` }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId, projectId }]);
  });

  afterAll(async () => {
    await db.delete(notificationDeliveries).where(eq(notificationDeliveries.orgId, orgId));
    await db.delete(notificationRules).where(eq(notificationRules.orgId, orgId));
    await db.delete(notificationTemplates).where(eq(notificationTemplates.orgId, orgId));
    await db.delete(notificationDestinations).where(eq(notificationDestinations.orgId, orgId));
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
          value: "[REDACTED PRIVATE KEY]",
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

  it("creates, lists, updates and deletes notification destinations", async () => {
    // 1. Create a slack destination
    const createRes = await request(`/api/v2/organizations/${orgName}/notification-destinations`, "POST", {
      data: {
        attributes: {
          name: "Production Alerts",
          type: "slack",
          config: { token: "xoxb-123", channel: "#alerts" },
        },
      },
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    const destId = createBody.data.id;
    expect(createBody.data.attributes.name).toBe("Production Alerts");
    expect(createBody.data.attributes.type).toBe("slack");
    // Secret fields are masked in API responses
    expect(createBody.data.attributes.config.token).toBeNull();

    // 2. List destinations
    const listRes = await request(`/api/v2/organizations/${orgName}/notification-destinations`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.some((d: any) => d.id === destId)).toBeTrue();

    // 3. Update the destination (disable it)
    const patchRes = await request(`/api/v2/organizations/${orgName}/notification-destinations/${destId}`, "PATCH", {
      data: { attributes: { enabled: false } },
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.data.attributes.enabled).toBeFalse();

    // 4. Invalid config is rejected
    const badRes = await request(`/api/v2/organizations/${orgName}/notification-destinations`, "POST", {
      data: {
        attributes: {
          name: "Bad",
          type: "discord",
          config: { webhookUrl: "https://example.com/not-discord" },
        },
      },
    });
    expect(badRes.status).toBe(422);

    // 5. Delete
    const deleteRes = await request(`/api/v2/organizations/${orgName}/notification-destinations/${destId}`, "DELETE");
    expect(deleteRes.status).toBe(204);
    const afterDelete = await db.query.notificationDestinations.findFirst({ where: eq(notificationDestinations.id, destId) });
    expect(afterDelete).toBeUndefined();
  });

  it("creates, lists, updates and deletes notification rules with tag filters", async () => {
    // destination + template first
    const destRes = await request(`/api/v2/organizations/${orgName}/notification-destinations`, "POST", {
      data: {
        attributes: { name: "Rule Dest", type: "apprise-custom", config: { url: "json://rule" } },
      },
    });
    const destId = (await destRes.json()).data.id;
    const tplRes = await request(`/api/v2/organizations/${orgName}/notification-templates`, "POST", {
      data: {
        attributes: {
          name: "Apply Failed",
          "event-type": "workspace.apply.failed",
          "title-template": "Apply Failed: {{workspace.name}}",
          "body-template": "Error: {{run.message}}",
        },
      },
    });
    expect(tplRes.status).toBe(201);
    const tplId = (await tplRes.json()).data.id;

    // 1. Create rule
    const createRes = await request(`/api/v2/organizations/${orgName}/notification-rules`, "POST", {
      data: {
        attributes: {
          name: "Prod apply failures",
          "event-type": "workspace.apply.failed",
          "workspace-tag-filters": [{ key: "environment", value: "production" }],
          "destination-id": destId,
          "template-id": tplId,
        },
      },
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    const ruleId = createBody.data.id;
    expect(createBody.data.attributes["workspace-tag-filters"]).toEqual([
      { key: "environment", value: "production" },
    ]);
    expect(createBody.data.attributes["template-id"]).toBe(tplId);

    // 2. List
    const listRes = await request(`/api/v2/organizations/${orgName}/notification-rules`);
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).data.some((r: any) => r.id === ruleId)).toBeTrue();

    // 3. Update: invalid event type rejected
    const badRes = await request(`/api/v2/organizations/${orgName}/notification-rules/${ruleId}`, "PATCH", {
      data: { attributes: { "event-type": "bogus.event" } },
    });
    expect(badRes.status).toBe(422);

    // 4. Delete rule + template
    const deleteRuleRes = await request(`/api/v2/organizations/${orgName}/notification-rules/${ruleId}`, "DELETE");
    expect(deleteRuleRes.status).toBe(204);
    const deleteTplRes = await request(`/api/v2/organizations/${orgName}/notification-templates/${tplId}`, "DELETE");
    expect(deleteTplRes.status).toBe(204);
    await db.delete(notificationDestinations).where(eq(notificationDestinations.id, destId));
  });

  it("test endpoint reports a failed delivery for an unreachable apprise URL", async () => {
    const createRes = await request(`/api/v2/organizations/${orgName}/notification-destinations`, "POST", {
      data: {
        attributes: { name: "Broken", type: "apprise-custom", config: { url: "not-a-valid-scheme://" } },
      },
    });
    const destId = (await createRes.json()).data.id;
    try {
      const testRes = await request(`/api/v2/organizations/${orgName}/notification-destinations/${destId}/test`, "POST");
      expect(testRes.status).toBe(200);
      const testBody = await testRes.json();
      expect(testBody.data.attributes.successful).toBeFalse();
      expect(testBody.data.attributes.error).not.toBeNull();
    } finally {
      await db.delete(notificationDestinations).where(eq(notificationDestinations.id, destId));
    }
  });
});
