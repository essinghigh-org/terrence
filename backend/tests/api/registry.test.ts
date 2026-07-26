import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  registryModuleVersions,
  registryModules,
  registryProviderPlatforms,
  registryProviders,
  registryProviderVersions,
  users,
} from "../../src/db/schema";

describe("Private Module & Provider Registries API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `registry-org-${suffix}`;
  const token = `user-token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token, userId }]);
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("advertises module and provider registry protocols in service discovery", async () => {
    const res = await app.handle(new Request("http://terrence.test/.well-known/terraform.json"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body["modules.v1"]).toBe("/api/registry/v1/modules/");
    expect(body["providers.v1"]).toBe("/api/registry/v1/providers/");
  });

  it("manages private modules and provides standard module registry responses", async () => {
    // 1. Create module
    const createModRes = await request(`/api/v2/organizations/${orgName}/registry-modules`, "POST", {
      data: {
        attributes: {
          name: "vpc",
          provider: "aws",
          namespace: orgName,
        },
      },
    });
    expect(createModRes.status).toBe(201);
    const createModBody = await createModRes.json();
    const moduleId = createModBody.data.id;
    expect(createModBody.data.attributes.name).toBe("vpc");

    // 2. Add version to module in DB
    const verId = `modver-${suffix}`;
    await db.insert(registryModuleVersions).values({
      id: verId,
      moduleId,
      version: "1.0.0",
      status: "ok",
      createdAt: Date.now(),
    });

    // 3. Query module versions via standard registry protocol
    const verRes = await app.handle(new Request(`http://terrence.test/api/registry/v1/modules/${orgName}/vpc/aws/versions`));
    expect(verRes.status).toBe(200);
    const verBody = await verRes.json();
    expect(verBody.modules[0].versions[0].version).toBe("1.0.0");

    // 4. Download header redirection for module
    const dlRes = await app.handle(new Request(`http://terrence.test/api/registry/v1/modules/${orgName}/vpc/aws/1.0.0/download`));
    expect(dlRes.status).toBe(204);
    expect(dlRes.headers.get("X-Terraform-Get")).toBe(`/api/registry/v1/modules/${orgName}/vpc/aws/1.0.0/archive`);

    // Clean up
    await db.delete(registryModuleVersions).where(eq(registryModuleVersions.id, verId));
    await db.delete(registryModules).where(eq(registryModules.id, moduleId));
  });

  it("manages private providers and provides standard provider registry responses", async () => {
    // 1. Create provider
    const createProvRes = await request(`/api/v2/organizations/${orgName}/registry-providers`, "POST", {
      data: {
        attributes: {
          name: "customcloud",
          namespace: orgName,
        },
      },
    });
    expect(createProvRes.status).toBe(201);
    const createProvBody = await createProvRes.json();
    const providerId = createProvBody.data.id;

    // 2. Add provider version and platform in DB
    const provVerId = `provver-${suffix}`;
    await db.insert(registryProviderVersions).values({
      id: provVerId,
      providerId,
      version: "2.1.0",
      protocols: ["5.0"],
      createdAt: Date.now(),
    });

    const platId = `plat-${suffix}`;
    await db.insert(registryProviderPlatforms).values({
      id: platId,
      versionId: provVerId,
      os: "linux",
      arch: "amd64",
      filename: "terraform-provider-customcloud_2.1.0_linux_amd64.zip",
      downloadUrl: "https://example.com/provider.zip",
      shasum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      createdAt: Date.now(),
    });

    // 3. Query provider versions via standard protocol
    const provVerRes = await app.handle(new Request(`http://terrence.test/api/registry/v1/providers/${orgName}/customcloud/versions`));
    expect(provVerRes.status).toBe(200);
    const provVerBody = await provVerRes.json();
    expect(provVerBody.versions[0].version).toBe("2.1.0");

    // 4. Download binary metadata via standard protocol
    const dlPlatRes = await app.handle(new Request(`http://terrence.test/api/registry/v1/providers/${orgName}/customcloud/2.1.0/download/linux/amd64`));
    expect(dlPlatRes.status).toBe(200);
    const dlPlatBody = await dlPlatRes.json();
    expect(dlPlatBody.download_url).toBe("https://example.com/provider.zip");
    expect(dlPlatBody.shasum).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    // Clean up
    await db.delete(registryProviderPlatforms).where(eq(registryProviderPlatforms.id, platId));
    await db.delete(registryProviderVersions).where(eq(registryProviderVersions.id, provVerId));
    await db.delete(registryProviders).where(eq(registryProviders.id, providerId));
  });
});
