import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  githubAppInstallations,
  oauthClients,
  organizationMemberships,
  organizations,
  projects,
  users,
  workspaces,
} from "../../src/db/schema";

describe("VCS integration gaps", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-vcs-${suffix}`;
  const orgId = `org-vcs-${suffix}`;
  const orgName = `vcs-${suffix}`;
  const crossOrgId = `org-vcs-cross-${suffix}`;
  const token = `vcs-token-${suffix}`;
  const projectIds = [`prj-vcs-one-${suffix}`, `prj-vcs-two-${suffix}`] as const;
  const crossProjectId = `prj-vcs-cross-${suffix}`;
  const installationId = `ghain-vcs-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  const createClient = (name: string, serviceProvider: string, scopedProjects: readonly string[] = []): Promise<Response> =>
    request(`/api/v2/organizations/${orgName}/oauth-clients`, "POST", {
      data: {
        type: "oauth-clients",
        attributes: { name, "service-provider": serviceProvider },
        relationships: {
          projects: {
            data: scopedProjects.map((id: string): Record<string, string> => ({ id, type: "projects" })),
          },
        },
      },
    });

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: crossOrgId, name: `cross-${orgName}` },
    ]);
    await db.insert(organizationMemberships).values({ id: `orgmem-vcs-${suffix}`, userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({
      id: `token-vcs-${suffix}`,
      token: createHash("sha256").update(token).digest("hex"),
      userId,
    });
    await db.insert(projects).values([
      { id: projectIds[0], orgId, name: `one-${suffix}` },
      { id: projectIds[1], orgId, name: `two-${suffix}` },
      { id: crossProjectId, orgId: crossOrgId, name: `cross-${suffix}` },
    ]);
    await db.insert(githubAppInstallations).values({
      id: installationId,
      orgId,
      name: `installation-${suffix}`,
      installationId: Math.floor(Math.random() * 1_000_000_000),
    });
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, installationId));
    await db.delete(oauthClients).where(eq(oauthClients.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(projects).where(eq(projects.orgId, orgId));
    await db.delete(projects).where(eq(projects.orgId, crossOrgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, crossOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("validates and identifies all specified service providers", async () => {
    const azureResponse = await createClient(`azure-${suffix}`, "azure_devops_server");
    expect(azureResponse.status).toBe(201);
    const azure = await azureResponse.json();
    expect(azure.data.attributes["service-provider-display-name"]).toBe("Azure DevOps Server");

    const patchResponse = await request(`/api/v2/oauth-clients/${azure.data.id}`, "PATCH", {
      data: { attributes: { "service-provider": "bitbucket_data_center" } },
    });
    expect(patchResponse.status).toBe(200);
    const patched = await patchResponse.json();
    expect(patched.data.attributes).toMatchObject({
      "service-provider": "bitbucket_data_center",
      "service-provider-display-name": "Bitbucket Data Center",
    });

    const invalidPatch = await request(`/api/v2/oauth-clients/${azure.data.id}`, "PATCH", {
      data: { attributes: { "service-provider": "invented_vcs" } },
    });
    expect(invalidPatch.status).toBe(422);
    const shown = await (await request(`/api/v2/oauth-clients/${azure.data.id}`)).json();
    expect(shown.data.attributes["service-provider"]).toBe("bitbucket_data_center");

    expect((await createClient(`invalid-${suffix}`, "invented_vcs")).status).toBe(422);
    expect((await request(`/api/v2/organizations/${orgName}/oauth-clients`, "POST", {
      data: { attributes: { name: `wrong-type-${suffix}`, "service-provider": 42 } },
    })).status).toBe(422);
  });

  test("creates, replaces, attaches, and detaches project scope", async () => {
    const createResponse = await createClient(`scoped-${suffix}`, "github", [projectIds[0]]);
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const clientId = created.data.id as string;
    expect(created.data.relationships.projects.data).toEqual([
      { id: projectIds[0], type: "projects" },
    ]);

    expect((await request(`/api/v2/oauth-clients/${clientId}/relationships/projects`, "POST", {
      data: [{ id: projectIds[1], type: "projects" }],
    })).status).toBe(204);
    let shown = await (await request(`/api/v2/oauth-clients/${clientId}`)).json();
    expect(shown.data.relationships.projects.data.map((item: { id: string }): string => item.id).sort()).toEqual([...projectIds].sort());

    expect((await request(`/api/v2/oauth-clients/${clientId}/relationships/projects`, "DELETE", {
      data: [{ id: projectIds[0], type: "projects" }],
    })).status).toBe(204);
    shown = await (await request(`/api/v2/oauth-clients/${clientId}`)).json();
    expect(shown.data.relationships.projects.data).toEqual([{ id: projectIds[1], type: "projects" }]);

    const replaceResponse = await request(`/api/v2/oauth-clients/${clientId}`, "PATCH", {
      data: {
        relationships: {
          projects: { data: [{ id: projectIds[0], type: "projects" }] },
        },
      },
    });
    expect(replaceResponse.status).toBe(200);
    const replaced = await replaceResponse.json();
    expect(replaced.data.relationships.projects.data).toEqual([{ id: projectIds[0], type: "projects" }]);

    expect((await request(`/api/v2/oauth-clients/${clientId}/relationships/projects`, "POST", {
      data: [{ id: crossProjectId, type: "projects" }],
    })).status).toBe(422);
    expect((await request(`/api/v2/oauth-clients/${clientId}/relationships/projects`, "POST", {
      data: [{ id: projectIds[1], type: "workspaces" }],
    })).status).toBe(422);
  });

  test("persists and updates complete workspace VCS repository settings", async () => {
    const workspaceName = `tagged-vcs-${suffix}`;
    const createResponse = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: {
          name: workspaceName,
          "vcs-repo": {
            identifier: "example/infrastructure",
            branch: "release",
            "github-app-installation-id": installationId,
            "ingress-submodules": true,
            "tags-regex": "^v\\d+\\.\\d+\\.\\d+$",
          },
        },
      },
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.data.attributes["vcs-repo"]).toMatchObject({
      identifier: "example/infrastructure",
      branch: "release",
      githubAppInstallationId: installationId,
      ingressSubmodules: true,
      tagsRegex: "^v\\d+\\.\\d+\\.\\d+$",
    });

    const patchResponse = await request(`/api/v2/workspaces/${created.data.id}`, "PATCH", {
      data: {
        type: "workspaces",
        attributes: {
          "vcs-repo": { "tags-regex": "^release-" },
        },
      },
    });
    expect(patchResponse.status).toBe(200);
    const patched = await patchResponse.json();
    expect(patched.data.attributes["vcs-repo"]).toMatchObject({
      identifier: "example/infrastructure",
      githubAppInstallationId: installationId,
      tagsRegex: "^release-",
    });

    const invalidResponse = await request(`/api/v2/workspaces/${created.data.id}`, "PATCH", {
      data: { attributes: { "vcs-repo": { "tags-regex": "[" } } },
    });
    expect(invalidResponse.status).toBe(422);
    const persisted = await db.query.workspaces.findFirst({ where: eq(workspaces.id, created.data.id) });
    expect(persisted?.vcsRepo?.tagsRegex).toBe("^release-");
  });
});
