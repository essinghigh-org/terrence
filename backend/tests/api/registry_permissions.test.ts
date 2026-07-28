import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizations, teams } from "../../src/db/schema";

describe("private registry organization permissions", () => {
  const suffix = crypto.randomUUID();
  const orgId = `registry-permissions-org-${suffix}`;
  const orgName = `registry-permissions-${suffix}`;
  const teamIds = {
    modules: `registry-modules-team-${suffix}`,
    providers: `registry-providers-team-${suffix}`,
    none: `registry-none-team-${suffix}`,
  };
  const tokens = {
    modules: `registry-modules-token-${suffix}`,
    providers: `registry-providers-token-${suffix}`,
    none: `registry-none-token-${suffix}`,
  };

  const request = (path: string, token: string, method = "GET", body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  const data = async <T>(response: Readonly<Response>): Promise<T> =>
    (await response.json() as Readonly<{ data: T }>).data;

  const upload = (versionId: string, token: string): Promise<Response> =>
    app.handle(new Request(`http://terrence.test/api/v2/registry-module-versions/${versionId}/upload`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: "test archive",
    }));

  beforeAll(async () => {
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(teams).values([
      {
        id: teamIds.modules,
        orgId,
        name: `module-managers-${suffix}`,
        organizationAccess: { "manage-modules": true },
      },
      {
        id: teamIds.providers,
        orgId,
        name: `provider-managers-${suffix}`,
        organizationAccess: { "manage-providers": true },
      },
      { id: teamIds.none, orgId, name: `no-registry-access-${suffix}` },
    ]);
    await db.insert(apiTokens).values(Object.entries(tokens).map(([kind, token]) => ({
      id: `registry-permissions-token-${kind}-${suffix}`,
      token: createHash("sha256").update(token).digest("hex"),
      teamId: teamIds[kind as keyof typeof teamIds],
    })));
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("separates module and provider management across every mutation tier", async () => {
    const moduleCreatePath = `/api/v2/organizations/${orgName}/registry-modules`;
    const modulePayload = {
      data: {
        type: "registry-modules",
        attributes: { name: `network-${suffix}`, provider: "aws", namespace: orgName },
      },
    };
    expect((await request(moduleCreatePath, tokens.providers, "POST", modulePayload)).status).toBe(404);
    expect((await request(moduleCreatePath, tokens.none, "POST", modulePayload)).status).toBe(404);
    const moduleResponse = await request(moduleCreatePath, tokens.modules, "POST", modulePayload);
    expect(moduleResponse.status).toBe(201);
    const moduleId = (await data<{ id: string }>(moduleResponse)).id;
    expect((await request(`/api/v2/organizations/${orgName}/registry-modules`, tokens.modules)).status).toBe(200);
    expect((await request(`/api/v2/organizations/${orgName}/registry-modules`, tokens.none)).status).toBe(404);

    const moduleVersionPath = `/api/v2/registry-modules/${moduleId}/versions`;
    const moduleVersionPayload = {
      data: { type: "registry-module-versions", attributes: { version: "1.0.0" } },
    };
    expect((await request(moduleVersionPath, tokens.providers, "POST", moduleVersionPayload)).status).toBe(404);
    const moduleVersionResponse = await request(moduleVersionPath, tokens.modules, "POST", moduleVersionPayload);
    expect(moduleVersionResponse.status).toBe(201);
    const moduleVersionId = (await data<{ id: string }>(moduleVersionResponse)).id;
    expect((await request(`/api/v2/registry-module-versions/${moduleVersionId}`, tokens.providers, "PATCH", {
      data: { type: "registry-module-versions", attributes: { status: "ok" } },
    })).status).toBe(404);
    expect((await request(`/api/v2/registry-module-versions/${moduleVersionId}`, tokens.modules, "PATCH", {
      data: { type: "registry-module-versions", attributes: { status: "ok" } },
    })).status).toBe(200);
    expect((await upload(moduleVersionId, tokens.providers)).status).toBe(404);
    const allowedUpload = await upload(moduleVersionId, tokens.modules);
    expect(allowedUpload.status).toBe(200);
    expect((await request(`/api/v2/registry-module-versions/${moduleVersionId}`, tokens.providers, "DELETE")).status).toBe(404);
    expect((await request(`/api/v2/registry-module-versions/${moduleVersionId}`, tokens.modules, "DELETE")).status).toBe(204);
    expect((await request(`/api/v2/registry-modules/${moduleId}`, tokens.providers, "DELETE")).status).toBe(404);
    expect((await request(`/api/v2/registry-modules/${moduleId}`, tokens.modules, "DELETE")).status).toBe(204);

    const providerCreatePath = `/api/v2/organizations/${orgName}/registry-providers`;
    const providerPayload = {
      data: {
        type: "registry-providers",
        attributes: { name: `cloud-${suffix}`, namespace: orgName, "registry-name": "private" },
      },
    };
    expect((await request(providerCreatePath, tokens.modules, "POST", providerPayload)).status).toBe(404);
    expect((await request(providerCreatePath, tokens.none, "POST", providerPayload)).status).toBe(404);
    const providerResponse = await request(providerCreatePath, tokens.providers, "POST", providerPayload);
    expect(providerResponse.status).toBe(201);
    const providerId = (await data<{ id: string }>(providerResponse)).id;
    expect((await request(`/api/v2/organizations/${orgName}/registry-providers`, tokens.providers)).status).toBe(200);
    expect((await request(`/api/v2/organizations/${orgName}/registry-providers`, tokens.none)).status).toBe(404);

    const providerVersionPath = `/api/v2/registry-providers/${providerId}/versions`;
    const providerVersionPayload = {
      data: {
        type: "registry-provider-versions",
        attributes: { version: "2.0.0", protocols: ["5.0"] },
      },
    };
    expect((await request(providerVersionPath, tokens.modules, "POST", providerVersionPayload)).status).toBe(404);
    const providerVersionResponse = await request(providerVersionPath, tokens.providers, "POST", providerVersionPayload);
    expect(providerVersionResponse.status).toBe(201);
    const providerVersionId = (await data<{ id: string }>(providerVersionResponse)).id;

    const platformPath = `/api/v2/registry-provider-versions/${providerVersionId}/platforms`;
    const platformPayload = {
      data: {
        type: "registry-provider-platforms",
        attributes: {
          os: "linux",
          arch: "amd64",
          filename: "terraform-provider-cloud_linux_amd64.zip",
          "download-url": "https://example.invalid/provider.zip",
          shasum: "a".repeat(64),
        },
      },
    };
    expect((await request(platformPath, tokens.modules, "POST", platformPayload)).status).toBe(404);
    const platformResponse = await request(platformPath, tokens.providers, "POST", platformPayload);
    expect(platformResponse.status).toBe(201);
    const platformId = (await data<{ id: string }>(platformResponse)).id;
    expect((await request(platformPath, tokens.providers)).status).toBe(200);
    expect((await request(`/api/v2/registry-provider-platforms/${platformId}`, tokens.modules, "DELETE")).status).toBe(404);
    expect((await request(`/api/v2/registry-provider-platforms/${platformId}`, tokens.providers, "DELETE")).status).toBe(204);
    expect((await request(`/api/v2/registry-provider-versions/${providerVersionId}`, tokens.modules, "DELETE")).status).toBe(404);
    expect((await request(`/api/v2/registry-provider-versions/${providerVersionId}`, tokens.providers, "DELETE")).status).toBe(204);
    expect((await request(`/api/v2/registry-providers/${providerId}`, tokens.modules, "DELETE")).status).toBe(404);
    expect((await request(`/api/v2/registry-providers/${providerId}`, tokens.providers, "DELETE")).status).toBe(204);
  });
});
