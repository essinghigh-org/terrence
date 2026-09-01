import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { setExternalUrlTransportForTests } from "../src/lib/url-safety";
import { handleGitlabWebhook, gitlabPushCommitListTruncated } from "../src/lib/webhooks";
import { configurationVersions, oauthClients, oauthTokens, organizations, runs, workspaces } from "../src/db/schema";

describe("GitLab merge-request file trigger filtering (kanban 1.6)", () => {
  const orgId = "org-gitlab-filter-test";
  const workspaceId = "ws-gitlab-filter-test";
  const oauthClientId = "oauthc-gitlab-filter-test";
  const oauthTokenId = "oautht-gitlab-filter-test";
  const originalFetch = globalThis.fetch;
  let mergeRequestDiffs: unknown = [{ old_path: "docs/readme.md", new_path: "docs/readme.md" }];
  let mergeRequestDiffPageTwo: unknown | undefined;
  let mergeRequestNextPage: string | null = null;
  let tarballFetches = 0;
  const mergeRequestUrls: string[] = [];

  function mrPayload(): Record<string, unknown> {
    return {
      object_attributes: {
        action: "open",
        iid: 7,
        source_branch: "feature",
        target_branch: "main",
        title: "Add feature",
        url: "https://gitlab.example.com/acme/infra/-/merge_requests/7",
        last_commit: {
          id: "abcdef123abcdef123abcdef123abcdef123abcd",
          url: "https://gitlab.example.com/acme/infra/-/commit/abcdef123abcdef123abcdef123abcdef123abcd",
          message: "Add feature",
        },
      },
      project: {
        path_with_namespace: "acme/infra",
        git_http_url: "https://gitlab.example.com/acme/infra.git",
        web_url: "https://gitlab.example.com/acme/infra",
      },
      user_username: "octocat",
      user: { username: "octocat" },
    };
  }

  beforeAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(oauthTokens).where(eq(oauthTokens.id, oauthTokenId));
    await db.delete(oauthClients).where(eq(oauthClients.id, oauthClientId));
    await db.delete(organizations).where(eq(organizations.id, orgId));

    await db.insert(organizations).values({ id: orgId, name: "gitlab-filter-org" });
    await db.insert(oauthClients).values({
      id: oauthClientId,
      orgId,
      name: "gitlab-self-hosted",
      serviceProvider: "gitlab",
      apiUrl: "https://gitlab.example.com/api/v4",
      httpUrl: "https://gitlab.example.com",
      key: "test-key",
      secret: "test-secret",
    });
    await db.insert(oauthTokens).values({
      id: oauthTokenId,
      oauthClientId,
      token: "glpat-plaintext-test-token",
      createdAt: Date.now(),
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      name: "gitlab-filter-ws",
      vcsRepo: { identifier: "acme/infra", branch: "main", oauthTokenId },
      fileTriggersEnabled: true,
      triggerPatterns: ["src/**"],
      speculativeEnabled: true,
      queueAllRuns: true,
    });

    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      mergeRequestUrls.push(url);
      if (url.includes("/merge_requests/7/diffs")) {
        const page = new URL(url).searchParams.get("page");
        const responseBody = page === "2" && mergeRequestDiffPageTwo !== undefined ? mergeRequestDiffPageTwo : mergeRequestDiffs;
        if (responseBody instanceof Response) return responseBody;
        const headers = page === "1" && mergeRequestNextPage !== null ? { "x-next-page": mergeRequestNextPage } : {};
        return Response.json(responseBody, { headers });
      }
      if (url.includes("/tarball/") || url.includes("archive.tar.gz")) {
        tarballFetches += 1;
        return new Response(new Uint8Array([1, 2, 3]));
      }
      if (url.includes("/statuses/")) return Response.json({});
      throw new Error(`Unexpected outbound request: ${url}`);
    };
    setExternalUrlTransportForTests(async (target): Promise<Response> => mockFetch(target.url));
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
  });

  beforeEach(async () => {
    mergeRequestDiffs = [{ old_path: "docs/readme.md", new_path: "docs/readme.md" }];
    mergeRequestDiffPageTwo = undefined;
    mergeRequestNextPage = null;
    tarballFetches = 0;
    mergeRequestUrls.length = 0;
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
  });

  afterAll(async () => {
    setExternalUrlTransportForTests(undefined);
    globalThis.fetch = originalFetch;
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(oauthTokens).where(eq(oauthTokens.id, oauthTokenId));
    await db.delete(oauthClients).where(eq(oauthClients.id, oauthClientId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  async function runCount(): Promise<number> {
    const list = await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) });
    return list.length;
  }

  function resetTarballCounter(): void {
    tarballFetches = 0;
  }

  it("does not create a run when the MR changes do not match the trigger patterns", async () => {
    resetTarballCounter();
    mergeRequestDiffs = [{ old_path: "docs/readme.md", new_path: "docs/readme.md" }];
    const handled = await handleGitlabWebhook("Merge Request Hook", mrPayload());
    expect(handled).toBe(true);
    expect(await runCount()).toBe(0);
    // No run means no configuration download either.
    expect(tarballFetches).toBe(0);
  });

  it("creates a speculative run when the MR changes match the trigger patterns", async () => {
    resetTarballCounter();
    mergeRequestDiffs = [{ old_path: "src/main.tf", new_path: "src/main.tf" }, { old_path: "docs/readme.md", new_path: "docs/readme.md" }];
    const handled = await handleGitlabWebhook("Merge Request Hook", mrPayload());
    expect(handled).toBe(true);
    expect(await runCount()).toBe(1);
    const created = await db.query.runs.findFirst({ where: eq(runs.workspaceId, workspaceId) });
    expect(created?.id).toBeDefined();
    expect(tarballFetches).toBe(1);
  });

  it("combines paginated diffs and includes renamed/deleted paths", async () => {
    mergeRequestDiffs = [{ old_path: "docs/readme.md", new_path: "docs/readme.md" }];
    mergeRequestDiffPageTwo = [
      { old_path: "src/old.tf", new_path: "src/new.tf", renamed_file: true },
      { old_path: "src/removed.tf", new_path: "", deleted_file: true },
    ];
    mergeRequestNextPage = "2";
    const handled = await handleGitlabWebhook("Merge Request Hook", mrPayload());
    expect(handled).toBe(true);
    expect(await runCount()).toBe(1);
    expect(mergeRequestUrls.filter((url): boolean => url.includes("/merge_requests/7/diffs"))).toEqual([
      "https://gitlab.example.com/api/v4/projects/acme%2Finfra/merge_requests/7/diffs?per_page=100&page=1",
      "https://gitlab.example.com/api/v4/projects/acme%2Finfra/merge_requests/7/diffs?per_page=100&page=2",
    ]);
  });

  it("fails open when GitLab reports an incomplete diff", async () => {
    mergeRequestDiffs = [{
      old_path: "src/main.tf",
      new_path: "src/main.tf",
      too_large: true,
    }];
    const handled = await handleGitlabWebhook("Merge Request Hook", mrPayload());
    expect(handled).toBe(true);
    expect(await runCount()).toBe(1);
    expect(tarballFetches).toBe(1);
  });

  it("fails open when the GitLab diffs payload is malformed", async () => {
    // A 200 response with an unusable body must not drop the event.
    const before = await runCount();
    mergeRequestDiffs = { changes: "not-an-array" } as unknown as Record<string, unknown>;
    const handled = await handleGitlabWebhook("Merge Request Hook", mrPayload());
    expect(handled).toBe(true);
    expect(await runCount()).toBe(before + 1);
  });

  it("falls back to trigger-all when the MR changes fetch fails", async () => {
    // A failed/404 changes fetch must not drop the event: the run still fires.
    const before = await runCount();
    mergeRequestDiffs = new Response("not found", { status: 404 }) as unknown as Record<string, unknown>;
    const handled = await handleGitlabWebhook("Merge Request Hook", mrPayload());
    expect(handled).toBe(true);
    expect(await runCount()).toBe(before + 1);
  });

  it("fails open when GitLab truncates the inline push commit list", async () => {
    const payload = {
      ref: "refs/heads/main",
      after: "abcdef123abcdef123abcdef123abcdef123abcd",
      total_commits_count: 21,
      commits: [{ modified: ["docs/readme.md"] }],
      project: {
        path_with_namespace: "acme/infra",
        git_http_url: "https://gitlab.example.com/acme/infra.git",
        web_url: "https://gitlab.example.com/acme/infra",
      },
      user_username: "octocat",
    };
    expect(gitlabPushCommitListTruncated(payload)).toBeTrue();
    const handled = await handleGitlabWebhook("Push Hook", payload);
    expect(handled).toBe(true);
    expect(await runCount()).toBe(1);
    expect(tarballFetches).toBe(1);
  });
});
