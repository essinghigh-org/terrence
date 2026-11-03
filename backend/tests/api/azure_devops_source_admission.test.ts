import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  configurationVersions,
  workspaces,
  runs,
  oauthClients,
  oauthTokens,
  organizationMemberships,
  organizations,
  projects,
  stacks,
  users,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { encryptSecret } from "../../src/lib/secrets";

describe("Azure DevOps API source admission", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-${suffix}`,
    userId = `usr-${suffix}`,
    projectId = `prj-${suffix}`,
    clientId = `oc-${suffix}`,
    tokenId = `ot-${suffix}`,
    auth = `auth-${suffix}`;
  const vcs = {
    identifier: "fabrikam/Infrastructure Team/_git/platform",
    "service-provider": "ado_services",
    "oauth-token-id": tokenId,
    branch: "main",
  };
  const request = (method: string, path: string, data?: unknown): Promise<Response> =>
    app.handle(
      new Request(`http://terrence.test/api/v2${path}`, {
        method,
        headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/vnd.api+json" },
        ...(data === undefined ? {} : { body: JSON.stringify({ data }) }),
      }),
    );
  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db
      .insert(organizationMemberships)
      .values({ id: `mem-${suffix}`, orgId, userId, role: "owner", status: "active" });
    await db.insert(apiTokens).values({ id: `api-${suffix}`, userId, token: hashAuthenticationToken(auth) });
    await db.insert(projects).values({ id: projectId, orgId, name: "Azure project" });
    await db
      .insert(oauthClients)
      .values({ id: clientId, orgId, name: "Azure", serviceProvider: "ado_services", adoOrgName: "fabrikam" });
    await db
      .insert(oauthTokens)
      .values({ id: tokenId, oauthClientId: clientId, token: await encryptSecret("fixture-pat") });
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });
  test("creates and updates a Stack with an Azure DevOps Services connection", async () => {
    const created = await request("POST", "/stacks", {
      type: "stacks",
      attributes: { name: "Azure stack", "vcs-repo": vcs },
      relationships: { project: { data: { id: projectId, type: "projects" } } },
    });
    expect(created.status).toBe(201);
    const document = await created.json();
    const stackId = document.data.id as string;
    const updated = await request("PATCH", `/stacks/${stackId}`, {
      type: "stacks",
      attributes: { "vcs-repo": { ...vcs, branch: "release", "ingress-submodules": true } },
    });
    expect(updated.status).toBe(200);
    const stored = await db.query.stacks.findFirst({ where: eq(stacks.id, stackId) });
    expect(stored?.vcsServiceProvider).toBe("ado_services");
    expect(stored?.vcsBranch).toBe("release");
    expect(stored?.vcsOAuthTokenId).toBe(tokenId);
    expect(stored?.vcsIngressSubmodules).toBe(true);
    expect((await updated.json()).data.attributes["vcs-repo"]["ingress-submodules"]).toBe(true);
    const invalid = await request("PATCH", `/stacks/${stackId}`, {
      type: "stacks",
      attributes: { "vcs-repo": { ...vcs, "ingress-submodules": "true" } },
    });
    expect(invalid.status).toBe(422);
    const disabled = await request("PATCH", `/stacks/${stackId}`, {
      type: "stacks",
      attributes: { "vcs-repo": { ...vcs, "ingress-submodules": false } },
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).data.attributes["vcs-repo"]["ingress-submodules"]).toBe(false);
    await db.update(oauthClients).set({ serviceProvider: "github" }).where(eq(oauthClients.id, clientId));
    try {
      const unsupported = await request("PATCH", `/stacks/${stackId}`, {
        type: "stacks",
        attributes: { "vcs-repo": { ...vcs, "ingress-submodules": true } },
      });
      expect(unsupported.status).toBe(422);
    } finally {
      await db.update(oauthClients).set({ serviceProvider: "ado_services" }).where(eq(oauthClients.id, clientId));
    }
  });
  test("creates and updates policy sets with Azure project names containing spaces", async () => {
    const created = await request("POST", `/organizations/${orgId}/policy-sets`, {
      type: "policy-sets",
      attributes: { name: "azure-policies", kind: "sentinel", "vcs-repo": vcs },
    });
    expect(created.status).toBe(201);
    const document = await created.json();
    const updated = await request("PATCH", `/policy-sets/${document.data.id}`, {
      type: "policy-sets",
      attributes: { "vcs-repo": { ...vcs, branch: "release" } },
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.data.attributes["vcs-repo"].identifier).toBe(vcs.identifier);
    expect(body.data.attributes["vcs-repo"].branch).toBe("release");
  });
  test("classifies Azure runs as VCS and preserves the VCS archive restriction", async () => {
    const workspaceId = `ws-${suffix}`;
    const cvId = `cv-${suffix}`;
    const runId = `run-${suffix}`;
    await db.insert(workspaces).values({ id: workspaceId, orgId, name: "Azure history" });
    await db.insert(configurationVersions).values({
      id: cvId,
      workspaceId,
      source: "azure_devops",
      status: "uploaded",
      ingressAttributes: { commitSha: "a".repeat(40), branch: "main" },
    });
    await db
      .insert(runs)
      .values({ id: runId, workspaceId, configurationVersionId: cvId, status: "applied", createdAt: Date.now() });
    const vcsRuns = await request("GET", `/workspaces/${workspaceId}/runs?filter[source]=tfe-vcs`);
    expect(vcsRuns.status).toBe(200);
    const body = await vcsRuns.json();
    expect(body.data.map((run: { id: string }) => run.id)).toEqual([runId]);
    expect(body.data[0].attributes.source).toBe("azure_devops");
    const apiRuns = await request("GET", `/workspaces/${workspaceId}/runs?filter[source]=tfe-api`);
    expect((await apiRuns.json()).data).toEqual([]);
    expect((await request("POST", `/configuration-versions/${cvId}/actions/archive`, {})).status).toBe(409);
  });
});
