import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  oauthClients,
  oauthTokens,
  organizationMemberships,
  organizations,
  users,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";

const suffix = crypto.randomUUID();
const orgId = `org-repository-discovery-${suffix}`;
const orgName = `repository-discovery-${suffix}`;
const outsiderOrgId = `org-repository-discovery-outsider-${suffix}`;
const outsiderOrgName = `repository-discovery-outsider-${suffix}`;
const userId = `usr-repository-discovery-${suffix}`;
const apiToken = `token-repository-discovery-${suffix}`;

const githubClientId = `oc-repository-discovery-github-${suffix}`;
const githubEnterpriseClientId = `oc-repository-discovery-ghe-${suffix}`;
const gitlabClientId = `oc-repository-discovery-gitlab-${suffix}`;
const bitbucketClientId = `oc-repository-discovery-bitbucket-${suffix}`;
const boundedBitbucketClientId = `oc-repository-discovery-bitbucket-bounded-${suffix}`;
const outsiderClientId = `oc-repository-discovery-outsider-${suffix}`;

const githubTokenId = `ot-repository-discovery-github-${suffix}`;
const githubEnterpriseTokenId = `ot-repository-discovery-ghe-${suffix}`;
const gitlabTokenId = `ot-repository-discovery-gitlab-${suffix}`;
const bitbucketTokenId = `ot-repository-discovery-bitbucket-${suffix}`;
const boundedBitbucketTokenId = `ot-repository-discovery-bitbucket-bounded-${suffix}`;
const outsiderTokenId = `ot-repository-discovery-outsider-${suffix}`;

const calls: { authorization: string | null; url: string }[] = [];

function request(connectionId: string): Promise<Response> {
  return app.handle(new Request(
    `http://terrence.test/api/v2/organizations/${orgName}/vcs-connections/${connectionId}/repositories`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  ));
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeAll(async () => {
  setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
    const url = target.url;
    const headers = new Headers(init.headers);
    calls.push({ authorization: headers.get("authorization"), url });
    const parsed = new URL(url);

    if (parsed.hostname === "api.github.com") {
      return jsonResponse([{ full_name: "octo/public-repository", name: "public-repository", owner: { login: "octo" } }]);
    }
    if (parsed.hostname === "github.enterprise.test") {
      if (parsed.searchParams.get("page") === "2") {
        return jsonResponse([{ full_name: "enterprise/second", name: "second", owner: { login: "enterprise" } }]);
      }
      return jsonResponse(
        [{ full_name: "enterprise/first", name: "first", owner: { login: "enterprise" } }],
        { Link: '<https://github.enterprise.test/api/v3/user/repos?per_page=100&sort=updated&page=2>; rel="next"' },
      );
    }
    if (parsed.hostname === "gitlab.enterprise.test") {
      if (parsed.searchParams.get("page") === "2") {
        return jsonResponse([{ path_with_namespace: "platform/second", name: "second" }]);
      }
      return jsonResponse(
        [{ path_with_namespace: "platform/first", name: "first", namespace: { full_path: "platform" } }],
        { "X-Next-Page": "2" },
      );
    }
    if (parsed.hostname === "api.bitbucket.org" && parsed.pathname.endsWith("/user/workspaces")) {
      if (headers.get("authorization") === "Bearer bounded-bitbucket-token") {
        return jsonResponse({
          values: Array.from({ length: 101 }, (_, index) => ({ workspace: { slug: `team-${index}` } })),
          next: "https://api.bitbucket.org/2.0/user/workspaces?page=2",
        });
      }
      return jsonResponse({ values: [{ workspace: { slug: "team" } }] });
    }
    if (parsed.hostname === "api.bitbucket.org" && parsed.pathname.endsWith("/repositories/team")) {
      if (parsed.searchParams.get("page") === "2") {
        return jsonResponse({ values: [{ full_name: "team/second", name: "second", owner: { display_name: "Team" } }] });
      }
      return jsonResponse({
        next: "https://api.bitbucket.org/2.0/repositories/team?pagelen=100&sort=-updated_on&page=2",
        values: [{ full_name: "team/first", name: "first", owner: { display_name: "Team" } }],
      });
    }
    if (parsed.hostname === "api.bitbucket.org" && parsed.pathname.includes("/repositories/team-")) {
      return jsonResponse({ values: [] });
    }
    return new Response("unexpected provider request", { status: 500 });
  });

  await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
  await db.insert(organizations).values([
    { id: orgId, name: orgName },
    { id: outsiderOrgId, name: outsiderOrgName },
  ]);
  await db.insert(organizationMemberships).values({
    id: `membership-repository-discovery-${suffix}`,
    orgId,
    userId,
    role: "owner",
    status: "active",
  });
  await db.insert(apiTokens).values({
    id: `api-token-repository-discovery-${suffix}`,
    userId,
    token: hashAuthenticationToken(apiToken),
  });
  await db.insert(oauthClients).values([
    { id: githubClientId, orgId, name: "GitHub", serviceProvider: "github", createdAt: Date.now() },
    {
      id: githubEnterpriseClientId,
      orgId,
      name: "GitHub Enterprise",
      serviceProvider: "github_enterprise",
      apiUrl: "https://github.enterprise.test/api/v3",
      httpUrl: "https://github.enterprise.test",
      createdAt: Date.now(),
    },
    {
      id: gitlabClientId,
      orgId,
      name: "GitLab Self-Managed",
      serviceProvider: "gitlab_ee",
      apiUrl: "https://gitlab.enterprise.test/api/v4",
      httpUrl: "https://gitlab.enterprise.test",
      createdAt: Date.now(),
    },
    {
      id: bitbucketClientId,
      orgId,
      name: "Bitbucket",
      serviceProvider: "bitbucket",
      httpUrl: "https://api.bitbucket.org",
      createdAt: Date.now(),
    },
    { id: boundedBitbucketClientId, orgId, name: "Bounded Bitbucket", serviceProvider: "bitbucket", createdAt: Date.now() },
    {
      id: outsiderClientId,
      orgId: outsiderOrgId,
      name: "Other organization GitHub",
      serviceProvider: "github",
      apiUrl: "https://cross-org.test/api/v3",
      createdAt: Date.now(),
    },
  ]);
  await db.insert(oauthTokens).values([
    { id: githubTokenId, oauthClientId: githubClientId, token: "github-token" },
    { id: githubEnterpriseTokenId, oauthClientId: githubEnterpriseClientId, token: "github-enterprise-token" },
    { id: gitlabTokenId, oauthClientId: gitlabClientId, token: "gitlab-token" },
    {
      id: bitbucketTokenId,
      oauthClientId: bitbucketClientId,
      serviceProviderUser: "team",
      token: "bitbucket-token",
    },
    { id: boundedBitbucketTokenId, oauthClientId: boundedBitbucketClientId, token: "bounded-bitbucket-token" },
    { id: outsiderTokenId, oauthClientId: outsiderClientId, token: "cross-org-token" },
  ]);
});

