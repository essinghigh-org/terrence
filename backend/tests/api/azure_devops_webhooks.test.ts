import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  configurationVersions,
  durableJobs,
  githubWebhookDeliveries,
  oauthClients,
  oauthTokens,
  organizations,
  policies,
  policySets,
  policySetVersions,
  runs,
  workspaces,
} from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/secrets";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";
import { createConfigurationVersionFromVcs, reportRunVcsStatus } from "../../src/lib/webhooks";
import { handleVcsWebhookJob, processVcsWebhookPayload } from "../../src/lib/webhook-jobs";
import { azureDevOpsZipFixture } from "../fixtures/ado-zip";

const organizationId = "org-ado-hooks";
const clientId = "oc-ado-hooks";
const tokenId = "ot-ado-hooks";
const workspaceId = "ws-ado-hooks";
const identifier = "fabrikam/Infrastructure/_git/platform";
const repoId = "11111111-2222-3333-4444-555555555555";
const sha = "a".repeat(40);
const beforeSha = "b".repeat(40);
const hookSecret = "test-hook-secret-not-the-personal-access-token";
const auth = (username = clientId, secret = hookSecret): string =>
  `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
const requests: { url: string; authorization: string | null; body: string | undefined }[] = [];
let diffPaths = ["/main.tf"];
let diffFailure = false;
let prFork = false;
let archiveFailure = false;
let submoduleTree = false;
let submoduleFiles = [{ name: "main.tf", data: "terraform {}" }];
const submoduleConfig = '[submodule "child"]\npath = child\nurl = ../child\n';
const gitBlobId = (value: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(value)}\0${value}`)
    .digest("hex");

let archiveEntries = [{ name: "main.tf", data: "terraform {}" }];
const repository = {
  id: repoId,
  name: "platform",
  project: { name: "Infrastructure" },
  remoteUrl: `https://dev.azure.com/${identifier}`,
};
function push(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    eventType: "git.push",
    publisherId: "tfs",
    resource: {
      repository,
      pushedBy: { displayName: "Engineer" },
      refUpdates: [{ name: "refs/heads/main", oldObjectId: beforeSha, newObjectId: sha }],
      commits: [{ commitId: sha, comment: "Update infrastructure" }],
    },
    ...overrides,
  };
}
function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    eventType: "git.pullrequest.created",
    publisherId: "tfs",
    resource: {
      repository,
      createdBy: { displayName: "Engineer" },
      pullRequestId: 7,
      status: "active",
      title: "Update infrastructure",
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      lastMergeSourceCommit: { commitId: sha },
      lastMergeTargetCommit: { commitId: beforeSha },
      ...overrides,
    },
  };
}
async function post(
  payload: Record<string, unknown>,
  authorization = auth(),
  targetClient = clientId,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/webhooks/azure-devops/${targetClient}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(payload),
    }),
  );
}
async function configurations(): Promise<(typeof configurationVersions.$inferSelect)[]> {
  return db.query.configurationVersions.findMany({ where: eq(configurationVersions.workspaceId, workspaceId) });
}

