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

  it("returns 401 when uploading without authentication (isAuth guard)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${cvId}/upload`, { method: "PUT" }),
    );
    expect(res.status).toBe(401);
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

describe("Security Regression — CORS Defaults", () => {
  it("does not expose a hardcoded origin or reflect arbitrary origins without a configured allow-list", async () => {
    const previous = process.env.CORS_ORIGIN;
    delete process.env.CORS_ORIGIN;
    try {
      // A non-allowlisted origin must NOT receive an access-control-allow-origin
      // header — neither the (removed) localhost hardcode nor the origin itself.
      const response = await app.handle(new Request("http://localhost/api/v2/ping", {
        headers: { Origin: "https://malicious.example" },
      }));
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previous;
    }
  });

  it("reflects an origin that is explicitly allow-listed in CORS_ORIGIN", async () => {
    const previous = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = "https://app.example,https://dev.example";
    try {
      const response = await app.handle(new Request("http://localhost/api/v2/ping", {
        headers: { Origin: "https://dev.example" },
      }));
      expect(response.headers.get("access-control-allow-origin")).toBe("https://dev.example");
    } finally {
      if (previous === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previous;
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

describe("Security Headers — document shell (CSP, clickjacking, referrer, robots)", () => {
  it("applies the browser-security headers to responses", async () => {
    const res = await app.handle(new Request("http://localhost/api/v2/ping"));
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("base-uri 'none'");
    // userResource emits Gravatar avatar URLs — the CSP must allow them.
    expect(res.headers.get("content-security-policy")).toContain("https://www.gravatar.com");
    expect(res.headers.get("content-security-policy")).toContain("https://secure.gravatar.com");
    // VCS-triggered runs emit GitHub sender/committer avatars.
    expect(res.headers.get("content-security-policy")).toContain("https://avatars.githubusercontent.com");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
    expect(res.headers.get("permissions-policy")).not.toContain("clipboard");
  });

  it("serves control-plane API responses with Cache-Control: no-store", async () => {
    const res = await app.handle(new Request("https://localhost/api/v2/ping"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the SPA entry page with no-cache revalidation", async () => {
    // Skip when the frontend bundle isn't built in this environment (CI builds
    // dist before the API suite runs; local runs may not have it).
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    if (!existsSync(join(import.meta.dir, "../../../frontend/dist/index.html"))) return;
    const res = await app.handle(new Request("http://localhost/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-cache");
  });
});

describe("Security Regression — CORS Vary: Origin", () => {
  const previous = process.env.CORS_ORIGIN;

  it("reflects a matching origin and advertises Vary: Origin", async () => {
    process.env.CORS_ORIGIN = "https://app.example,https://dev.example";
    try {
      const res = await app.handle(new Request("http://localhost/api/v2/ping", {
        headers: { Origin: "https://app.example" },
      }));
      expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
      expect(res.headers.get("vary")).toContain("Origin");
    } finally {
      restore();
    }
  });

  it("does not reflect a non-allowlisted origin but still varries by Origin", async () => {
    process.env.CORS_ORIGIN = "https://app.example";
    try {
      const res = await app.handle(new Request("http://localhost/api/v2/ping", {
        headers: { Origin: "https://evil.example" },
      }));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("vary")).toContain("Origin");
    } finally {
      restore();
    }
  });

  it("advertises Vary: Origin when CORS is configured even with no Origin header", async () => {
    process.env.CORS_ORIGIN = "https://app.example";
    try {
      const res = await app.handle(new Request("http://localhost/api/v2/ping"));
      expect(res.headers.get("vary")).toContain("Origin");
    } finally {
      restore();
    }
  });

  function restore(): void {
    if (previous === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = previous;
  }
});
