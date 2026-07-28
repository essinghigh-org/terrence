import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  configurationVersions,
  oauthClients,
  oauthTokens,
  organizations,
  runs,
  workspaces,
} from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/secrets";
import { refetchConfigurationVersion, reportRunVcsStatus } from "../../src/lib/webhooks";

const orgId = "org-provider-webhooks";
const gitlabWorkspaceId = "ws-provider-gitlab";
const bitbucketWorkspaceId = "ws-provider-bitbucket";
const gitlabTokenId = "ot-provider-gitlab";
const bitbucketTokenId = "ot-provider-bitbucket";
const originalFetch = globalThis.fetch;
const originalGitlabSecret = process.env["GITLAB_WEBHOOK_SECRET"];
const originalBitbucketSecret = process.env["BITBUCKET_WEBHOOK_SECRET"];
const fetches: { authorization: string | null; url: string }[] = [];
const requestBodies: { body: string; url: string }[] = [];

const gitlabPayload = {
  object_kind: "push",
  ref: "refs/heads/main",
  checkout_sha: "1234567890abcdef1234567890abcdef12345678",
  user_username: "gitlab-user",
  project: {
    path_with_namespace: "platform/infrastructure",
    git_http_url: "https://gitlab.example/platform/infrastructure.git",
    web_url: "https://gitlab.example/platform/infrastructure",
  },
  commits: [{
    id: "1234567890abcdef1234567890abcdef12345678",
    message: "Update infrastructure",
    url: "https://gitlab.example/platform/infrastructure/-/commit/1234567890abcdef1234567890abcdef12345678",
    added: ["main.tf"],
    modified: [],
    removed: [],
  }],
};

const bitbucketPayload = {
  actor: { nickname: "bitbucket-user" },
  repository: {
    full_name: "platform/infrastructure",
    links: {
      clone: [{ name: "https", href: "https://bitbucket.org/platform/infrastructure.git" }],
    },
  },
  push: {
    changes: [{
      new: {
        type: "branch",
        name: "main",
        target: {
          hash: "abcdef1234567890abcdef1234567890abcdef12",
          message: "Update infrastructure",
          links: {
            html: {
              href: "https://bitbucket.org/platform/infrastructure/commits/abcdef1234567890abcdef1234567890abcdef12",
            },
          },
        },
      },
    }],
  },
};

async function waitForUploaded(workspaceId: string): Promise<typeof configurationVersions.$inferSelect | undefined> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const version = await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.workspaceId, workspaceId),
    });
    if (version?.status === "uploaded" || version?.status === "errored") return version;
    await Bun.sleep(10);
  }
  return db.query.configurationVersions.findFirst({
    where: eq(configurationVersions.workspaceId, workspaceId),
  });
}

function bitbucketSignature(rawBody: string): string {
  return `sha256=${createHmac("sha256", "bitbucket-secret").update(rawBody).digest("hex")}`;
}

