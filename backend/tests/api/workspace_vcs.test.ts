import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, githubAppInstallations, organizationMemberships,
  organizations, users, workspaces,
} from "../../src/db/schema";

/**
 * VCS-001 / VCS-002 / VCS-003: Workspace VCS repository normalization.
 *
 * `normalizeVcsRepo` (src/routes/workspaces.ts:239) enforces the the reference format VCS contract:
 *   - identifier is required,
 *   - at least one of github-app-installation-id or oauth-token-id is required,
 *   - githubAppInstallations must be registered in the org,
 *   - oauthTokens must be registered in the org,
 *   - tags-regex must be <=256 chars and non-pathological.
 * These tests pin each rejection path and the happy-path acceptance so the
 * serializer (kebab-case) stays aligned with the the reference format API shape.
 */
describe("Workspace VCS repo normalization (VCS-001/002/003)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `vcs-${suffix}`;
  const token = `token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const ghInstallationId = `ghain-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token, userId });
    await db.insert(githubAppInstallations).values({
      id: ghInstallationId, orgId, name: "Test App", installationId: 1,
    });
  });

  afterAll(async () => {
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, ghInstallationId));
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("rejects a vcs-repo without an identifier", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: { name: "no-id-ws", "vcs-repo": { "github-app-installation-id": ghInstallationId } },
      },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors[0].detail).toBe("Repository identifier is required");
  });

  it("rejects a vcs-repo without any credential (installation or oauth-token)", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: { name: "no-creds-ws", "vcs-repo": { identifier: "hashicorp/terraform" } },
      },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors[0].detail).toBe("A GitHub App installation or OAuth token is required");
  });

  it("rejects a github-app-installation-id not registered in the org", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: { name: "unknown-install-ws", "vcs-repo": { identifier: "hashicorp/terraform", "github-app-installation-id": "ghain-nope" } },
      },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors[0].detail).toBe("GitHub App installation is not registered in this organization");
  });

  it("rejects a pathological (catastrophic backtracking) tags-regex", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: {
          name: "evil-regex-ws",
          "vcs-repo": {
            identifier: "hashicorp/terraform",
            "github-app-installation-id": ghInstallationId,
            "tags-regex": "(a+)+$",
          },
        },
      },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors[0].detail).toBe("tags-regex must be a valid, non-pathological regular expression");
  });

  it("accepts a valid vcs-repo with a registered github-app-installation-id", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: {
          name: "valid-vcs-ws",
          "vcs-repo": {
            identifier: "hashicorp/terraform",
            branch: "main",
            "github-app-installation-id": ghInstallationId,
          },
        },
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.attributes["vcs-repo"].identifier).toBe("hashicorp/terraform");
    expect(body.data.attributes["vcs-repo"]["github-app-installation-id"]).toBe(ghInstallationId);
    expect(body.data.attributes["vcs-repo"].branch).toBe("main");
  });
});