describe("Azure DevOps authenticated service hooks", () => {
  beforeAll(async () => {
    await db.insert(organizations).values({ id: organizationId, name: "ado-hooks" });
    await db.insert(oauthClients).values([
      {
        id: clientId,
        orgId: organizationId,
        name: "Azure",
        serviceProvider: "ado_services",
        adoOrgName: "fabrikam",
        secret: await encryptSecret(hookSecret),
      },
      {
        id: "oc-ado-isolated",
        orgId: organizationId,
        name: "Other connection",
        serviceProvider: "ado_services",
        adoOrgName: "fabrikam",
        secret: await encryptSecret("other-hook-secret"),
      },
    ]);
    await db.insert(oauthTokens).values([
      { id: tokenId, oauthClientId: clientId, token: await encryptSecret("test-azure-pat") },
      { id: "ot-ado-isolated", oauthClientId: "oc-ado-isolated", token: await encryptSecret("other-azure-pat") },
    ]);
    await db.insert(workspaces).values([
      {
        id: workspaceId,
        orgId: organizationId,
        name: "azure",
        queueAllRuns: true,
        fileTriggersEnabled: true,
        triggerPatterns: ["**/*.tf"],
        vcsRepo: { identifier, branch: "main", oauthTokenId: tokenId },
      },
      {
        id: "ws-ado-isolated",
        orgId: organizationId,
        name: "isolated",
        queueAllRuns: true,
        vcsRepo: { identifier, branch: "main", oauthTokenId: "ot-ado-isolated" },
      },
    ]);
    setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
      const url = new URL(target.url);
      requests.push({
        url: target.url,
        authorization: new Headers(init.headers).get("authorization"),
        body: init.body,
      });
      if (submoduleTree && url.pathname.includes("/trees/")) {
        const root = url.pathname.includes("/platform/");
        return Response.json({
          objectId: root ? "d".repeat(40) : "e".repeat(40),
          treeEntries: root
            ? [
                {
                  relativePath: ".gitmodules",
                  mode: "100644",
                  gitObjectType: "blob",
                  objectId: gitBlobId(submoduleConfig),
                },
                { relativePath: "child", mode: "160000", gitObjectType: "commit", objectId: beforeSha },
              ]
            : submoduleFiles.map((file) => ({
                relativePath: file.name,
                mode: "100644",
                gitObjectType: "blob",
                objectId: gitBlobId(file.data),
              })),
        });
      }
      if (submoduleTree && url.pathname.includes("/blobs/"))
        return new Response(
          url.pathname.endsWith(gitBlobId(submoduleConfig))
            ? submoduleConfig
            : submoduleFiles.find((file): boolean => url.pathname.endsWith(gitBlobId(file.data)))?.data,
        );
      if (submoduleTree && url.pathname.includes("/child/commits/"))
        return Response.json({ commitId: beforeSha, treeId: "e".repeat(40) });
      if (url.pathname.endsWith("/statuses")) return Response.json({ id: 1 }, { status: 201 });
      if (url.pathname.endsWith("/diffs/commits"))
        return diffFailure
          ? new Response("unavailable", { status: 503 })
          : Response.json({ allChangesIncluded: true, changes: diffPaths.map((path) => ({ item: { path } })) });
      if (url.pathname.endsWith("/pullrequests/7"))
        return Response.json({
          ...(pullRequest()["resource"] as Record<string, unknown>),
          ...(prFork ? { forkSource: { repository: { id: "another-repo" } } } : {}),
        });
      if (url.pathname.endsWith("/refs")) return Response.json({ value: [{ name: "refs/heads/main", objectId: sha }] });
      if (url.pathname.endsWith("/items"))
        return archiveFailure
          ? new Response("bad zip")
          : new Response(Buffer.from(azureDevOpsZipFixture(archiveEntries)));
      if (url.pathname.endsWith(`/commits/${"c".repeat(40)}`)) return new Response("tag object", { status: 404 });
      if (url.pathname.endsWith(`/annotatedtags/${"c".repeat(40)}`))
        return Response.json({ objectId: "c".repeat(40), taggedObject: { objectId: sha, objectType: "commit" } });
      if (url.pathname.endsWith(`/commits/${sha}`))
        return Response.json({ commitId: sha, ...(submoduleTree ? { treeId: "d".repeat(40) } : {}) });
      return Response.json({ defaultBranch: "refs/heads/main" });
    });
  });
  beforeEach(async () => {
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
    await db
      .update(workspaces)
      .set({
        vcsRepo: { identifier, branch: "main", oauthTokenId: tokenId },
        executionMode: "remote",
        speculativeEnabled: true,
      })
      .where(eq(workspaces.id, workspaceId));
    requests.length = 0;
    diffPaths = ["/main.tf"];
    diffFailure = false;
    prFork = false;
    archiveFailure = false;
    submoduleTree = false;
    submoduleFiles = [{ name: "main.tf", data: "terraform {}" }];
    archiveEntries = [{ name: "main.tf", data: "terraform {}" }];
  });
  afterAll(async () => {
    setExternalUrlTransportForTests(undefined);
    await db.delete(organizations).where(eq(organizations.id, organizationId));
  });

  test("rejects wrong, absent, malformed and PAT-as-hook Basic credentials before any provider request", async () => {
    for (const value of [
      "",
      "Bearer test-azure-pat",
      auth("wrong"),
      auth(clientId, "test-azure-pat"),
      "Basic !!!",
      `${auth()}garbage`,
    ])
      expect((await post(push(), value)).status).toBe(401);
    expect(requests).toHaveLength(0);
    expect(await configurations()).toHaveLength(0);
  });
  test("accepts pushes once, scopes the connection, converts archives, and records Azure provenance", async () => {
    const payload = push();
    expect((await post(payload)).status).toBe(200);
    expect((await post(payload)).status).toBe(200);
    const versions = await configurations();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.status).toBe("uploaded");
    expect(versions[0]?.source).toBe("azure_devops");
    expect(versions[0]?.ingressAttributes?.vcsProvider).toBe("azure_devops");
    expect(
      await db.query.configurationVersions.findMany({
        where: eq(configurationVersions.workspaceId, "ws-ado-isolated"),
      }),
    ).toHaveLength(0);
    expect(requests.filter((request) => request.url.includes("/items?"))).toHaveLength(1);
    expect(
      requests.every(
        (request) => request.authorization === `Basic ${Buffer.from(":test-azure-pat").toString("base64")}`,
      ),
    ).toBe(true);
  });
  test("durable retry after side effects reuses the run and skips an uploaded archive", async () => {
    const payload = push();
    expect((await post(payload)).status).toBe(200);
    const original = (await configurations())[0];
    const deliveryId = `azure_devops:${clientId}:${String(payload["id"])}`;
    await db
      .update(githubWebhookDeliveries)
      .set({ status: "processing" })
      .where(eq(githubWebhookDeliveries.id, deliveryId));
    requests.length = 0;
    await processVcsWebhookPayload(
      { provider: "azure_devops", eventName: "git.push", authenticatedClientId: clientId, payload, deliveryId },
      2,
    );
    expect(await configurations()).toHaveLength(1);
    expect((await configurations())[0]?.id).toBe(original?.id);
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).toHaveLength(1);
    expect(requests.filter((request) => request.url.includes("/items?"))).toHaveLength(0);
  });
  test("durable retry recovers a configuration persisted before run creation and archive upload", async () => {
    const payload = push();
    expect((await post(payload)).status).toBe(200);
    const original = (await configurations())[0];
    if (original === undefined) throw new Error("Expected initial configuration");
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db
      .update(configurationVersions)
      .set({ status: "pending", archivePath: null })
      .where(eq(configurationVersions.id, original.id));
    const deliveryId = `azure_devops:${clientId}:${String(payload["id"])}`;
    await db
      .update(githubWebhookDeliveries)
      .set({ status: "processing" })
      .where(eq(githubWebhookDeliveries.id, deliveryId));
    requests.length = 0;
    await processVcsWebhookPayload(
      { provider: "azure_devops", eventName: "git.push", authenticatedClientId: clientId, payload, deliveryId },
      2,
    );
    const recovered = await configurations();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe(original.id);
    expect(recovered[0]?.status).toBe("uploaded");
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).toHaveLength(1);
    expect(requests.filter((request) => request.url.includes("/items?"))).toHaveLength(1);
  });
  test("rejects cross-organization remote URLs and oversized/malformed ref deliveries", async () => {
    const payload = push();
    const resource = payload["resource"] as Record<string, unknown>;
    expect(
      (
        await post({
          ...payload,
          resource: {
            ...resource,
            repository: { ...repository, remoteUrl: "https://dev.azure.com/attacker/Infrastructure/_git/platform" },
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post({
          ...payload,
          resource: {
            ...resource,
            refUpdates: Array.from({ length: 33 }, (_, i) => ({
              name: `refs/heads/branch-${i}`,
              oldObjectId: beforeSha,
              newObjectId: sha,
            })),
          },
        })
      ).status,
    ).toBe(422);
    expect((await post({ ...payload, id: "" })).status).toBe(422);
    expect(requests).toHaveLength(0);
  });
  test("file filters use complete diffs and fail open on an unavailable file list", async () => {
    diffPaths = ["/README.md"];
    expect((await post(push())).status).toBe(200);
    expect(await configurations()).toHaveLength(0);
    diffFailure = true;
    expect((await post(push())).status).toBe(200);
    expect(await configurations()).toHaveLength(1);
  });
  test("verifies same-repository active PRs before speculative runs and rejects API-confirmed forks", async () => {
    prFork = true;
    expect((await post(pullRequest())).status).toBe(200);
    expect(await configurations()).toHaveLength(0);
    prFork = false;
    expect((await post(pullRequest())).status).toBe(200);
    const versions = await configurations();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.speculative).toBe(true);
    expect(versions[0]?.ingressAttributes?.trustedPullRequest).toBe(true);
  });
  test("ignores deleted refs, completed/draft/fork PRs and local workspaces", async () => {
    const payload = push();
    const resource = payload["resource"] as Record<string, unknown>;
    expect(
      (
        await post({
          ...payload,
          resource: {
            ...resource,
            refUpdates: [{ name: "refs/heads/main", oldObjectId: beforeSha, newObjectId: "0".repeat(40) }],
          },
        })
      ).status,
    ).toBe(200);
    for (const override of [{ status: "completed" }, { isDraft: true }, { forkSource: { repository: { id: "fork" } } }])
      expect((await post(pullRequest(override))).status).toBe(200);
    await db.update(workspaces).set({ executionMode: "local" }).where(eq(workspaces.id, workspaceId));
    expect((await post(push())).status).toBe(200);
    expect(await configurations()).toHaveLength(0);
  });
  test("reports pending, succeeded and failed commit states through the tenant-pinned PAT transport", async () => {
    expect((await post(push())).status).toBe(200);
    const run = await db.query.runs.findFirst({ where: eq(runs.workspaceId, workspaceId) });
    expect(run).toBeDefined();
    for (const status of ["planning", "applied", "errored"]) await reportRunVcsStatus(run!.id, status);
    const statuses = requests
      .filter((request) => request.url.includes("/statuses?"))
      .map((request) => JSON.parse(request.body ?? "{}") as Record<string, unknown>);
    expect(statuses.slice(-3).map((status) => status["state"])).toEqual(["pending", "succeeded", "failed"]);
    expect(statuses.at(-1)?.["context"]).toEqual({ name: "terrence/azure", genre: "terrence" });
  });
  test("manual configurations resolve default branch and exact SHA, while invalid archives error", async () => {
    await db
      .update(workspaces)
      .set({ vcsRepo: { identifier, oauthTokenId: tokenId } })
      .where(eq(workspaces.id, workspaceId));
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const id = await createConfigurationVersionFromVcs(workspace!);
    expect(typeof id).toBe("string");
    const version = (await configurations())[0];
    expect(version?.status).toBe("uploaded");
    expect(version?.ingressAttributes?.commitSha).toBe(sha);
    archiveFailure = true;
    expect((await post(push())).status).toBe(200);
    expect((await configurations()).some((configuration) => configuration.status === "errored")).toBe(true);
  });
  test.each([
    "https://dev.azure.com/fabrikam/_git/platform",
    "https://fabrikam.visualstudio.com/Infrastructure/_git/platform",
    "https://fabrikam.visualstudio.com/DefaultCollection/Infrastructure/_git/platform",
    "https://fabrikam.visualstudio.com/_git/platform",
  ])("normalizes inbound Services repository URL %s without sending credentials there", async (remoteUrl) => {
    const payload = push();
    const resource = payload["resource"] as Record<string, unknown>;
    expect(
      (await post({ ...payload, resource: { ...resource, repository: { ...repository, remoteUrl } } })).status,
    ).toBe(200);
    expect(await configurations()).toHaveLength(1);
    expect(requests.every((request) => new URL(request.url).origin === "https://dev.azure.com")).toBe(true);
  });

  test("handles multiple refs and peels annotated tag objects without following a mutable tag name", async () => {
    await db
      .update(workspaces)
      .set({ vcsRepo: { identifier, tagsRegex: "^v", oauthTokenId: tokenId } })
      .where(eq(workspaces.id, workspaceId));
    const payload = push();
    const resource = payload["resource"] as Record<string, unknown>;
    expect(
      (
        await post({
          ...payload,
          resource: {
            ...resource,
            refUpdates: [
              { name: "refs/heads/main", oldObjectId: beforeSha, newObjectId: sha },
              { name: "refs/tags/v1.0.0", oldObjectId: "0".repeat(40), newObjectId: "c".repeat(40) },
              { name: "refs/tags/v1.0.1", oldObjectId: "0".repeat(40), newObjectId: sha },
            ],
          },
        })
      ).status,
    ).toBe(200);
    const versions = await configurations();
    expect(versions).toHaveLength(2);
    expect(versions.every((version) => version.ingressAttributes?.commitSha === sha)).toBe(true);
    expect(requests.filter((request) => request.url.includes("/items?"))).toHaveLength(1);
    expect(requests.some((request) => request.url.includes(`/annotatedtags/${"c".repeat(40)}`))).toBe(true);
  });

  test("synchronizes only the authenticated client's policy sets and preserves a sole policy directory", async () => {
    archiveEntries = [
      {
        name: "policies/sentinel.hcl",
        data: 'policy "approved" {\n  source = "./approved.sentinel"\n  enforcement_level = "hard-mandatory"\n}\n',
      },
      { name: "policies/approved.sentinel", data: "main = rule { true }\n" },
    ];
    diffPaths = ["/policies/sentinel.hcl", "/policies/approved.sentinel"];
    await db.insert(policySets).values([
      {
        id: "polset-ado-hook",
        orgId: organizationId,
        name: "Azure policies",
        kind: "sentinel",
        policiesPath: "/policies",
        vcsRepo: { identifier, branch: "main", oauthTokenId: tokenId },
      },
      {
        id: "polset-ado-isolated",
        orgId: organizationId,
        name: "Other policies",
        kind: "sentinel",
        policiesPath: "/policies",
        vcsRepo: { identifier, branch: "main", oauthTokenId: "ot-ado-isolated" },
      },
    ]);
    try {
      expect((await post(push())).status).toBe(200);
      const versions = await db.query.policySetVersions.findMany({
        where: eq(policySetVersions.policySetId, "polset-ado-hook"),
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]?.status).toBe("ready");
      expect(await db.query.policies.findMany({ where: eq(policies.policySetId, "polset-ado-hook") })).toHaveLength(1);
      expect(
        await db.query.policySetVersions.findMany({ where: eq(policySetVersions.policySetId, "polset-ado-isolated") }),
      ).toHaveLength(0);
    } finally {
      await db.delete(policySets).where(eq(policySets.orgId, organizationId));
    }
  });

  test("fails closed when submodule metadata is incomplete", async () => {
    await db
      .update(workspaces)
      .set({ vcsRepo: { identifier, branch: "main", oauthTokenId: tokenId, ingressSubmodules: true } })
      .where(eq(workspaces.id, workspaceId));
    expect((await post(push())).status).toBe(200);
    const versions = await configurations();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.status).toBe("errored");
    expect(requests.filter((request) => request.url.includes("/items?"))).toHaveLength(0);
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    expect(typeof (await createConfigurationVersionFromVcs(workspace!))).toBe("object");
  });

  test("ingests gitlink-pinned submodules through webhook and manual workspace sources", async () => {
    submoduleTree = true;
    diffPaths = ["/child"];
    await db
      .update(workspaces)
      .set({ vcsRepo: { identifier, branch: "main", oauthTokenId: tokenId, ingressSubmodules: true } })
      .where(eq(workspaces.id, workspaceId));
    expect((await post(push())).status).toBe(200);
    const versions = await configurations();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.status).toBe("uploaded");
    const path = versions[0]?.archivePath;
    expect(path).toBeDefined();
    const archive = gunzipSync(await Bun.file(path!).arrayBuffer());
    expect(archive.toString()).toContain("child/main.tf");
    expect(requests.some((request): boolean => request.url.includes(`/child/commits/${beforeSha}`))).toBe(true);
    expect(requests.some((request): boolean => request.url.includes("/items?"))).toBe(false);
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const created = await createConfigurationVersionFromVcs(workspace!);
    expect(typeof created).toBe("string");
    const manual = await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, created as string),
    });
    expect(manual?.status).toBe("uploaded");
  });

  test("does not share archives between recursive and non-recursive workspaces", async () => {
    submoduleTree = true;
    await db
      .update(workspaces)
      .set({ vcsRepo: { identifier, branch: "main", oauthTokenId: tokenId, ingressSubmodules: true } })
      .where(eq(workspaces.id, workspaceId));
    const otherId = "ws-ado-no-submodules";
    await db.insert(workspaces).values({
      id: otherId,
      orgId: organizationId,
      name: "no-submodules",
      queueAllRuns: true,
      vcsRepo: { identifier, branch: "main", oauthTokenId: tokenId, ingressSubmodules: false },
    });
    try {
      expect((await post(push())).status).toBe(200);
      const recursive = (await configurations())[0];
      const ordinary = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.workspaceId, otherId),
      });
      expect(recursive?.status).toBe("uploaded");
      expect(ordinary?.status).toBe("uploaded");
      expect(gunzipSync(await Bun.file(recursive!.archivePath!).arrayBuffer()).toString()).toContain("child/main.tf");
      expect(gunzipSync(await Bun.file(ordinary!.archivePath!).arrayBuffer()).toString()).not.toContain(
        "child/main.tf",
      );
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, otherId));
    }
  });

  test("synchronizes VCS policies from a gitlink-pinned submodule", async () => {
    submoduleTree = true;
    diffPaths = ["/child"];
    submoduleFiles = [
      {
        name: "sentinel.hcl",
        data: 'policy "approved" {\n  source = "./approved.sentinel"\n  enforcement_level = "hard-mandatory"\n}\n',
      },
      { name: "approved.sentinel", data: "main = rule { true }\n" },
    ];
    await db.insert(policySets).values({
      id: "polset-ado-submodules",
      orgId: organizationId,
      name: "Submodule policies",
      kind: "sentinel",
      policiesPath: "/child",
      vcsRepo: { identifier, branch: "main", oauthTokenId: tokenId, ingressSubmodules: true },
    });
    try {
      expect((await post(push())).status).toBe(200);
      const versions = await db.query.policySetVersions.findMany({
        where: eq(policySetVersions.policySetId, "polset-ado-submodules"),
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]?.status).toBe("ready");
      expect(
        await db.query.policies.findMany({ where: eq(policies.policySetId, "polset-ado-submodules") }),
      ).toHaveLength(1);
    } finally {
      await db.delete(policySets).where(eq(policySets.id, "polset-ado-submodules"));
    }
  });

  test("recovers a claim/enqueue crash gap and rejects concurrent or stale redeliveries", async () => {
    const payload = push();
    const deliveryId = `azure_devops:${clientId}:${String(payload["id"])}`;
    await db.insert(githubWebhookDeliveries).values({ id: deliveryId, status: "queued", receivedAt: Date.now() });
    const responses = await Promise.all([post(payload), post(payload), post(payload)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await configurations()).toHaveLength(1);
    expect((await post(payload)).status).toBe(200);
    expect(await configurations()).toHaveLength(1);
  });

  test("durable jobs retain the authenticated connection and dedupe redelivery", async () => {
    const original = process.env["TERRENCE_DISABLE_WORKER"];
    process.env["TERRENCE_DISABLE_WORKER"] = "0";
    const payload = push();
    try {
      expect((await post(payload)).status).toBe(200);
      expect((await post(payload)).status).toBe(200);
      const deliveryId = `azure_devops:${clientId}:${String(payload["id"])}`;
      const jobs = await db.query.durableJobs.findMany({ where: eq(durableJobs.dedupeKey, deliveryId) });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload["authenticatedClientId"]).toBe(clientId);
      expect(await configurations()).toHaveLength(0);
      await handleVcsWebhookJob(jobs[0]!);
      await handleVcsWebhookJob(jobs[0]!);
      expect(await configurations()).toHaveLength(1);
      const delivery = await db.query.githubWebhookDeliveries.findFirst({
        where: eq(githubWebhookDeliveries.id, deliveryId),
      });
      expect(delivery?.status).toBe("processed");
    } finally {
      if (original === undefined) delete process.env["TERRENCE_DISABLE_WORKER"];
      else process.env["TERRENCE_DISABLE_WORKER"] = original;
    }
  });
});