describe("GitLab and Bitbucket webhooks", () => {
  beforeAll(async () => {
    process.env["GITLAB_WEBHOOK_SECRET"] = "gitlab-secret";
    process.env["BITBUCKET_WEBHOOK_SECRET"] = "bitbucket-secret";
    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      fetches.push({ authorization: headers.get("authorization"), url });
      const body = init?.body;
      requestBodies.push({
        body: body instanceof URLSearchParams ? body.toString() : typeof body === "string" ? body : "",
        url,
      });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });

    await db.insert(organizations).values({ id: orgId, name: "provider-webhooks" });
    await db.insert(oauthClients).values([
      {
        id: "oc-provider-gitlab",
        orgId,
        name: "GitLab",
        serviceProvider: "gitlab",
        apiUrl: "https://gitlab.example/api/v4",
      },
      {
        id: "oc-provider-bitbucket",
        orgId,
        name: "Bitbucket",
        serviceProvider: "bitbucket",
      },
    ]);
    await db.insert(oauthTokens).values([
      {
        id: gitlabTokenId,
        oauthClientId: "oc-provider-gitlab",
        token: await encryptSecret("gitlab-token"),
      },
      {
        id: bitbucketTokenId,
        oauthClientId: "oc-provider-bitbucket",
        token: await encryptSecret("bitbucket-token"),
      },
    ]);
    await db.insert(workspaces).values([
      {
        id: gitlabWorkspaceId,
        orgId,
        name: "gitlab-workspace",
        vcsRepo: {
          identifier: "platform/infrastructure",
          branch: "main",
          oauthTokenId: gitlabTokenId,
        },
        queueAllRuns: true,
      },
      {
        id: bitbucketWorkspaceId,
        orgId,
        name: "bitbucket-workspace",
        vcsRepo: {
          identifier: "platform/infrastructure",
          branch: "main",
          oauthTokenId: bitbucketTokenId,
        },
        queueAllRuns: true,
      },
    ]);
  });

  beforeEach(async () => {
    fetches.length = 0;
    requestBodies.length = 0;
    await db.delete(runs).where(eq(runs.workspaceId, gitlabWorkspaceId));
    await db.delete(runs).where(eq(runs.workspaceId, bitbucketWorkspaceId));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, gitlabWorkspaceId));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, bitbucketWorkspaceId));
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    process.env["GITLAB_WEBHOOK_SECRET"] = originalGitlabSecret;
    process.env["BITBUCKET_WEBHOOK_SECRET"] = originalBitbucketSecret;
  });

  test("validates GitLab token, parses a push, queues a run, and downloads configuration", async () => {
    const rawBody = JSON.stringify(gitlabPayload);
    const response = await app.handle(new Request("http://127.0.0.1/api/webhooks/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        "x-gitlab-event": "Push Hook",
        "x-gitlab-token": "gitlab-secret",
      },
      body: rawBody,
    }));
    expect(response.status).toBe(200);
    const version = await waitForUploaded(gitlabWorkspaceId);
    const run = await db.query.runs.findFirst({ where: eq(runs.workspaceId, gitlabWorkspaceId) });
    expect(version).toMatchObject({
      source: "gitlab",
      status: "uploaded",
      ingressAttributes: {
        branch: "main",
        commitSha: gitlabPayload.checkout_sha,
        senderUsername: "gitlab-user",
      },
    });
    expect(run?.planOnly).toBe(false);
    expect(fetches).toContainEqual({
      authorization: "Bearer gitlab-token",
      url: `https://gitlab.example/api/v4/projects/platform%2Finfrastructure/repository/archive.tar.gz?sha=${gitlabPayload.checkout_sha}`,
    });
    if (run === undefined || version === undefined) throw new Error("Expected GitLab run and configuration version");
    await reportRunVcsStatus(run.id, "applied");
    expect(requestBodies.some(({ body, url }): boolean =>
      url.includes(`/statuses/${gitlabPayload.checkout_sha}`)
      && new URLSearchParams(body).get("state") === "success")).toBe(true);

    await db.update(configurationVersions)
      .set({ archivePath: null, status: "archived" })
      .where(eq(configurationVersions.id, version.id));
    expect(await refetchConfigurationVersion(version.id)).toBe(true);
    expect((await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, version.id),
    }))?.status).toBe("uploaded");
  });

  test("rejects an invalid GitLab token without creating a run", async () => {
    const response = await app.handle(new Request("http://127.0.0.1/api/webhooks/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        "x-gitlab-event": "Push Hook",
        "x-gitlab-token": "wrong",
      },
      body: JSON.stringify(gitlabPayload),
    }));
    expect(response.status).toBe(401);
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, gitlabWorkspaceId) })).toHaveLength(0);
  });

  test("validates Bitbucket HMAC, parses a push, queues a run, and downloads configuration", async () => {
    const rawBody = JSON.stringify(bitbucketPayload);
    const response = await app.handle(new Request("http://127.0.0.1/api/webhooks/bitbucket", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        "x-event-key": "repo:push",
        "x-hub-signature": bitbucketSignature(rawBody),
      },
      body: rawBody,
    }));
    expect(response.status).toBe(200);
    const version = await waitForUploaded(bitbucketWorkspaceId);
    const run = await db.query.runs.findFirst({ where: eq(runs.workspaceId, bitbucketWorkspaceId) });
    expect(version).toMatchObject({
      source: "bitbucket",
      status: "uploaded",
      ingressAttributes: {
        branch: "main",
        commitSha: "abcdef1234567890abcdef1234567890abcdef12",
        senderUsername: "bitbucket-user",
      },
    });
    expect(run?.planOnly).toBe(false);
    expect(fetches).toContainEqual({
      authorization: "Bearer bitbucket-token",
      url: "https://api.bitbucket.org/2.0/repositories/platform/infrastructure/src/abcdef1234567890abcdef1234567890abcdef12.tar.gz",
    });
    if (run === undefined) throw new Error("Expected Bitbucket run");
    await reportRunVcsStatus(run.id, "errored");
    expect(requestBodies.some(({ body, url }): boolean => {
      if (!url.endsWith("/statuses/build")) return false;
      const parsed = JSON.parse(body) as { state?: unknown };
      return parsed.state === "FAILED";
    })).toBe(true);
  });

  test("rejects an invalid Bitbucket signature without creating a run", async () => {
    const response = await app.handle(new Request("http://127.0.0.1/api/webhooks/bitbucket", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        "x-event-key": "repo:push",
        "x-hub-signature": "sha256=wrong",
      },
      body: JSON.stringify(bitbucketPayload),
    }));
    expect(response.status).toBe(401);
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, bitbucketWorkspaceId) })).toHaveLength(0);
  });
});
