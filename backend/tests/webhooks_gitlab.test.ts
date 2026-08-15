import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { handleGitlabWebhook } from "../src/lib/webhooks";
import {
  oauthClients,
  oauthTokens,
  organizations,
  runs,
  workspaces,
} from "../src/db/schema";

describe("GitLab merge-request file trigger filtering (kanban 1.6)", () => {
  const orgId = "org-gitlab-filter-test";
  const workspaceId = "ws-gitlab-filter-test";
  const oauthClientId = "oauthc-gitlab-filter-test";
  const oauthTokenId = "oautht-gitlab-filter-test";
  const originalFetch = globalThis.fetch;
  let mergeRequestChanges: unknown = { changes: [{ new_path: "docs/readme.md" }] };
  let tarballFetches = 0;

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
      if (url.includes("/merge_requests/7/changes")) return Response.json(mergeRequestChanges);
      if (url.includes("/tarball/")) {
        tarballFetches += 1;
        return new Response(new Uint8Array([1, 2, 3]));
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
  });

  afterAll(async () => {
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

  it("does not create a run when the MR changes do not match the trigger patterns", async () => {
    mergeRequestChanges = { changes: [{ new_path: "docs/readme.md" }] };
    const handled = await handleGitlabWebhook("Merge Request Hook", mrPayload());
    expect(handled).toBe(true);
    expect(await runCount()).toBe(0);
  });

  it("creates a speculative run when the MR changes match the trigger patterns", async () => {
    mergeRequestChanges = { changes: [{ new_path: "src/main.tf" }, { new_path: "docs/readme.md" }] };
    const handled = await handleGitlabWebhook("Merge Request Hook", mrPayload());
    expect(handled).toBe(true);
    expect(await runCount()).toBe(1);
    const created = await db.query.runs.findFirst({ where: eq(runs.workspaceId, workspaceId) });
    expect(created?.id).toBeDefined();
  });

  it("falls back to trigger-all when the MR changes fetch fails", async () => {
    // A failed/404 changes fetch must not drop the event: the run still fires.
    const before = await runCount();
    mergeRequestChanges = { changes: "not-an-array" } as unknown as Record<string, unknown>;
    const handled = await handleGitlabWebhook("Merge Request Hook", mrPayload());
    expect(handled).toBe(true);
    expect(await runCount()).toBe(before + 1);
  });
});