beforeEach(() => {
  calls.length = 0;
});

afterAll(async () => {
  setExternalUrlTransportForTests(undefined);
  await db.delete(oauthTokens).where(inArray(oauthTokens.id, [
    githubTokenId,
    githubEnterpriseTokenId,
    gitlabTokenId,
    bitbucketTokenId,
    boundedBitbucketTokenId,
    outsiderTokenId,
  ]));
  await db.delete(oauthClients).where(inArray(oauthClients.id, [
    githubClientId,
    githubEnterpriseClientId,
    gitlabClientId,
    bitbucketClientId,
    boundedBitbucketClientId,
    outsiderClientId,
  ]));
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
  await db.delete(organizationMemberships).where(and(
    eq(organizationMemberships.orgId, orgId),
    eq(organizationMemberships.userId, userId),
  ));
  await db.delete(organizations).where(inArray(organizations.id, [orgId, outsiderOrgId]));
  await db.delete(users).where(eq(users.id, userId));
});

describe("VCS OAuth repository discovery", () => {
  test("keeps the existing GitHub OAuth discovery path", async () => {
    const response = await request(`oauth-token:${githubTokenId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([{
      id: "octo/public-repository",
      type: "vcs-repositories",
      attributes: { identifier: "octo/public-repository", name: "public-repository", owner: "octo" },
    }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer github-token");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/user/repos");
  });

  test("uses a GitHub Enterprise API URL and follows pagination", async () => {
    const response = await request(githubEnterpriseTokenId);
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((item: { id: string }) => item.id)).toEqual([
      "enterprise/first",
      "enterprise/second",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.authorization === "Bearer github-enterprise-token")).toBe(true);
    expect(calls.every((call) => new URL(call.url).hostname === "github.enterprise.test")).toBe(true);
  });

  test("rejects HTTP API URLs before sending bearer credentials", async () => {
    const previousApiUrl = "https://github.enterprise.test/api/v3";
    await db.update(oauthClients).set({ apiUrl: "http://github.enterprise.test/api/v3" }).where(eq(oauthClients.id, githubEnterpriseClientId));
    try {
      const response = await request(githubEnterpriseTokenId);
      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual([]);
      expect(calls).toHaveLength(0);
    } finally {
      await db.update(oauthClients).set({ apiUrl: previousApiUrl }).where(eq(oauthClients.id, githubEnterpriseClientId));
    }
  });

  test("uses GitLab's paginated projects API and normalizes paths", async () => {
    const response = await request(gitlabTokenId);
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((item: { attributes: { identifier: string } }) => item.attributes.identifier)).toEqual([
      "platform/first",
      "platform/second",
    ]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v4/projects");
    expect(new URL(calls[0]?.url ?? "").searchParams.get("membership")).toBe("true");
    expect(new URL(calls[1]?.url ?? "").searchParams.get("page")).toBe("2");
  });

  test("uses Bitbucket's values/next response shape", async () => {
    const response = await request(bitbucketTokenId);
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((item: { attributes: { identifier: string; owner: string } }) => [
      item.attributes.identifier,
      item.attributes.owner,
    ])).toEqual([
      ["team/first", "Team"],
      ["team/second", "Team"],
    ]);
    expect(calls).toHaveLength(3);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/2.0/user/workspaces");
    expect(new URL(calls[1]?.url ?? "").pathname).toBe("/2.0/repositories/team");
    expect(calls.every((call) => new URL(call.url).hostname === "api.bitbucket.org")).toBe(true);
  });

  test("bounds Bitbucket workspace and repository discovery requests", async () => {
    const response = await request(boundedBitbucketTokenId);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([]);
    expect(calls).toHaveLength(100);
    expect(calls[0]?.url).toContain("/2.0/user/workspaces");
    expect(calls.slice(1).every((call) => call.url.includes("/2.0/repositories/team-"))).toBe(true);
  });

  test("does not decrypt or contact a cross-organization OAuth connection", async () => {
    const response = await request(outsiderTokenId);
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
