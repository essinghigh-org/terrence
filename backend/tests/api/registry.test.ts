import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { makeRegistryModuleArchive } from "../registry-module-helpers";

describe("Private Module & Provider Registries API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `registry-org-${suffix}`;
  const token = `user-token-${suffix}`;
  let fixtureDirectory = "";
  let moduleArchive = "";

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
    fixtureDirectory = await mkdtemp(join(tmpdir(), "terrence-registry-api-"));
    moduleArchive = join(fixtureDirectory, "module.tar.gz");
    await makeRegistryModuleArchive(moduleArchive);
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
    await rm(fixtureDirectory, { recursive: true, force: true });
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

    // 2. Publish real source through the management API.
    const versionRes = await request(`/api/v2/registry-modules/${moduleId}/versions`, "POST", {
      data: { type: "registry-module-versions", attributes: { version: "1.0.0" } },
    });
    expect(versionRes.status).toBe(201);
    const versionId = (await versionRes.json()).data.id as string;
    const archiveBytes = await Bun.file(moduleArchive).arrayBuffer();
    const upload = (): Promise<Response> => app.handle(new Request(`http://terrence.test/api/v2/registry-module-versions/${versionId}/upload`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: archiveBytes.slice(0),
    }));
    const uploads = await Promise.all([upload(), upload()]);
    expect(uploads.map(({ status }): number => status).sort()).toEqual([200, 409]);
    const uploadRes = uploads.find(({ status }): boolean => status === 200)!;
    expect(uploadRes.status).toBe(200);
    expect((await uploadRes.json()).data.attributes.status).toBe("ok");
    expect((await upload()).status).toBe(409);

    // 3. Query module versions via standard registry protocol
    const verRes = await request(`/api/registry/v1/modules/${orgName}/vpc/aws/versions`);
    expect(verRes.status).toBe(200);
    const verBody = await verRes.json();
    expect(verBody.modules[0].versions[0].version).toBe("1.0.0");

    // 4. Download header redirection for module
    const dlRes = await request(`/api/registry/v1/modules/${orgName}/vpc/aws/1.0.0/download`);
    expect(dlRes.status).toBe(204);
    // The download header now carries the signed archive URL (module archives).
    const archiveUrl = dlRes.headers.get("X-Terraform-Get");
    expect(archiveUrl).not.toBeNull();
    expect(new URL(archiveUrl!, "http://terrence.test").pathname).toBe(`/api/registry/v1/modules/${orgName}/vpc/aws/1.0.0/archive.tar.gz`);

    expect((await request(`/api/v2/registry-modules/${moduleId}`, "DELETE")).status).toBe(204);
  });

  it("rejects duplicate module-version requests", async () => {
    const created = await request(`/api/v2/organizations/${orgName}/registry-modules`, "POST", {
      data: { attributes: { name: "duplicate-version", provider: "aws", namespace: orgName } },
    });
    const moduleId = (await created.json()).data.id as string;
    const createVersion = (): Promise<Response> => request(`/api/v2/registry-modules/${moduleId}/versions`, "POST", {
      data: { type: "registry-module-versions", attributes: { version: "1.0.0" } },
    });
    const responses = await Promise.all([createVersion(), createVersion()]);
    expect(responses.map((response): number => response.status).sort()).toEqual([201, 422]);
    await db.delete(registryModules).where(eq(registryModules.id, moduleId));
  });

  it("searches, filters, and paginates registry modules in the management API", async () => {
    const manualId = `search-manual-${suffix}`;
    const vcsId = `search-vcs-${suffix}`;
    await db.insert(registryModules).values([
      { id: manualId, orgId, namespace: orgName, name: "search-manual", provider: "aws", publishingMechanism: "manual" },
      { id: vcsId, orgId, namespace: orgName, name: "search-vcs", provider: "azurerm", publishingMechanism: "vcs" },
    ]);
    const response = await request(
      `/api/v2/organizations/${orgName}/registry-modules?q=SEARCH&filter[provider]=azurerm&filter[publishing_mechanism]=vcs&page[size]=1`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map(({ id }: { id: string }): string => id)).toEqual([vcsId]);
    expect(body.meta.pagination["total-count"]).toBe(1);
    expect(body.meta.providers).toEqual(["aws", "azurerm"]);
    await db.delete(registryModules).where(inArray(registryModules.id, [manualId, vcsId]));
  });

  it("serves only consumable module lifecycle states", async () => {
    const created = await request(`/api/v2/organizations/${orgName}/registry-modules`, "POST", {
      data: { attributes: { name: "lifecycle", provider: "aws", namespace: orgName } },
    });
    const moduleId = (await created.json()).data.id as string;
    const now = Date.now();
    await db.insert(registryModuleVersions).values([
      { id: `pending-${suffix}`, moduleId, version: "1.0.0", status: "pending", archivePath: moduleArchive, createdAt: now },
      { id: `errored-${suffix}`, moduleId, version: "1.1.0", status: "errored", archivePath: moduleArchive, createdAt: now + 1 },
      { id: `deprecated-${suffix}`, moduleId, version: "1.2.0", status: "ok", archivePath: moduleArchive, isDeprecated: true, createdAt: now + 2 },
      { id: `revoked-${suffix}`, moduleId, version: "1.3.0", status: "ok", archivePath: moduleArchive, isRevoked: true, createdAt: now + 3 },
      { id: `healthy-${suffix}`, moduleId, version: "1.4.0", status: "ok", archivePath: moduleArchive, createdAt: now + 4 },
      { id: `newest-created-${suffix}`, moduleId, version: "2.0.0", status: "ok", archivePath: moduleArchive, createdAt: now + 6 },
      { id: `highest-${suffix}`, moduleId, version: "10.0.0", status: "ok", archivePath: moduleArchive, createdAt: now + 5 },
    ]);

    const response = await request(`/api/registry/v1/modules/${orgName}/lifecycle/aws/versions`);
    const versions = (await response.json()).modules[0].versions.map((version: { version: string }): string => version.version);
    expect(versions).toEqual(["10.0.0", "2.0.0", "1.4.0", "1.2.0"]);
    expect((await request(`/api/registry/v1/modules/${orgName}/lifecycle/aws/1.2.0/download`)).status).toBe(204);
    expect((await request(`/api/registry/v1/modules/${orgName}/lifecycle/aws/1.0.0/download`)).status).toBe(404);
    expect((await request(`/api/registry/v1/modules/${orgName}/lifecycle/aws/1.3.0/download`)).status).toBe(404);
    expect((await request(`/api/registry/v1/modules/${orgName}/lifecycle/aws/1.1.0/download`)).status).toBe(404);
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
    const provVerRes = await request(`/api/registry/v1/providers/${orgName}/customcloud/versions`);
    expect(provVerRes.status).toBe(200);
    const provVerBody = await provVerRes.json();
    expect(provVerBody.versions[0].version).toBe("2.1.0");

    // 4. Download binary metadata via standard protocol
    const dlPlatRes = await request(`/api/registry/v1/providers/${orgName}/customcloud/2.1.0/download/linux/amd64`);
    expect(dlPlatRes.status).toBe(200);
    const dlPlatBody = await dlPlatRes.json();
    expect(dlPlatBody.download_url).toBe("https://example.com/provider.zip");
    expect(dlPlatBody.shasum).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    // 5. Consume the same release through the authenticated network mirror protocol
    const mirrorPath = `/api/registry/v1/provider-mirror/terrence.test/${orgName}/customcloud`;
    const anonymousMirrorRes = await app.handle(new Request(`http://terrence.test${mirrorPath}/index.json`));
    expect(anonymousMirrorRes.status).toBe(404);
    expect((await request(`/api/registry/v1/provider-mirror/registry.terraform.io/${orgName}/customcloud/index.json`)).status).toBe(404);

    const mirrorIndexRes = await request(`${mirrorPath}/index.json`);
    expect(mirrorIndexRes.status).toBe(200);
    expect(mirrorIndexRes.headers.get("Content-Type")).toContain("application/json");
    expect(await mirrorIndexRes.json()).toEqual({ versions: { "2.1.0": {} } });

    const mirrorPackagesRes = await request(`${mirrorPath}/2.1.0.json`);
    expect(mirrorPackagesRes.status).toBe(200);
    expect(await mirrorPackagesRes.json()).toEqual({
      archives: {
        linux_amd64: {
          url: "https://example.com/provider.zip",
          hashes: ["zh:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
        },
      },
    });
    expect((await request(`${mirrorPath}/9.9.9.json`)).status).toBe(404);

    // Clean up
    await db.delete(registryProviderPlatforms).where(eq(registryProviderPlatforms.id, platId));
    await db.delete(registryProviderVersions).where(eq(registryProviderVersions.id, provVerId));
    await db.delete(registryProviders).where(eq(registryProviders.id, providerId));
  });
});
