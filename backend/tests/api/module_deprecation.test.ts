import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, organizationMemberships, registryModules, registryModuleVersions } from "../../src/db/schema";
import { makeRegistryModuleArchive } from "../registry-module-helpers";

describe("Module Deprecation, Revocation & Tests API", () => {
  let token: string;
  let moduleId: string;
  let versionId: string;
  let orgId: string;
  let userId: string;
  let fixtureDirectory: string;
  const originalTerraformTestBinary = process.env["TERRAFORM_TEST_BINARY_PATH"];

  beforeAll(async () => {
    userId = `usr-${crypto.randomUUID()}`;
    const tokenVal = `test-token-${crypto.randomUUID()}`;
    orgId = `org-${crypto.randomUUID()}`;
    moduleId = `mod-${crypto.randomUUID()}`;
    versionId = `ver-${crypto.randomUUID()}`;
    fixtureDirectory = await mkdtemp(join(tmpdir(), "terrence-module-lifecycle-"));
    const archivePath = join(fixtureDirectory, "module.tar.gz");
    const terraform = join(fixtureDirectory, "terraform");
    await Promise.all([
      makeRegistryModuleArchive(archivePath),
      writeFile(terraform, "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
    ]);
    await chmod(terraform, 0o755);
    process.env["TERRAFORM_TEST_BINARY_PATH"] = terraform;

    await db.insert(users).values({
      id: userId,
      username: `user_${Date.now()}`,
      passwordHash: "hash",
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: hashAuthenticationToken(tokenVal),
      userId,
      createdAt: Date.now(),
    });

    await db.insert(organizations).values({
      id: orgId,
      name: `org-${crypto.randomUUID()}`,
    });

    await db.insert(organizationMemberships).values({
      id: `om-${crypto.randomUUID()}`,
      userId,
      orgId,
      role: "owner",
      status: "active",
    });

    await db.insert(registryModules).values({
      id: moduleId,
      orgId,
      namespace: `acme_${Date.now()}`,
      name: "vpc",
      provider: "aws",
      createdAt: Date.now(),
    });

    await db.insert(registryModuleVersions).values({
      id: versionId,
      moduleId,
      version: "1.0.0",
      status: "ok",
      archivePath,
      createdAt: Date.now(),
    });

    token = tokenVal;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await rm(fixtureDirectory, { recursive: true, force: true });
    if (originalTerraformTestBinary === undefined) delete process.env["TERRAFORM_TEST_BINARY_PATH"];
    else process.env["TERRAFORM_TEST_BINARY_PATH"] = originalTerraformTestBinary;
  });

  test("POST /registry-module-versions/:id/actions/revoke revokes module version", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/registry-module-versions/${versionId}/actions/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.attributes.status).toBe("ok");
    expect(json.data.attributes.revoked).toBe(true);
  });

  test("POST /registry-modules/:module_id/versions/:version/actions/test triggers module test", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/registry-modules/${moduleId}/versions/1.0.0/actions/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.attributes.status).toBe("finished");
  });
});