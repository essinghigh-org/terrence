import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  oauthClients,
  oauthTokens,
  organizations,
  registryModules,
  registryModuleVersions,
  stacks,
  stackRecords,
} from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/secrets";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";
import { synchronizeRegistryModule, validateRegistryModuleRepository } from "../../src/lib/registry-module-sync";
import { runStackConfigurationJob } from "../../src/lib/stack-worker";
import type { DurableJob } from "../../src/lib/durable-jobs";
import { azureDevOpsZipFixture } from "../fixtures/ado-zip";

const commit = "a".repeat(40);
const identifier = "acme/Project/_git/terraform-aws-network";
const orgIds: string[] = [];
afterEach(async () => {
  setExternalUrlTransportForTests(undefined);
  for (const id of orgIds.splice(0)) await db.delete(organizations).where(eq(organizations.id, id));
});
async function connection(): Promise<Readonly<{ orgId: string; tokenId: string }>> {
  const suffix = crypto.randomUUID();
  const orgId = `ado-org-${suffix}`,
    clientId = `ado-client-${suffix}`,
    tokenId = `ado-token-${suffix}`;
  orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: orgId });
  await db.insert(oauthClients).values({
    id: clientId,
    orgId,
    name: "Azure",
    serviceProvider: "ado_services",
    adoOrgName: "acme",
    apiUrl: "https://dev.azure.com/acme",
    httpUrl: "https://dev.azure.com/acme",
  });
  await db
    .insert(oauthTokens)
    .values({ id: tokenId, oauthClientId: clientId, token: await encryptSecret("source-pat") });
  return { orgId, tokenId };
}
function sourceTransport(path = "modules/network/main.tf"): void {
  const archive = azureDevOpsZipFixture([{ name: path, data: "terraform {}\n" }]);
  setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
    const url = new URL(target.url);
    expect(url.origin).toBe("https://dev.azure.com");
    expect(url.pathname.startsWith("/acme/")).toBe(true);
    expect(init.headers?.["Authorization"]).toBe(`Basic ${Buffer.from(":source-pat").toString("base64")}`);
    if (url.pathname.endsWith("/items")) {
      expect(url.searchParams.get("versionDescriptor.version")).toBe(commit);
      return new Response(Buffer.from(archive));
    }
    if (url.pathname.endsWith("/refs")) {
      const tag = url.searchParams.get("filter") === "tags/";
      return Response.json({
        value: [
          {
            name: tag ? "refs/tags/v1.2.3" : "refs/heads/trunk",
            objectId: tag ? "b".repeat(40) : commit,
            ...(tag ? { peeledObjectId: commit } : {}),
          },
        ],
      });
    }
    return Response.json({ defaultBranch: "refs/heads/trunk" });
  });
}

test.each(["tag", "branch"])("Azure registry %s publishing imports the scoped PAT archive", async (workflow) => {
  const { orgId, tokenId } = await connection();
  sourceTransport();
  const id = `module-${crypto.randomUUID()}`;
  await db.insert(registryModules).values({
    id,
    orgId,
    namespace: orgId,
    name: "network",
    provider: "aws",
    publishingMechanism: "vcs",
    publishingWorkflow: workflow,
    vcsConnectionType: "oauth-token",
    vcsConnectionId: tokenId,
    repositoryIdentifier: identifier,
    sourceDirectory: "modules/network",
    branch: workflow === "branch" ? "trunk" : null,
  });
  const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, id) });
  if (mod === undefined) throw new Error("Missing module fixture");
  await validateRegistryModuleRepository(mod);
  const result = await synchronizeRegistryModule(mod, workflow === "branch" ? "2.0.0" : undefined);
  expect(result.imported).toBe(1);
  const version = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.moduleId, id) });
  expect(version?.commitSha).toBe(commit);
  expect(version?.version).toBe(workflow === "branch" ? "2.0.0" : "1.2.3");
  expect(version?.vcsBranch).toBe(workflow === "branch" ? "trunk" : null);
  if (version?.archivePath === undefined || version.archivePath === null) throw new Error("Missing archive");
  expect(await Bun.file(version.archivePath).exists()).toBe(true);
});

test("Azure registry rejects another organization before sending any PAT", async () => {
  const { orgId, tokenId } = await connection();
  let requests = 0;
  setExternalUrlTransportForTests(async (): Promise<Response> => {
    requests++;
    return Response.json({});
  });
  expect(
    validateRegistryModuleRepository({
      orgId,
      vcsConnectionType: "oauth-token",
      vcsConnectionId: tokenId,
      repositoryIdentifier: "other/project/_git/repo",
    }),
  ).rejects.toThrow("identifier");
  expect(requests).toBe(0);
});
function job(configurationId: string): DurableJob {
  return {
    id: crypto.randomUUID(),
    kind: "stack-configuration",
    dedupeKey: null,
    status: "running",
    payload: { configurationId },
    payloadSchemaVersion: 1,
    attempts: 1,
    runAfter: 0,
    lockedBy: "test",
    lockToken: "test",
    leaseExpiresAt: Date.now() + 30_000,
    heartbeatAt: 0,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}
const context = {
  signal: new AbortController().signal,
  heartbeat: async (): Promise<boolean> => true,
  canceled: async (): Promise<boolean> => false,
};
async function stackConfiguration(orgId: string, tokenId: string): Promise<string> {
  const stackId = `stack-${crypto.randomUUID()}`,
    configurationId = `config-${crypto.randomUUID()}`;
  await db.insert(stacks).values({
    id: stackId,
    orgId,
    name: "Azure source",
    vcsIdentifier: identifier,
    vcsOAuthTokenId: tokenId,
    vcsRepositoryHttpUrl: "https://evil.test/attacker-controlled",
  });
  await db.insert(stackRecords).values({
    id: configurationId,
    stackId,
    recordType: "stack-configurations",
    status: "pending",
    payload: { source: "fetch" },
  });
  return configurationId;
}
test("Azure Stack fetch resolves default branch and preserves a sole component directory", async () => {
  const { orgId, tokenId } = await connection();
  sourceTransport("component/main.tf");
  const configurationId = await stackConfiguration(orgId, tokenId);
  await runStackConfigurationJob(job(configurationId), context);
  const configuration = await db.query.stackRecords.findFirst({ where: eq(stackRecords.id, configurationId) });
  expect(configuration?.status).toBe("completed");
  expect(configuration?.payload?.["rootlessArchive"]).toBe(true);
  expect(configuration?.payload?.["components"]).toMatchObject([{ name: "component", directory: "component" }]);
});
test("Azure Stack redirects fail closed without a Git fallback", async () => {
  const { orgId, tokenId } = await connection();
  let requests = 0;
  setExternalUrlTransportForTests(async (): Promise<Response> => {
    requests++;
    return new Response(null, { status: 302, headers: { Location: "https://dev.azure.com/other/repo" } });
  });
  const configurationId = await stackConfiguration(orgId, tokenId);
  expect(runStackConfigurationJob(job(configurationId), context)).rejects.toThrow("redirects are not permitted");
  const configuration = await db.query.stackRecords.findFirst({ where: eq(stackRecords.id, configurationId) });
  expect(configuration?.status).toBe("failed");
  expect(requests).toBe(1);
});
