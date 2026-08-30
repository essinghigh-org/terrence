import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
  adminSettings,
  user2FA,
} from "../../src/db/schema";
import { invalidateSettingsCache } from "../../src/lib/settings";
import { decryptSecret, isEncryptedSecret } from "../../src/lib/secrets";

describe("Admin Operations API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `adminuser-${suffix}`;
  const orgId = `adminorg-${suffix}`;
  const orgName = `admin-org-${suffix}`;
  const token = `admin-token-${suffix}`;
  const workspaceId = `admin-ws-${suffix}`;
  const activeRunId = `admin-active-run-${suffix}`;
  const finishedRunId = `admin-finished-run-${suffix}`;
  const unscopedAdminId = `unscoped-admin-${suffix}`;
  const unscopedAdminToken = `unscoped-admin-token-${suffix}`;
  const isolatedOrgId = `isolated-org-${suffix}`;
  const isolatedOrgName = `isolated-org-${suffix}`;
  const isolatedWorkspaceId = `isolated-workspace-${suffix}`;

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
    await db.insert(users).values([
      { id: userId, username: userId, passwordHash: "unused", isSiteAdmin: true },
      { id: unscopedAdminId, username: unscopedAdminId, passwordHash: "unused", isSiteAdmin: true },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: isolatedOrgId, name: isolatedOrgName },
    ]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    // Token stored as hash
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: tokenHash, userId },
      { id: crypto.randomUUID(), token: createHash("sha256").update(unscopedAdminToken).digest("hex"), userId: unscopedAdminId },
    ]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId }]);
    await db.insert(workspaces).values([{ id: isolatedWorkspaceId, name: `isolated-ws-${suffix}`, orgId: isolatedOrgId }]);
    await db.insert(runs).values([
      {
        id: activeRunId,
        workspaceId,
        status: "planning",
        message: "Admin-visible active run",
        createdAt: Date.now(),
      },
      {
        id: finishedRunId,
        workspaceId,
        status: "applied",
        message: "Finished run",
        createdAt: Date.now(),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(runs).where(eq(runs.workspaceId, isolatedWorkspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, isolatedWorkspaceId));
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.delete(apiTokens).where(eq(apiTokens.token, tokenHash));
    await db.delete(apiTokens).where(eq(apiTokens.token, createHash("sha256").update(unscopedAdminToken).digest("hex")));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, isolatedOrgId));
    await db.delete(users).where(eq(users.username, userId));
    await db.delete(users).where(eq(users.username, unscopedAdminId));
  });

  it("lists site admin resources and active runs", async () => {
    // 1. Admin Users list
    const getUsersRes = await request("/api/v2/admin/users");
    expect(getUsersRes.status).toBe(200);
    const getUsersBody = await getUsersRes.json();
    expect(getUsersBody.data.some((u: any) => u.id === userId)).toBeTrue();

    // 2. Admin Single User show
    const getUserRes = await request(`/api/v2/admin/users/${userId}`);
    expect(getUserRes.status).toBe(200);
    const getUserBody = await getUserRes.json();
    expect(getUserBody.data.attributes.username).toBe(userId);

    // 3. Admin Organizations list (admin org resource id == org name, matching
    // go-tfe's AdminOrganization primary field)
    const getOrgsRes = await request("/api/v2/admin/organizations");
    expect(getOrgsRes.status).toBe(200);
    const getOrgsBody = await getOrgsRes.json();
    expect(getOrgsBody.data.some((o: any) => o.id === orgName)).toBeTrue();

    // 4. Admin Workspaces list
    const getWsRes = await request("/api/v2/admin/workspaces");
    expect(getWsRes.status).toBe(200);
    const getWsBody = await getWsRes.json();
    expect(getWsBody.data.some((w: any) => w.id === workspaceId)).toBeTrue();

    // 5. Admin active runs list
    const getRunsRes = await request("/api/v2/admin/runs");
    expect(getRunsRes.status).toBe(200);
    const getRunsBody = await getRunsRes.json();
    const activeRun = getRunsBody.data.find((run: Readonly<{ id: string }>): boolean => run.id === activeRunId);
    expect(activeRun?.attributes).toMatchObject({
      status: "planning",
      message: "Admin-visible active run",
      actions: {
        "is-cancelable": true,
        "is-force-cancelable": true,
      },
    });
    expect(getRunsBody.data.some((run: Readonly<{ id: string }>): boolean => run.id === finishedRunId)).toBeFalse();

    // 6. Admin Terraform versions - create, list, show, update, delete
    const createTfRes = await request("/api/v2/admin/terraform-versions", "POST", {
      data: { attributes: { version: "1.10.5", url: "https://releases.hashicorp.com/terraform/1.10.5/terraform_1.10.5_linux_amd64.zip", deprecated: false } },
    });
    expect(createTfRes.status).toBe(201);
    const tfVersionId = (await createTfRes.json()).data.id;

    const getTfVerRes = await request("/api/v2/admin/terraform-versions");
    expect(getTfVerRes.status).toBe(200);
    const getTfVerBody = await getTfVerRes.json();
    expect(getTfVerBody.data.length).toBeGreaterThan(0);

    // Show specific version
    const showTfRes = await request(`/api/v2/admin/terraform-versions/${tfVersionId}`);
    expect(showTfRes.status).toBe(200);
    const showTfBody = await showTfRes.json();
    expect(showTfBody.data.attributes.version).toBe("1.10.5");

    // Update version
    const patchTfRes = await request(`/api/v2/admin/terraform-versions/${tfVersionId}`, "PATCH", {
      data: { attributes: { deprecated: true } },
    });
    expect(patchTfRes.status).toBe(200);
    expect((await patchTfRes.json()).data.attributes.deprecated).toBeTrue();

    // Delete version
    const delTfRes = await request(`/api/v2/admin/terraform-versions/${tfVersionId}`, "DELETE");
    expect(delTfRes.status).toBe(204);

    // 7. Admin Sentinel versions CRUD
    const createSRes = await request("/api/v2/admin/sentinel-versions", "POST", {
      data: { attributes: { version: "0.24.0" } },
    });
    expect(createSRes.status).toBe(201);
    const sId = (await createSRes.json()).data.id;

    const getSRes = await request("/api/v2/admin/sentinel-versions");
    expect(getSRes.status).toBe(200);
    expect((await getSRes.json()).data.length).toBeGreaterThan(0);

    const delSRes = await request(`/api/v2/admin/sentinel-versions/${sId}`, "DELETE");
    expect(delSRes.status).toBe(204);

    // 8. Admin OPA versions CRUD
    const opaVer = `0.68.0-${suffix}`;
    const createORes = await request("/api/v2/admin/opa-versions", "POST", {
      data: { attributes: { version: opaVer } },
    });
    expect(createORes.status).toBe(201);
    const opaId = (await createORes.json()).data.id;

    const getORes = await request("/api/v2/admin/opa-versions");
    expect(getORes.status).toBe(200);
    expect((await getORes.json()).data.length).toBeGreaterThan(0);

    // Clean up
    await request(`/api/v2/admin/opa-versions/${opaId}`, "DELETE");
  });


  it("supports admin user management: create, promote, suspend, delete", async () => {
    const newUserId = `admin-created-${crypto.randomUUID()}`;

    // 1. Admin creates a new user
    const createRes = await request("/api/v2/admin/users", "POST", {
      data: {
        type: "users",
        attributes: {
          username: newUserId,
          email: `${newUserId}@example.com`,
          password: "password12345",
        },
      },
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.data.attributes.username).toBe(newUserId);
    expect(createBody.data.attributes.email).toBe(`${newUserId}@example.com`);

    // 2. Created user can be found in admin list
    const listRes = await request(`/api/v2/admin/users?q=${newUserId}`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.length).toBeGreaterThan(0);
    const matched = listBody.data.find((u: any) => u.attributes.username === newUserId);
    expect(matched).toBeDefined();
    expect(matched.attributes["is-site-admin"]).toBeFalse();

    // Site admins can recover an account when its authenticator is lost.
    await db.insert(user2FA).values({ userId: createBody.data.id, secret: "test-secret", enabled: true });
    const mfaResetRes = await request(`/api/v2/admin/users/${createBody.data.id}/actions/disable_two_factor`, "POST");
    expect(mfaResetRes.status).toBe(200);
    expect(await db.query.user2FA.findFirst({ where: eq(user2FA.userId, createBody.data.id) })).toBeUndefined();

    // 3. Promote to site admin
    const promoteRes = await request(`/api/v2/admin/users/${createBody.data.id}/actions/grant_admin`, "POST");
    expect(promoteRes.status).toBe(200);
    const promoteBody = await promoteRes.json();
    expect(promoteBody.data.attributes["is-site-admin"]).toBeTrue();

    // 4. Suspend user
    const suspendRes = await request(`/api/v2/admin/users/${createBody.data.id}/actions/suspend`, "POST");
    expect(suspendRes.status).toBe(200);
    const suspendBody = await suspendRes.json();
    expect(suspendBody.data.attributes["is-suspended"]).toBeTrue();

    // 5. Unsuspend user
    const unsuspendRes = await request(`/api/v2/admin/users/${createBody.data.id}/actions/unsuspend`, "POST");
    expect(unsuspendRes.status).toBe(200);
    const unsuspendBody = await unsuspendRes.json();
    expect(unsuspendBody.data.attributes["is-suspended"]).toBeFalse();

    // 6. Delete user
    const delRes = await request(`/api/v2/admin/users/${createBody.data.id}`, "DELETE");
    expect(delRes.status).toBe(204);

    // 7. Verify user is gone
    const getRes = await request(`/api/v2/admin/users/${createBody.data.id}`);
    expect(getRes.status).toBe(404);
  });

  it("persists general settings and issues scoped, expiring impersonation tokens", async () => {
    const targetId = `impersonation-target-${crypto.randomUUID()}`;
    await db.insert(users).values({ id: targetId, username: targetId, passwordHash: "unused", isSiteAdmin: false });
    const setting = await request("/api/v2/admin/general-settings", "PATCH", {
      data: { attributes: { "api-rate-limit": 77 } },
    });
    expect(setting.status).toBe(200);
    expect((await setting.json()).data.attributes["api-rate-limit"]).toBe(77);
    const stored = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "general") });
    expect(stored?.values["api-rate-limit"]).toBe(77);

    const impersonate = await request(`/api/v2/admin/users/${targetId}/actions/impersonate`, "POST");
    expect(impersonate.status).toBe(200);
    const tokenValue = (await impersonate.json()).data.attributes.token as string;
    const tokenHash = hashAuthenticationToken(tokenValue);
    const issued = await db.query.apiTokens.findFirst({ where: eq(apiTokens.token, tokenHash) });
    expect(issued?.userId).toBe(targetId);
    expect(issued?.expiresAt).toBeGreaterThan(Date.now());
    await db.delete(apiTokens).where(eq(apiTokens.token, tokenHash));
    await db.delete(users).where(eq(users.id, targetId));
  });

  it("preserves unrelated concurrent site settings patches", async () => {
    const original = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "site") });
    const settingsQuery = db.query.adminSettings as unknown as {
      findFirst: (config?: unknown) => Promise<typeof original>;
    };
    const originalFindFirst = settingsQuery.findFirst;
    let siteReads = 0;
    let releaseSecondRead!: () => void;
    const secondRead = new Promise<void>((resolve): void => { releaseSecondRead = resolve; });
    settingsQuery.findFirst = async (config?: unknown): Promise<typeof original> => {
      const row = await originalFindFirst.call(settingsQuery, config);
      if (row?.id !== "site") return row;
      siteReads += 1;
      if (siteReads === 1) await Promise.race([secondRead, Bun.sleep(100)]);
      else if (siteReads === 2) releaseSecondRead();
      return row;
    };
    try {
      const initialValues = { ...(original?.values ?? {}), "concurrency-base": "base" };
      await db.insert(adminSettings).values({ id: "site", values: initialValues, updatedAt: Date.now() })
        .onConflictDoUpdate({ target: adminSettings.id, set: { values: initialValues, updatedAt: Date.now() } });
      invalidateSettingsCache();
      const [left, right] = await Promise.all([
        request("/api/v2/admin/settings", "PATCH", { data: { attributes: { "concurrency-left": "left" } } }),
        request("/api/v2/admin/settings", "PATCH", { data: { attributes: { "concurrency-right": "right" } } }),
      ]);
      expect(left.status).toBe(200);
      expect(right.status).toBe(200);
      invalidateSettingsCache();
      const stored = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "site") });
      expect(stored?.values["concurrency-base"]).toBe("base");
      expect(stored?.values["concurrency-left"]).toBe("left");
      expect(stored?.values["concurrency-right"]).toBe("right");
    } finally {
      settingsQuery.findFirst = originalFindFirst;
      if (original === undefined) {
        await db.delete(adminSettings).where(eq(adminSettings.id, "site"));
      } else {
        await db.update(adminSettings).set({ values: original.values, updatedAt: original.updatedAt })
          .where(eq(adminSettings.id, "site"));
      }
      invalidateSettingsCache();
    }
  });

  it("never returns cost, Twilio, or SMTP credential material from admin settings", async () => {
    const originalCost = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "cost") });
    const originalTwilio = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "twilio") });
    const originalSmtp = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "smtp") });
    const forgedInfracost = `enc:v1:${Buffer.alloc(12).toString("base64")}:${Buffer.alloc(16).toString("base64")}:plaintext-cost-secret`;
    try {
      const costPatch = await request("/api/v2/admin/cost-estimation-settings", "PATCH", {
        data: {
          attributes: {
            "infracost-api-key": forgedInfracost,
            "aws-access-key-id": "AKIA-secret",
            "aws-secret-key": "secret-aws",
            "gcp-credentials": { client_email: "cost@example.com", private_key: "gcp-private-key" },
            "azure-client-secret": "secret-azure",
          },
        },
      });
      expect(costPatch.status).toBe(200);
      const costGet = await request("/api/v2/admin/cost-estimation-settings");
      const costAttributes = (await costGet.json()).data.attributes as Record<string, unknown>;
      expect(costAttributes["infracost-api-key"]).toBeUndefined();
      expect(costAttributes["aws-secret-key"]).toBeUndefined();
      expect(costAttributes["infracost-api-key-set"]).toBeTrue();
      expect(costAttributes["aws-access-key-id-set"]).toBeTrue();
      const storedCost = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "cost") });
      const storedCostValues = storedCost?.values ?? {};
      for (const key of ["infracost-api-key", "aws-secret-key", "gcp-credentials", "azure-client-secret"]) {
        const value = storedCostValues[key];
        expect(typeof value).toBe("string");
        expect(isEncryptedSecret(value as string)).toBeTrue();
      }
      expect(await decryptSecret(storedCostValues["infracost-api-key"] as string)).toBe(forgedInfracost);
      expect(await decryptSecret(storedCostValues["aws-secret-key"] as string)).toBe("secret-aws");
      expect(JSON.parse(await decryptSecret(storedCostValues["gcp-credentials"] as string))).toEqual({
        client_email: "cost@example.com",
        private_key: "gcp-private-key",
      });
      expect(await decryptSecret(storedCostValues["azure-client-secret"] as string)).toBe("secret-azure");

      const twilioPatch = await request("/api/v2/admin/twilio-settings", "PATCH", {
        data: { attributes: { "auth-token": "secret-twilio" } },
      });
      expect(twilioPatch.status).toBe(200);
      const twilioGet = await request("/api/v2/admin/twilio-settings");
      const twilioAttributes = (await twilioGet.json()).data.attributes as Record<string, unknown>;
      expect(twilioAttributes["auth-token"]).toBeUndefined();
      expect(twilioAttributes["auth-token-set"]).toBeTrue();
      const storedTwilio = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "twilio") });
      const storedAuthToken = storedTwilio?.values["auth-token"];
      expect(typeof storedAuthToken).toBe("string");
      expect(isEncryptedSecret(storedAuthToken as string)).toBeTrue();
      expect(await decryptSecret(storedAuthToken as string)).toBe("secret-twilio");

      const smtpPatch = await request("/api/v2/admin/smtp-settings", "PATCH", {
        data: { attributes: { enabled: true, host: "smtp.example.com", password: "secret-smtp" } },
      });
      expect(smtpPatch.status).toBe(200);
      const smtpAttributes = (await smtpPatch.json()).data.attributes as Record<string, unknown>;
      expect(smtpAttributes.password).toBeUndefined();
      expect(smtpAttributes["password-set"]).toBeTrue();
      const storedSmtp = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "smtp") });
      const storedSmtpPassword = storedSmtp?.values.password;
      expect(typeof storedSmtpPassword).toBe("string");
      expect(isEncryptedSecret(storedSmtpPassword as string)).toBeTrue();
      expect(await decryptSecret(storedSmtpPassword as string)).toBe("secret-smtp");
    } finally {
      if (originalCost === undefined) await db.delete(adminSettings).where(eq(adminSettings.id, "cost"));
      else await db.update(adminSettings).set({ values: originalCost.values, updatedAt: originalCost.updatedAt }).where(eq(adminSettings.id, "cost"));
      if (originalTwilio === undefined) await db.delete(adminSettings).where(eq(adminSettings.id, "twilio"));
      else await db.update(adminSettings).set({ values: originalTwilio.values, updatedAt: originalTwilio.updatedAt }).where(eq(adminSettings.id, "twilio"));
      if (originalSmtp === undefined) await db.delete(adminSettings).where(eq(adminSettings.id, "smtp"));
      else await db.update(adminSettings).set({ values: originalSmtp.values, updatedAt: originalSmtp.updatedAt }).where(eq(adminSettings.id, "smtp"));
      invalidateSettingsCache();
    }
  });

  it("requires an explicit SMTP transport policy and preserves port-465 TLS defaults", async () => {
    const originalSmtp = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "smtp") });
    try {
      await db.delete(adminSettings).where(eq(adminSettings.id, "smtp"));
      invalidateSettingsCache();

      const defaults = await request("/api/v2/admin/smtp-settings");
      expect(defaults.status).toBe(200);
      expect((await defaults.json()).data.attributes.encryption).toBe("starttls");

      const invalid = await request("/api/v2/admin/smtp-settings", "PATCH", {
        data: { attributes: { encryption: "opportunistic" } },
      });
      expect(invalid.status).toBe(422);

      const plaintext = await request("/api/v2/admin/smtp-settings", "PATCH", {
        data: { attributes: { encryption: "plain" } },
      });
      expect(plaintext.status).toBe(200);
      expect((await plaintext.json()).data.attributes.encryption).toBe("plain");

      await db.update(adminSettings).set({ values: { port: 465 }, updatedAt: Date.now() }).where(eq(adminSettings.id, "smtp"));
      invalidateSettingsCache();
      const legacyPort465 = await request("/api/v2/admin/smtp-settings");
      expect(legacyPort465.status).toBe(200);
      expect((await legacyPort465.json()).data.attributes.encryption).toBe("tls");
    } finally {
      if (originalSmtp === undefined) await db.delete(adminSettings).where(eq(adminSettings.id, "smtp"));
      else await db.update(adminSettings).set({ values: originalSmtp.values, updatedAt: originalSmtp.updatedAt }).where(eq(adminSettings.id, "smtp"));
      invalidateSettingsCache();
    }
  });

  it("gives a site admin full access without an organization membership", async () => {
    const list = await request("/api/v2/organizations", "GET", undefined, unscopedAdminToken);
    expect(list.status).toBe(200);
    expect((await list.json()).data.some((organization: { id: string }) => organization.id === isolatedOrgName)).toBeTrue();

    const show = await request(`/api/v2/organizations/${isolatedOrgName}`, "GET", undefined, unscopedAdminToken);
    expect(show.status).toBe(200);

    const deleteWorkspace = await request(`/api/v2/organizations/${isolatedOrgName}/workspaces/isolated-ws-${suffix}`, "DELETE", undefined, unscopedAdminToken);
    expect(deleteWorkspace.status).toBe(204);

    const deleteOrganization = await request(`/api/v2/organizations/${isolatedOrgName}`, "DELETE", undefined, unscopedAdminToken);
    expect(deleteOrganization.status).toBe(204);

    const deleteAdminWorkspace = await request(`/api/v2/admin/workspaces/${workspaceId}`, "DELETE", undefined, unscopedAdminToken);
    expect(deleteAdminWorkspace.status).toBe(204);
    expect(await db.query.runs.findFirst({ where: eq(runs.id, activeRunId) })).toBeUndefined();

    const deleteAdminOrganization = await request(`/api/v2/admin/organizations/${orgName}`, "DELETE", undefined, unscopedAdminToken);
    expect(deleteAdminOrganization.status).toBe(204);
    expect((await request(`/api/v2/admin/organizations/${orgName}`, "GET", undefined, unscopedAdminToken)).status).toBe(404);
  });
});
