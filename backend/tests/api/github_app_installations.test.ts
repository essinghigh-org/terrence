import { generateKeyPairSync } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  githubAppInstallations,
  organizationMemberships,
  organizations,
  policySets,
  teamMemberships,
  teams,
  users,
  workspaces,
} from "../../src/db/schema";
import { legacyHashAuthenticationToken } from "../../src/lib/token-service";

const suffix = crypto.randomUUID();
const orgId = `org-github-app-${suffix}`;
const orgName = `github-app-${suffix}`;
const userId = `usr-github-app-${suffix}`;
const outsiderId = `usr-github-app-outsider-${suffix}`;
const apiTokenId = `tok-github-app-${suffix}`;
const outsiderTokenId = `tok-github-app-outsider-${suffix}`;
const vcsTeamId = `team-github-app-${suffix}`;
const apiToken = `github-app-token-${suffix}`;
const outsiderToken = `github-app-outsider-token-${suffix}`;
const installationId = 7_654_321;
const originalFetch = globalThis.fetch;
const originalEnvironment = Object.fromEntries([
  "GITHUB_APP_API_URL",
  "GITHUB_APP_HTTP_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
].map((key): [string, string | undefined] => [key, process.env[key]]));

let publicKey = "";
let providerMode: "valid" | "mismatch" = "valid";
let providerName = "octo-organization";
const providerRequests: { authorization: string | null; url: string }[] = [];

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

function request(path: string, token: string | null = apiToken, accept?: string): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(accept === undefined ? {} : { Accept: accept }),
    },
  }));
}

function requestDelete(path: string, token: string | null = apiToken): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    method: "DELETE",
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  }));
}

async function startSetup(token = apiToken): Promise<{ response: Response; state: string }> {
  const response = await request(`/api/v2/organizations/${orgName}/github-app/installations/setup`, token);
  const location = response.headers.get("location");
  return {
    response,
    state: location === null ? "" : new URL(location).searchParams.get("state") ?? "",
  };
}

function callback(state: string, id = String(installationId), action = "install"): Promise<Response> {
  const query = new URLSearchParams({ installation_id: id, setup_action: action, state });
  return request(`/api/v2/github-app/installations/callback?${query.toString()}`, null);
}

beforeAll(async () => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  publicKey = keys.publicKey;
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = keys.privateKey;
  process.env.GITHUB_APP_SLUG = "terrence-test";
  delete process.env.GITHUB_APP_API_URL;
  delete process.env.GITHUB_APP_HTTP_URL;

  const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const authorization = input instanceof Request
      ? input.headers.get("authorization")
      : null;
    const headers = new Headers(init?.headers);
    providerRequests.push({
      authorization: authorization ?? headers.get("authorization"),
      url,
    });
    if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
    if (url.includes("/installation/repositories")) {
      const page = new URL(url).searchParams.get("page");
      if (page === "2") {
        return Response.json({ repositories: [{ full_name: "acme/second-repository", name: "second-repository" }] });
      }
      return Response.json(
        { repositories: [{ full_name: "acme/first-repository", name: "first-repository" }] },
        { headers: { Link: '<https://github.example/api/v3/installation/repositories?per_page=100&page=2>; rel="next"' } },
      );
    }
    return Response.json({
      account: {
        avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4",
        login: providerName,
        type: "Organization",
      },
      app_id: providerMode === "valid" ? 12_345 : 99_999,
      html_url: `https://github.com/organizations/${providerName}/settings/installations/${String(installationId)}`,
      id: installationId,
      target_type: "Organization",
    });
  };
  globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });

  await db.insert(organizations).values({ id: orgId, name: orgName });
  await db.insert(users).values([
    { id: userId, username: userId, passwordHash: "unused" },
    { id: outsiderId, username: outsiderId, passwordHash: "unused" },
  ]);
  await db.insert(organizationMemberships).values({
    id: `mem-github-app-${suffix}`,
    orgId,
    role: "member",
    userId,
  });
  await db.insert(teams).values({
    id: vcsTeamId,
    orgId,
    name: `github-app-managers-${suffix}`,
    organizationAccess: { "manage-vcs-settings": true },
  });
  await db.insert(teamMemberships).values({
    id: `tmem-github-app-${suffix}`,
    teamId: vcsTeamId,
    userId,
  });
  await db.insert(apiTokens).values([
    {
      id: apiTokenId,
      token: legacyHashAuthenticationToken(apiToken),
      userId,
    },
    {
      id: outsiderTokenId,
      token: legacyHashAuthenticationToken(outsiderToken),
      userId: outsiderId,
    },
  ]);
});

