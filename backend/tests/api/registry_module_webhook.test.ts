import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations, registryModules } from "../../src/db/schema";
import { syncRegistryModulesForTag } from "../../src/lib/webhooks";

describe("Registry module sync on tag push", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-modtag-${suffix}`;
  const repo = `repo-org-${suffix}/repo-name`;
  const otherRepo = `repo-org-${suffix}/other-repo`;

  const moduleId = `mod-tag-${suffix}`;
  const otherModuleId = `mod-tag-other-${suffix}`;
  const prefixedModuleId = `mod-tag-prefix-${suffix}`;
  const wrongPrefixModuleId = `mod-tag-wrongprefix-${suffix}`;

  beforeAll(async () => {
    await db.insert(organizations).values([{ id: orgId, name: `modtag-org-${suffix}` }]);
    await db.insert(registryModules).values([
      {
        id: moduleId,
        orgId,
        namespace: "ns",
        name: "matching",
        provider: "github",
        publishingMechanism: "vcs",
        publishingWorkflow: "tag",
        vcsConnectionType: "github-app",
        vcsConnectionId: "ghain-missing",
        repositoryIdentifier: repo,
        tagPrefix: "",
        status: "setup_complete",
      },
      {
        id: otherModuleId,
        orgId,
        namespace: "ns",
        name: "other-repo",
        provider: "github",
        publishingMechanism: "vcs",
        publishingWorkflow: "tag",
        vcsConnectionType: "github-app",
        vcsConnectionId: "ghain-missing",
        repositoryIdentifier: otherRepo,
        tagPrefix: "",
        status: "setup_complete",
      },
      {
        id: prefixedModuleId,
        orgId,
        namespace: "ns",
        name: "prefixed",
        provider: "github",
        publishingMechanism: "vcs",
        publishingWorkflow: "tag",
        vcsConnectionType: "github-app",
        vcsConnectionId: "ghain-missing",
        repositoryIdentifier: repo,
        tagPrefix: "v",
        status: "setup_complete",
      },
      {
        id: wrongPrefixModuleId,
        orgId,
        namespace: "ns",
        name: "wrong-prefix",
        provider: "github",
        publishingMechanism: "vcs",
        publishingWorkflow: "tag",
        vcsConnectionType: "github-app",
        vcsConnectionId: "ghain-missing",
        repositoryIdentifier: repo,
        tagPrefix: "mod-",
        status: "setup_complete",
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(registryModules).where(eq(registryModules.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("attempts a sync for matching modules, skips others, and never throws", async () => {
    // The connection is deliberately broken (ghain-missing), so the sync
    // fails inside synchronizeRegistryModule and is recorded on the module
    // row. The test asserts dispatch and filtering, not GitHub reachability.
    await expect(syncRegistryModulesForTag(repo, "v1.0.0")).resolves.toBeUndefined();

    const matching = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
    expect(matching?.lastSyncAttemptAt).not.toBeNull();
    expect(matching?.status).toBe("errored");
    expect(matching?.lastSyncError).toContain("VCS connection");

    // Same repo, tag matches the tag prefix: also attempted.
    const prefixed = await db.query.registryModules.findFirst({ where: eq(registryModules.id, prefixedModuleId) });
    expect(prefixed?.lastSyncAttemptAt).not.toBeNull();

    // Different repository: never considered.
    const other = await db.query.registryModules.findFirst({ where: eq(registryModules.id, otherModuleId) });
    expect(other?.lastSyncAttemptAt).toBeNull();

    // Same repo but the tag does not match the tag prefix: skipped.
    const wrongPrefix = await db.query.registryModules.findFirst({ where: eq(registryModules.id, wrongPrefixModuleId) });
    expect(wrongPrefix?.lastSyncAttemptAt).toBeNull();
  });
});
