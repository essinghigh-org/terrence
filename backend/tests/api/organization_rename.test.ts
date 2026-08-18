import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, githubAppInstallations, organizationMemberships,
  organizations, users, workspaces,
} from "../../src/db/schema";

/**
 * ORG-012: Organization rename invalidates name cache & preserves downstream links.
 *
 * PATCH /api/v2/organizations/:org_name updates the org name and calls
 * invalidateOrganizationName (src/routes/organizations.ts:684) so the cached
 * lookup is refreshed. Downstream resources (workspaces) are keyed by org.id,
 * so they remain accessible under the new name. This test pins that contract:
 * after a rename, GET by the new name resolves the org and its workspaces.
 */
describe("Organization rename & downstream links (ORG-012)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const token = `token-${suffix}`;
  const user = `owner-${suffix}`;

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
  const oldName = `rename-from-${suffix}`;
  const newName = `rename-to-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: user, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: oldName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token, userId });
    await db.insert(githubAppInstallations).values({
      id: ghInstallationId, orgId, name: "App", installationId: 1,
    });
    // Two workspaces: one plain, one with VCS.
    await db.insert(workspaces).values({
      id: `ws-plain-${suffix}`, orgId, name: "plain-ws",
      defaultExecutionMode: "remote", isDefaultProject: false,
    });
    await db.insert(workspaces).values({
      id: `ws-vcs-${suffix}`, orgId, name: "vcs-ws",
      defaultExecutionMode: "remote", isDefaultProject: false,
      vcsRepo: { identifier: "hashicorp/terraform", githubAppInstallationId: ghInstallationId },
    });
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, ghInstallationId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("resolves the organization by its old name before rename", async () => {
    const res = await request(`/api/v2/organizations/${oldName}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.attributes.name).toBe(oldName);
  });

  it("renames the org, invalidates name cache, & preserves downstream links", async () => {
    // Rename + cache invalidation + downstream verification in one self-contained test
    // so it does not depend on prior test execution order.
    const res = await request(`/api/v2/organizations/${oldName}`, "PATCH", {
      data: { type: "organizations", id: oldName, attributes: { name: newName } },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.attributes.name).toBe(newName);

    // Old name must no longer resolve (cache invalidated / lookup misses).
    const oldRes = await request(`/api/v2/organizations/${oldName}`);
    expect(oldRes.status).toBe(404);

    // New name must resolve immediately.
    const newRes = await request(`/api/v2/organizations/${newName}`);
    expect(newRes.status).toBe(200);
    expect((await newRes.json()).data.attributes.name).toBe(newName);

    // Downstream workspaces remain accessible under the new org name.
    const wsRes = await request(`/api/v2/organizations/${newName}/workspaces`);
    expect(wsRes.status).toBe(200);
    const names = (await wsRes.json()).data.map((w: { attributes: { name: string } }) => w.attributes.name).sort();
    expect(names).toEqual(["plain-ws", "vcs-ws"].sort());

    // The VCS workspace must still carry its repo identifier (org.id-keyed, not name-keyed).
    const vcsWs = await request(`/api/v2/organizations/${newName}/workspaces/vcs-ws`);
    expect(vcsWs.status).toBe(200);
    const wsBody = await vcsWs.json();
    expect(wsBody.data.attributes["vcs-repo"].identifier).toBe("hashicorp/terraform");
    expect(wsBody.data.attributes["vcs-repo"]["github-app-installation-id"]).toBe(ghInstallationId);
  });
});
