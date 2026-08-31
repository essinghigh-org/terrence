import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  oauthClients,
  oauthTokens,
  organizationMemberships,
  organizations,
  policies,
  policySets,
  policySetVersions,
  users,
} from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/secrets";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";
import { handleBitbucketWebhook, handleGithubWebhook, handleGitlabWebhook } from "../../src/lib/webhooks";

const suffix = crypto.randomUUID();
const orgId = `org-policy-sync-${suffix}`;
const orgName = `policy-sync-${suffix}`;
const userId = `user-policy-sync-${suffix}`;
const apiToken = `token-policy-sync-${suffix}`;
const testDirectory = await mkdtemp(join(tmpdir(), "terrence-policy-sync-test-"));
const originalFetch = globalThis.fetch;

const providers = [
  {
    name: "github",
    repo: "platform/github-policies",
    sha: "1111111111111111111111111111111111111111",
    tokenId: `ot-policy-github-${suffix}`,
  },
  {
    name: "gitlab",
    repo: "platform/gitlab-policies",
    sha: "2222222222222222222222222222222222222222",
    tokenId: `ot-policy-gitlab-${suffix}`,
  },
  {
    name: "bitbucket",
    repo: "platform/bitbucket-policies",
    sha: "3333333333333333333333333333333333333333",
    tokenId: `ot-policy-bitbucket-${suffix}`,
  },
] as const;

const policySetId = (provider: string): string => `polset-sync-${provider}-${suffix}`;
const otherHostPolicySetId = `polset-sync-other-host-${suffix}`;
const otherHostClientId = `oc-policy-other-host-${suffix}`;
const otherHostTokenId = `ot-policy-other-host-${suffix}`;

async function archiveWith(files: Readonly<Record<string, string>>, name: string): Promise<Uint8Array> {
  const source = join(testDirectory, `${name}-source`);
  const repository = join(source, "repository-snapshot");
  await mkdir(repository, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(repository, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  const archive = join(testDirectory, `${name}.tar.gz`);
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", source, "repository-snapshot"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    tar.exited,
    new Response(tar.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Unable to create test archive: ${stderr}`);
  return new Uint8Array(await readFile(archive));
}

async function unsafeArchive(): Promise<Uint8Array> {
  const source = join(testDirectory, "unsafe-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "safe.txt"), "unsafe member");
  const archive = join(testDirectory, "unsafe.tar.gz");
  const tar = Bun.spawn([
    "tar",
    "-czf",
    archive,
    "--transform=s|safe.txt|../escaped.txt|",
    "-C",
    source,
    "safe.txt",
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    tar.exited,
    new Response(tar.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Unable to create unsafe test archive: ${stderr}`);
  return new Uint8Array(await readFile(archive));
}

function apiRequest(path: string, method = "GET", body?: unknown): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

function githubPayload(repo: string, sha: string, changed = "policy-sets/foo/deny.sentinel"): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    after: sha,
    repository: {
      full_name: repo,
      clone_url: `https://github.example/${repo}.git`,
      default_branch: "main",
    },
    sender: { login: "github-user" },
    head_commit: {
      message: "Update policies",
      url: `https://github.example/${repo}/commit/${sha}`,
    },
    commits: [{ added: [], modified: [changed], removed: [] }],
  };
}

function gitlabPayload(repo: string, sha: string, changed = "policy-sets/foo/deny.sentinel"): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    checkout_sha: sha,
    user_username: "gitlab-user",
    project: {
      path_with_namespace: repo,
      git_http_url: `https://gitlab.example/${repo}.git`,
      web_url: `https://gitlab.example/${repo}`,
      default_branch: "main",
    },
    commits: [{
      id: sha,
      message: "Update policies",
      url: `https://gitlab.example/${repo}/-/commit/${sha}`,
      added: [],
      modified: [changed],
      removed: [],
    }],
  };
}

function bitbucketPayload(repo: string, sha: string): Record<string, unknown> {
  return {
    actor: { nickname: "bitbucket-user" },
    repository: {
      full_name: repo,
      links: { clone: [{ name: "https", href: `https://bitbucket.org/${repo}.git` }] },
    },
    push: {
      changes: [{
        new: {
          type: "branch",
          name: "main",
          target: {
            hash: sha,
            message: "Update policies",
            links: { html: { href: `https://bitbucket.org/${repo}/commits/${sha}` } },
          },
        },
      }],
    },
  };
}

