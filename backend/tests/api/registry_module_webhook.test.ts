import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { githubAppInstallations, oauthClients, oauthTokens, organizations, registryModules } from "../../src/db/schema";
import { syncRegistryModulesForTag } from "../../src/lib/webhooks";
import { vcsSourceIdentity } from "../../src/lib/vcs-source";

describe("Registry module sync on tag push", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-modtag-${suffix}`;
  const repo = `repo-org-${suffix}/repo-name`;
  const otherRepo = `repo-org-${suffix}/other-repo`;

  const moduleId = `mod-tag-${suffix}`;
  const otherModuleId = `mod-tag-other-${suffix}`;
  const prefixedModuleId = `mod-tag-prefix-${suffix}`;
  const wrongPrefixModuleId = `mod-tag-wrongprefix-${suffix}`;
  const otherHostModuleId = `mod-tag-other-host-${suffix}`;
  const branchModuleId = `mod-tag-branch-${suffix}`;
  const otherHostClientId = `oauthc-modtag-other-host-${suffix}`;
  const otherHostTokenId = `oautht-modtag-other-host-${suffix}`;
  const otherInstallationId = `ghain-modtag-other-${suffix}`;
  const otherInstallationModuleId = `mod-tag-other-installation-${suffix}`;
  const originalAppId = process.env["GITHUB_APP_ID"];
  const originalPrivateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
  const originalAppApiUrl = process.env["GITHUB_APP_API_URL"];

  beforeAll(async () => {
    process.env["GITHUB_APP_ID"] = "";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "";
    process.env["GITHUB_APP_API_URL"] = "https://github.example/api/v3";
    await db.insert(organizations).values([{ id: orgId, name: `modtag-org-${suffix}` }]);
    await db.insert(githubAppInstallations).values({
      id: "ghain-missing",
      orgId,
      name: "test-installation",
      installationId: 12345,
    });
    await db.insert(githubAppInstallations).values({
      id: otherInstallationId,
      orgId,
      name: "other-installation",
      installationId: 67890,
    });
    await db.insert(oauthClients).values({
      id: otherHostClientId,
      orgId,
      name: "Other GitHub host",
      serviceProvider: "github",
      apiUrl: "https://other-github.example/api/v3",
    });
    await db.insert(oauthTokens).values({
      id: otherHostTokenId,
      oauthClientId: otherHostClientId,
      token: "unused",
    });
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
      {
        id: branchModuleId,
        orgId,
        namespace: "ns",
        name: "branch-publication",
        provider: "github",
        publishingMechanism: "vcs",
        publishingWorkflow: "branch",
        vcsConnectionType: "github-app",
        vcsConnectionId: "ghain-missing",
        repositoryIdentifier: repo,
        tagPrefix: "",
        branch: "main",
        status: "setup_complete",
      },
      {
        id: otherHostModuleId,
        orgId,
        namespace: "ns",
        name: "other-host",
        provider: "github",
        publishingMechanism: "vcs",
        publishingWorkflow: "tag",
        vcsConnectionType: "oauth-token",
        vcsConnectionId: otherHostTokenId,
        repositoryIdentifier: repo,
        tagPrefix: "",
        status: "setup_complete",
      },
      {
        id: otherInstallationModuleId,
        orgId,
        namespace: "ns",
        name: "other-installation",
        provider: "github",
        publishingMechanism: "vcs",
        publishingWorkflow: "tag",
        vcsConnectionType: "github-app",
        vcsConnectionId: otherInstallationId,
        repositoryIdentifier: repo,
        tagPrefix: "",
        status: "setup_complete",
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(registryModules).where(eq(registryModules.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    if (originalAppId === undefined) delete process.env["GITHUB_APP_ID"];
    else process.env["GITHUB_APP_ID"] = originalAppId;
    if (originalPrivateKey === undefined) delete process.env["GITHUB_APP_PRIVATE_KEY"];
    else process.env["GITHUB_APP_PRIVATE_KEY"] = originalPrivateKey;
    if (originalAppApiUrl === undefined) delete process.env["GITHUB_APP_API_URL"];
    else process.env["GITHUB_APP_API_URL"] = originalAppApiUrl;
  });

  it("attempts a sync for matching modules, skips others, and never throws", async () => {
    // The app credentials are deliberately unavailable, so the matching
    // modules fail inside synchronizeRegistryModule and record the failure.
    const source = vcsSourceIdentity("github", `https://github.example/${repo}`, 12345);
    if (source === undefined) throw new Error("test source identity should be valid");
    await syncRegistryModulesForTag(repo, "v1.0.0", source);

    const matching = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
    expect(matching?.lastSyncAttemptAt).not.toBeNull();
    expect(matching?.status).toBe("errored");
    expect(matching?.lastSyncError).toContain("VCS connection");

    // Same repo, tag matches the tag prefix: also attempted.
    const prefixed = await db.query.registryModules.findFirst({ where: eq(registryModules.id, prefixedModuleId) });
    expect(prefixed?.lastSyncAttemptAt).not.toBeNull();

    // Tag delivery must never invoke branch-based module synchronization.
    const branch = await db.query.registryModules.findFirst({ where: eq(registryModules.id, branchModuleId) });
    expect(branch?.lastSyncAttemptAt).toBeNull();
    expect(branch?.status).toBe("setup_complete");

    // Different repository: never considered.
    const other = await db.query.registryModules.findFirst({ where: eq(registryModules.id, otherModuleId) });
    expect(other?.lastSyncAttemptAt).toBeNull();

    // Same repo but the tag does not match the tag prefix: skipped.
    const wrongPrefix = await db.query.registryModules.findFirst({ where: eq(registryModules.id, wrongPrefixModuleId) });
    expect(wrongPrefix?.lastSyncAttemptAt).toBeNull();

    // Same repository identifier, but a different GitHub host: never routed.
    const otherHost = await db.query.registryModules.findFirst({ where: eq(registryModules.id, otherHostModuleId) });
    expect(otherHost?.lastSyncAttemptAt).toBeNull();

    // Same host and repository, but a different GitHub App installation:
    // installation identity must also remain isolated.
    const otherInstallation = await db.query.registryModules.findFirst({ where: eq(registryModules.id, otherInstallationModuleId) });
    expect(otherInstallation?.lastSyncAttemptAt).toBeNull();
  });
});
