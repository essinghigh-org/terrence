import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { exists } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations, registryModules, registryModuleVersions } from "../../src/db/schema";
import { deleteOrganization } from "../../src/lib/utils";

// Issue #619: deleting an organization must remove its registry module
// archive files, not just cascade the rows.
describe("deleteOrganization module archives", (): void => {
  const suffix = crypto.randomUUID();
  const orgId = "modcleanup-org-" + suffix;
  const moduleId = "modcleanup-mod-" + suffix;
  const versionId = "modcleanup-ver-" + suffix;
  let archivePath = "";
  let root = "";

  afterAll(async (): Promise<void> => {
    await db.delete(registryModuleVersions).where(eq(registryModuleVersions.id, versionId));
    await db.delete(registryModules).where(eq(registryModules.id, moduleId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  test("removes module archives from disk with the organization", async (): Promise<void> => {
    root = await mkdtemp(join(tmpdir(), "terrence-modcleanup-"));
    archivePath = join(root, "module.tar.gz");
    await writeFile(archivePath, "archive bytes");
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(registryModules).values({ id: moduleId, orgId, namespace: orgId, name: "cleanup", provider: "aws" });
    await db.insert(registryModuleVersions).values({ id: versionId, moduleId, version: "1.0.0", archivePath });

    await deleteOrganization(orgId);

    expect(await exists(archivePath)).toBe(false);
    expect(await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) })).toBeUndefined();
    expect(await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) })).toBeUndefined();
    expect(await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) })).toBeUndefined();
  });
});
