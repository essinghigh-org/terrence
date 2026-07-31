import { describe, expect, it, beforeEach } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  users, workspaces, configurationVersions, apiTokens, organizations, organizationMemberships,
} from "../../src/db/schema";
import { createHash } from "node:crypto";

describe("Security Regression — Configuration Version Upload Authorization", () => {
  let adminToken: string;
  let readOnlyToken: string;
  let workspaceId: string;
  let cvId: string;

  beforeEach(async () => {
    await db.delete(configurationVersions);
    await db.delete(workspaces);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(apiTokens);
    await db.delete(users);

    const suffix = crypto.randomUUID();

    // Site admin user
    const adminId = `admin-${suffix}`;
    adminToken = `admin-token-${suffix}`;
    await db.insert(users).values([{ id: adminId, username: `admin-${suffix}`, passwordHash: "h", isSiteAdmin: true }]);
    await db.insert(apiTokens).values([{
      id: `tok-admin-${suffix}`, token: createHash("sha256").update(adminToken).digest("hex"),
      userId: adminId,
    }]);

    // Regular user (no plan permission by default)
    const readOnlyId = `ro-${suffix}`;
    readOnlyToken = `ro-token-${suffix}`;
    await db.insert(users).values([{ id: readOnlyId, username: `ro-${suffix}`, passwordHash: "h", isSiteAdmin: false }]);
    await db.insert(apiTokens).values([{
      id: `tok-ro-${suffix}`, token: createHash("sha256").update(readOnlyToken).digest("hex"),
      userId: readOnlyId,
    }]);

    // Org + membership + workspace
    const orgId = `org-${suffix}`;
    await db.insert(organizations).values([{ id: orgId, name: `org-${suffix}` }]);
    await db.insert(organizationMemberships).values([{ id: `om-admin-${suffix}`, userId: adminId, orgId }]);
    await db.insert(organizationMemberships).values([{ id: `om-ro-${suffix}`, userId: readOnlyId, orgId }]);
    workspaceId = `ws-${suffix}`;
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId }]);

    // Pending configuration version
    cvId = `cv-${crypto.randomUUID()}`;
    await db.insert(configurationVersions).values([{
      id: cvId, workspaceId, status: "pending", createdAt: Date.now(),
    }]);
  });

  it("returns 404 when uploading without authentication (no auth = 404, not 401, because the handler lacks an isAuth guard)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${cvId}/upload`, { method: "PUT" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when uploading with a read-only user (no plan permission)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${cvId}/upload`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${readOnlyToken}` },
        body: Buffer.from("test"),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 when uploading with a user that has plan permission (site admin)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${cvId}/upload`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${adminToken}` },
        body: Buffer.from("test"),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 413 when upload exceeds 100 MiB limit", async () => {
    const largeBody = Buffer.alloc(101 * 1024 * 1024, "x");
    const res = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${cvId}/upload`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${adminToken}` },
        body: largeBody,
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe("Security Regression — Signup Disabled by Default", () => {
  const previous = process.env.TERRENCE_ENABLE_LOCAL_SIGNUP;

  it("returns signup-enabled: false from /api/v2/ping when signup is not enabled", async () => {
    delete process.env.TERRENCE_ENABLE_LOCAL_SIGNUP;
    try {
      const res = await app.handle(new Request("http://localhost/api/v2/ping"));
      const body = await res.json() as { "signup-enabled": boolean };
      expect(body["signup-enabled"]).toBe(false);
    } finally {
      if (previous !== undefined) process.env.TERRENCE_ENABLE_LOCAL_SIGNUP = previous;
    }
  });

  it("returns 403 when posting to /api/v2/users without TERRENCE_ENABLE_LOCAL_SIGNUP", async () => {
    delete process.env.TERRENCE_ENABLE_LOCAL_SIGNUP;
    try {
      const res = await app.handle(
        new Request("http://localhost/api/v2/users", {
          method: "POST",
          headers: { "Content-Type": "application/vnd.api+json" },
          body: JSON.stringify({
            data: { type: "users", attributes: { username: "newuser", password: "password-12345" } },
          }),
        }),
      );
      expect(res.status).toBe(403);
    } finally {
      if (previous !== undefined) process.env.TERRENCE_ENABLE_LOCAL_SIGNUP = previous;
    }
  });
});

describe("Security Regression — VCS Webhooks Fail Closed", () => {
  it("returns 401 when GitHub webhook secret is not configured", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "refs/heads/main" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when GitLab webhook secret is not configured", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/webhooks/gitlab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "refs/heads/main" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when Bitbucket webhook secret is not configured", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/webhooks/bitbucket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ push: { changes: [{ new: { type: "branch", name: "main" } }] } }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
