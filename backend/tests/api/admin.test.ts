import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";

describe("Admin Operations API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `adminuser-${suffix}`;
  const orgId = `adminorg-${suffix}`;
  const orgName = `admin-org-${suffix}`;
  const token = `admin-token-${suffix}`;
  const workspaceId = `admin-ws-${suffix}`;
  const activeRunId = `admin-active-run-${suffix}`;
  const finishedRunId = `admin-finished-run-${suffix}`;

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
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused", isSiteAdmin: true }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    // Token stored as hash
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token: tokenHash, userId }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId }]);
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
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.delete(apiTokens).where(eq(apiTokens.token, tokenHash));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
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

    // 3. Admin Organizations list
    const getOrgsRes = await request("/api/v2/admin/organizations");
    expect(getOrgsRes.status).toBe(200);
    const getOrgsBody = await getOrgsRes.json();
    expect(getOrgsBody.data.some((o: any) => o.id === orgId)).toBeTrue();

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
});