async function triggerProvider(provider: typeof providers[number]): Promise<void> {
  if (provider.name === "github") {
    await handleGithubWebhook("push", githubPayload(provider.repo, provider.sha));
  } else if (provider.name === "gitlab") {
    expect(await handleGitlabWebhook("Push Hook", gitlabPayload(provider.repo, provider.sha))).toBe(true);
  } else {
    expect(await handleBitbucketWebhook("repo:push", bitbucketPayload(provider.repo, provider.sha))).toBe(true);
  }
}

describe("VCS-backed policy set synchronization", () => {
  const fetches: { authorization: string | null; url: string }[] = [];
  let sentinelArchive: Uint8Array;
  let opaArchive: Uint8Array;
  let maliciousArchive: Uint8Array;

  beforeAll(async () => {
    [sentinelArchive, opaArchive, maliciousArchive] = await Promise.all([
      archiveWith({
        "policy-sets/foo/sentinel.hcl": `
          policy "deny-unapproved" {
            source = "./deny.sentinel"
            enforcement_level = "hard-mandatory"
            description = "Only approved changes"
          }
        `,
        "policy-sets/foo/deny.sentinel": "main = rule { true }\n",
      }, "sentinel"),
      archiveWith({
        "opa/policies.hcl": `
          policy "deny-public" {
            query = "data.terraform.deny_public.deny"
            enforcement_level = "mandatory"
            description = "No public resources"
          }
        `,
        "opa/deny.rego": "package terraform.deny_public\n\ndeny := []\n",
      }, "opa"),
      unsafeArchive(),
    ]);

    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token: hashAuthenticationToken(apiToken), userId });
    await db.insert(oauthClients).values([
      {
        id: `oc-policy-github-${suffix}`,
        orgId,
        name: "GitHub",
        serviceProvider: "github",
        apiUrl: "https://github.example/api/v3",
      },
      {
        id: `oc-policy-gitlab-${suffix}`,
        orgId,
        name: "GitLab",
        serviceProvider: "gitlab",
        apiUrl: "https://gitlab.example/api/v4",
      },
      {
        id: `oc-policy-bitbucket-${suffix}`,
        orgId,
        name: "Bitbucket",
        serviceProvider: "bitbucket",
      },
      {
        id: otherHostClientId,
        orgId,
        name: "Other GitHub host",
        serviceProvider: "github",
        apiUrl: "https://other-github.example/api/v3",
      },
    ]);
    await db.insert(oauthTokens).values(await Promise.all(providers.map(async (provider) => ({
      id: provider.tokenId,
      oauthClientId: `oc-policy-${provider.name}-${suffix}`,
      token: await encryptSecret(`${provider.name}-policy-token`),
    }))));
    await db.insert(oauthTokens).values({
      id: otherHostTokenId,
      oauthClientId: otherHostClientId,
      token: await encryptSecret("other-host-policy-token"),
    });
    await db.insert(policySets).values(providers.map((provider) => ({
      id: policySetId(provider.name),
      orgId,
      name: `${provider.name} policies`,
      kind: "sentinel",
      policiesPath: "/policy-sets/foo",
      policyUpdatePatterns: ["policy-sets/foo/**/*.sentinel", "policy-sets/foo/sentinel.hcl"],
      vcsRepo: {
        identifier: provider.repo,
        branch: "main",
        oauthTokenId: provider.tokenId,
      },
    })));
    await db.insert(policySets).values({
      id: otherHostPolicySetId,
      orgId,
      name: "Other GitHub host policies",
      kind: "sentinel",
      policiesPath: "/policy-sets/foo",
      policyUpdatePatterns: ["policy-sets/foo/**/*.sentinel", "policy-sets/foo/sentinel.hcl"],
      vcsRepo: {
        identifier: providers[0].repo,
        branch: "main",
        oauthTokenId: otherHostTokenId,
      },
    });
    await db.insert(policies).values(providers.map((provider) => ({
      id: `pol-old-${provider.name}-${suffix}`,
      policySetId: policySetId(provider.name),
      name: "old-policy",
      enforcementLevel: "advisory",
      query: "main = true",
    })));

    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      fetches.push({ authorization: headers.get("authorization"), url });
      const archive = url.includes("unsafe-policies")
        ? maliciousArchive
        : url.includes("opa-policies")
          ? opaArchive
          : sentinelArchive;
      return new Response(archive.slice().buffer, {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      });
    };
    setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
      const requestInit: RequestInit = { method: init.method };
      if (init.headers !== undefined) requestInit.headers = init.headers;
      if (init.body !== undefined) requestInit.body = init.body;
      return mockFetch(target.url, requestInit);
    });
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
  });

  afterAll(async () => {
    setExternalUrlTransportForTests(undefined);
    globalThis.fetch = originalFetch;
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
    await rm(testDirectory, { recursive: true, force: true });
  });

  test("validates, persists, and returns the VCS repository and update patterns contract", async () => {
    const create = await apiRequest(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
      data: {
        type: "policy-sets",
        attributes: {
          name: "contract-policy-set",
          kind: "sentinel",
          "policies-path": "/policy-sets/foo",
          "policy-update-patterns": ["policy-sets/foo/**/*.sentinel"],
          "vcs-repo": {
            branch: "main",
            identifier: "platform/contract-policies",
            "oauth-token-id": providers[0].tokenId,
            "ingress-submodules": false,
          },
        },
      },
    });
    expect(create.status).toBe(201);
    const body = await create.json();
    const id = body.data.id as string;
    expect(body.data.attributes).toMatchObject({
      "policies-path": "/policy-sets/foo",
      "policy-update-patterns": ["policy-sets/foo/**/*.sentinel"],
      "vcs-repo": {
        branch: "main",
        identifier: "platform/contract-policies",
        "oauth-token-id": providers[0].tokenId,
        "ingress-submodules": false,
      },
    });

    const patch = await apiRequest(`/api/v2/policy-sets/${id}`, "PATCH", {
      data: {
        type: "policy-sets",
        attributes: { "policy-update-patterns": ["shared/**/*.sentinel"] },
      },
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).data.attributes["policy-update-patterns"]).toEqual(["shared/**/*.sentinel"]);
    expect((await db.query.policySets.findFirst({ where: eq(policySets.id, id) }))?.vcsRepo).toMatchObject({
      identifier: "platform/contract-policies",
      oauthTokenId: providers[0].tokenId,
    });

    const tooManyPatterns = await apiRequest(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
      data: {
        attributes: {
          name: "too-many-patterns",
          "vcs-repo": { identifier: "platform/too-many", "oauth-token-id": providers[0].tokenId },
          "policy-update-patterns": Array.from({ length: 101 }, (_, index): string => `policy-${String(index)}.sentinel`),
        },
      },
    });
    expect(tooManyPatterns.status).toBe(422);

    const pathWithoutVcs = await apiRequest(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
      data: { attributes: { name: "path-without-vcs", "policies-path": "/policies" } },
    });
    expect(pathWithoutVcs.status).toBe(422);
    expect((await apiRequest(`/api/v2/policy-sets/${id}/policies`, "POST", {
      data: { attributes: { name: "manual", query: "main = true" } },
    })).status).toBe(422);
  });

  test("synchronizes Sentinel policy rows through GitHub, GitLab, and Bitbucket webhooks", async () => {
    for (const provider of providers) {
      await triggerProvider(provider);
      const version = await db.query.policySetVersions.findFirst({
        where: eq(policySetVersions.policySetId, policySetId(provider.name)),
        orderBy: [desc(policySetVersions.createdAt)],
      });
      expect(version).toMatchObject({
        source: provider.name,
        status: "ready",
        ingressAttributes: {
          provider: provider.name,
          repository: provider.repo,
          commitSha: provider.sha,
          manifest: "policy-sets/foo/sentinel.hcl",
          policyCount: 1,
        },
      });
      const rows = await db.query.policies.findMany({
        where: eq(policies.policySetId, policySetId(provider.name)),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "deny-unapproved",
        enforcementLevel: "hard-mandatory",
        query: "main = rule { true }\n",
        source: "main = rule { true }\n",
        sourcePath: "policy-sets/foo/deny.sentinel",
        policySetVersionId: version?.id,
      });
      expect(fetches).toContainEqual(expect.objectContaining({
        authorization: `Bearer ${provider.name}-policy-token`,
      }));
    }
  });

  test("does not synchronize a policy set on another provider host", async () => {
    const before = await db.query.policySetVersions.findMany({
      where: eq(policySetVersions.policySetId, policySetId("github")),
    });
    await triggerProvider(providers[0]);
    const after = await db.query.policySetVersions.findMany({
      where: eq(policySetVersions.policySetId, policySetId("github")),
    });
    const otherHostVersions = await db.query.policySetVersions.findMany({
      where: eq(policySetVersions.policySetId, otherHostPolicySetId),
    });
    expect(after).toHaveLength(before.length + 1);
    expect(otherHostVersions).toHaveLength(0);
  });

  test("does not synchronize when changed files miss policy-update-patterns", async () => {
    const before = await db.query.policySetVersions.findMany({
      where: eq(policySetVersions.policySetId, policySetId("github")),
    });
    await handleGithubWebhook(
      "push",
      githubPayload("platform/github-policies", "4444444444444444444444444444444444444444", "docs/readme.md"),
    );
    const after = await db.query.policySetVersions.findMany({
      where: eq(policySetVersions.policySetId, policySetId("github")),
    });
    expect(after).toHaveLength(before.length);
  });

  test("parses policies.hcl and preserves the OPA query with executable Rego source", async () => {
    const id = `polset-sync-opa-${suffix}`;
    await db.insert(policySets).values({
      id,
      orgId,
      name: "OPA policies",
      kind: "opa",
      policiesPath: "/opa",
      policyUpdatePatterns: ["opa/**"],
      vcsRepo: {
        identifier: "platform/opa-policies",
        branch: "main",
        oauthTokenId: providers[1].tokenId,
      },
    });
    await handleGitlabWebhook(
      "Push Hook",
      gitlabPayload("platform/opa-policies", "5555555555555555555555555555555555555555", "opa/deny.rego"),
    );
    const row = await db.query.policies.findFirst({ where: eq(policies.policySetId, id) });
    expect(row).toMatchObject({
      name: "deny-public",
      description: "No public resources",
      enforcementLevel: "hard-mandatory",
      query: "data.terraform.deny_public.deny",
    });
    expect(row?.source).toContain("package terraform.deny_public");
    expect((await db.query.policySetVersions.findFirst({
      where: eq(policySetVersions.policySetId, id),
      orderBy: [desc(policySetVersions.createdAt)],
    }))?.status).toBe("ready");
  });

  test("records an errored version and leaves existing policies untouched for an unsafe archive", async () => {
    const id = `polset-sync-unsafe-${suffix}`;
    await db.insert(policySets).values({
      id,
      orgId,
      name: "Unsafe policies",
      kind: "sentinel",
      policyUpdatePatterns: ["deny.sentinel"],
      vcsRepo: {
        identifier: "platform/unsafe-policies",
        branch: "main",
        oauthTokenId: providers[0].tokenId,
      },
    });
    const oldPolicyId = `pol-unsafe-old-${suffix}`;
    await db.insert(policies).values({
      id: oldPolicyId,
      policySetId: id,
      name: "existing-policy",
      enforcementLevel: "advisory",
      query: "main = true",
    });
    await handleGithubWebhook(
      "push",
      githubPayload("platform/unsafe-policies", "6666666666666666666666666666666666666666", "deny.sentinel"),
    );
    const version = await db.query.policySetVersions.findFirst({
      where: eq(policySetVersions.policySetId, id),
      orderBy: [desc(policySetVersions.createdAt)],
    });
    expect(version?.status).toBe("errored");
    expect(version?.error).toContain("unsafe path");
    expect(version?.statusTimestamps.erroredAt).toBeString();
    expect(version?.archivePath).toBeNull();
    expect((await db.query.policies.findMany({ where: eq(policies.policySetId, id) })).map((row) => row.id)).toEqual([oldPolicyId]);
  });
});