beforeEach(async () => {
  providerMode = "valid";
  providerName = "octo-organization";
  providerRequests.length = 0;
  process.env.GITHUB_APP_SLUG = "terrence-test";
  await db.insert(organizationMemberships).values({
    id: `mem-github-app-${suffix}`,
    orgId,
    role: "member",
    userId,
  }).onConflictDoNothing();
  await db.insert(apiTokens).values([
    {
      id: apiTokenId,
      token: legacyHashAuthenticationToken(apiToken),
      userId,
    },
    {
      id: outsiderTokenId,
      token: legacyHashAuthenticationToken(outsiderToken),
      userId: outsiderId,
    },
  ]).onConflictDoNothing();
  await db.delete(githubAppInstallations).where(eq(githubAppInstallations.orgId, orgId));
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  restoreEnvironment();
  await db.delete(githubAppInstallations).where(eq(githubAppInstallations.orgId, orgId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, outsiderId));
  await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, outsiderId));
});

describe("GitHub App installation setup", () => {
  test("authorizes the organization before redirecting to the configured App", async () => {
    expect((await request(`/api/v2/organizations/${orgName}/github-app/installations/setup`, null)).status).toBe(404);
    expect((await request(`/api/v2/organizations/${orgName}/github-app/installations/setup`, outsiderToken)).status).toBe(404);

    delete process.env.GITHUB_APP_SLUG;
    expect((await request(`/api/v2/organizations/${orgName}/github-app/installations/setup`)).status).toBe(422);
    process.env.GITHUB_APP_SLUG = "terrence-test";

    const { response, state } = await startSetup();
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/apps/terrence-test/installations/new");
    expect(state).not.toBeEmpty();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("returns the one-time setup URL as JSON for authenticated SPAs", async () => {
    const response = await request(
      `/api/v2/organizations/${orgName}/github-app/installations/setup`,
      apiToken,
      "application/vnd.api+json",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/vnd.api+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();

    const body = await response.json();
    expect(body.data.type).toBe("vcs-authorization-requests");
    const location = new URL(body.data.attributes["authorization-url"]);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/apps/terrence-test/installations/new");
    expect(location.searchParams.get("state")).toBe(body.data.id);
    expect(location.toString()).not.toContain(apiToken);
  });

  test("rejects invalid and replayed callback state before contacting GitHub", async () => {
    const { state } = await startSetup();
    expect((await callback(`${state}-tampered`)).status).toBe(400);
    expect(providerRequests).toHaveLength(0);

    expect((await callback(state, "1e3")).status).toBe(400);
    expect((await callback(state)).status).toBe(400);
    expect(providerRequests).toHaveLength(0);
  });

  test("rechecks the initiating user's organization membership and token", async () => {
    const { state } = await startSetup();
    await db.delete(organizationMemberships).where(and(
      eq(organizationMemberships.orgId, orgId),
      eq(organizationMemberships.userId, userId),
    ));
    expect((await callback(state)).status).toBe(403);
    expect(providerRequests).toHaveLength(0);

    await db.insert(organizationMemberships).values({
      id: `mem-github-app-${suffix}`,
      orgId,
      role: "member",
      userId,
    });
    const secondSetup = await startSetup();
    await db.delete(apiTokens).where(eq(apiTokens.id, apiTokenId));
    expect((await callback(secondSetup.state)).status).toBe(403);
    expect(providerRequests).toHaveLength(0);
  });

  test("verifies, stores, and refreshes the exact installation returned by GitHub", async () => {
    const { state } = await startSetup();
    const completed = await callback(state);
    expect(completed.status).toBe(303);
    const destination = new URL(completed.headers.get("location")!);
    expect(destination.pathname).toBe(`/app/${orgName}/settings/vcs`);

    expect(providerRequests).toHaveLength(1);
    expect(new URL(providerRequests[0]!.url).pathname).toBe(`/app/installations/${String(installationId)}`);
    const authorization = providerRequests[0]!.authorization;
    expect(authorization).toStartWith("Bearer ");
    const claims = jwt.verify(authorization!.slice(7), publicKey, {
      algorithms: ["RS256"],
    }) as JwtPayload;
    expect(claims.iss).toBe("12345");

    const stored = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.orgId, orgId),
        eq(githubAppInstallations.installationId, installationId),
      ),
    });
    expect(stored).toBeDefined();
    if (stored === undefined) throw new Error("Installation was not stored");
    expect(stored.name).toBe("octo-organization");
    expect(stored.iconUrl).toBe("https://avatars.githubusercontent.com/u/12345?v=4");
    expect(stored.installationType).toBe("Organization");
    expect(destination.searchParams.get("github_app_installation")).toBe(stored.id);
    expect((await callback(state)).status).toBe(400);

    providerName = "octo-renamed";
    const update = await startSetup();
    expect((await callback(update.state, String(installationId), "update")).status).toBe(303);
    const refreshed = await db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.orgId, orgId),
    });
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.id).toBe(stored.id);
    expect(refreshed[0]?.name).toBe("octo-renamed");
  });

  test("does not persist an installation that GitHub reports for another App", async () => {
    providerMode = "mismatch";
    const { state } = await startSetup();
    expect((await callback(state)).status).toBe(502);
    expect(await db.query.githubAppInstallations.findFirst({
      where: eq(githubAppInstallations.orgId, orgId),
    })).toBeUndefined();
  });

  test("discovers all installation repositories across bounded Link pages", async () => {
    const localId = `ghain-pagination-${suffix}`;
    const previousApiUrl = process.env.GITHUB_APP_API_URL;
    process.env.GITHUB_APP_API_URL = "https://github.example/api/v3";
    await db.insert(githubAppInstallations).values({
      id: localId,
      orgId,
      name: "paginated-installation",
      installationId: installationId + 10,
    });
    try {
      const response = await request(`/api/v2/organizations/${orgName}/vcs-connections/github-app:${localId}/repositories`);
      expect(response.status).toBe(200);
      const body = await response.json() as { data?: { id: string }[] };
      expect(body.data?.map((repository): string => repository.id)).toEqual([
        "acme/first-repository",
        "acme/second-repository",
      ]);
      expect(providerRequests.filter((entry): boolean => entry.url.includes("/installation/repositories"))).toHaveLength(2);
    } finally {
      await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, localId));
      if (previousApiUrl === undefined) delete process.env.GITHUB_APP_API_URL;
      else process.env.GITHUB_APP_API_URL = previousApiUrl;
    }
  });

  test("allows a VCS manager to remove an installation but denies outsiders", async () => {
    const localId = `ghain-${crypto.randomUUID()}`;
    const workspaceId = `ws-github-app-${crypto.randomUUID()}`;
    const policySetId = `ps-github-app-${crypto.randomUUID()}`;
    await db.insert(githubAppInstallations).values({
      id: localId,
      orgId,
      name: "removable-installation",
      installationId: installationId + 1,
      createdAt: Date.now(),
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      name: "connected-workspace",
      vcsRepo: { identifier: "acme/repository", githubAppInstallationId: localId },
    });
    await db.insert(policySets).values({
      id: policySetId,
      orgId,
      name: "connected-policy-set",
      vcsRepo: { identifier: "acme/repository", githubAppInstallationId: localId },
    });

    const outsider = await requestDelete(`/api/v2/organizations/${orgName}/github-app/installations/${localId}`, outsiderToken);
    expect(outsider.status).toBe(404);

    const blocked = await requestDelete(`/api/v2/organizations/${orgName}/github-app/installations/${localId}`);
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json() as { errors?: { detail?: string }[] };
    expect(blockedBody.errors?.[0]?.detail).toContain("connected-workspace");
    expect(blockedBody.errors?.[0]?.detail).toContain("connected-policy-set");

    await db.delete(policySets).where(eq(policySets.id, policySetId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    const removed = await requestDelete(`/api/v2/organizations/${orgName}/github-app/installations/${localId}`);
    expect(removed.status).toBe(204);
    expect(await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, localId) })).toBeUndefined();
  });

  test("keeps installation deletion safe when a workspace reference races it", async () => {
    const localId = `ghain-${crypto.randomUUID()}`;
    const workspaceId = `ws-github-app-race-${crypto.randomUUID()}`;
    await db.insert(githubAppInstallations).values({
      id: localId,
      orgId,
      name: "racing-installation",
      installationId: installationId + 2,
      createdAt: Date.now(),
    });

    const [reference, deletion] = await Promise.allSettled([
      db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        name: "racing-workspace",
        vcsRepo: { identifier: "acme/repository", githubAppInstallationId: localId },
      }),
      requestDelete(`/api/v2/organizations/${orgName}/github-app/installations/${localId}`),
    ]);
    const storedInstallation = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, localId) });
    const storedWorkspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });

    expect(storedInstallation === undefined && storedWorkspace !== undefined).toBe(false);
    if (storedInstallation === undefined) {
      expect(reference.status).toBe("rejected");
      expect(deletion.status).toBe("fulfilled");
      if (deletion.status === "fulfilled") expect(deletion.value.status).toBe(204);
    } else {
      expect(reference.status).toBe("fulfilled");
      expect(deletion.status).toBe("fulfilled");
      if (deletion.status === "fulfilled") expect(deletion.value.status).toBe(409);
    }

    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, localId));
  });
});
