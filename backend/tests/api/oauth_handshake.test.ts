import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  oauthClientProjects,
  oauthClients,
  oauthTokens,
  organizationMemberships,
  organizations,
  projects,
  users,
} from "../../src/db/schema";
import { decryptSecret, isEncryptedSecret } from "../../src/lib/secrets";

function oauthPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character: string): string =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthHeaderParameters(header: string | null): Record<string, string> {
  if (header?.startsWith("OAuth ") !== true) return {};
  return Object.fromEntries(header.slice(6).split(",").map((part): [string, string] => {
    const [key, quotedValue = ""] = part.trim().split("=", 2);
    return [decodeURIComponent(key ?? ""), decodeURIComponent(quotedValue.replace(/^"|"$/g, ""))];
  }));
}

function validHmacOAuth1Request(
  method: string,
  requestUrl: string,
  header: string | null,
  tokenSecret: string,
  expected: Readonly<Record<string, string>>,
): boolean {
  const parameters = oauthHeaderParameters(header);
  const signature = parameters.oauth_signature;
  delete parameters.oauth_signature;
  if (
    signature === undefined
    || parameters.oauth_signature_method !== "HMAC-SHA1"
    || Object.entries(expected).some(([key, value]): boolean => parameters[key] !== value)
  ) return false;

  const url = new URL(requestUrl);
  const normalized = [...url.searchParams.entries(), ...Object.entries(parameters)]
    .map(([key, value]): [string, string] => [oauthPercentEncode(key), oauthPercentEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]): number =>
      leftKey === rightKey
        ? leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
        : leftKey < rightKey ? -1 : 1)
    .map(([key, value]): string => `${key}=${value}`)
    .join("&");
  const baseUrl = `${url.protocol}//${url.host}${url.pathname || "/"}`;
  const signatureBase = [
    method.toUpperCase(),
    oauthPercentEncode(baseUrl),
    oauthPercentEncode(normalized),
  ].join("&");
  const expectedSignature = createHmac(
    "sha1",
    `${oauthPercentEncode("bitbucket-dc-secret")}&${oauthPercentEncode(tokenSecret)}`,
  ).update(signatureBase).digest("base64");
  return signature === expectedSignature;
}

describe("VCS OAuth handshakes", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-oauth-handshake-${suffix}`;
  const otherUserId = `usr-oauth-handshake-other-${suffix}`;
  const orgId = `org-oauth-handshake-${suffix}`;
  const orgName = `oauth-handshake-${suffix}`;
  const otherOrgId = `org-oauth-handshake-other-${suffix}`;
  const projectId = `prj-oauth-handshake-${suffix}`;
  const otherProjectId = `prj-oauth-handshake-other-${suffix}`;
  const apiToken = `oauth-handshake-token-${suffix}`;
  const otherApiToken = `oauth-handshake-other-token-${suffix}`;
  const providerToken = `provider-access-${suffix}`;
  const providerRequests: { path: string; authorization: string | null; body: string }[] = [];
  let provider: ReturnType<typeof Bun.serve>;
  let clientId = "";
  let privateVcsUrlLock: Promise<void> = Promise.resolve();
  const withPrivateVcsUrls = async <T>(operation: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const waiting = privateVcsUrlLock;
    privateVcsUrlLock = new Promise<void>((resolve): void => { release = resolve; });
    await waiting;
    const previous = process.env.TERRENCE_ALLOW_PRIVATE_VCS_URLS;
    process.env.TERRENCE_ALLOW_PRIVATE_VCS_URLS = "1";
    try {
      return await operation();
    } finally {
      if (previous === undefined) delete process.env.TERRENCE_ALLOW_PRIVATE_VCS_URLS;
      else process.env.TERRENCE_ALLOW_PRIVATE_VCS_URLS = previous;
      release();
    }
  };

  const request = (
    path: string,
    auth: string | null = apiToken,
    accept?: string,
  ): Promise<Response> => withPrivateVcsUrls(() => app.handle(new Request(`http://terrence.test${path}`, {
      headers: {
        ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
        ...(accept === undefined ? {} : { Accept: accept }),
      },
    })));

  beforeAll(async () => {
    provider = Bun.serve({
      port: 0,
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const body = request.method === "POST" ? await request.text() : "";
        providerRequests.push({
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          body,
        });
        if (url.pathname === "/login/oauth/access_token") {
          return Response.json({ access_token: providerToken, token_type: "bearer" });
        }
        if (url.pathname === "/api/v3/user") {
          return Response.json({ login: "octocat" });
        }
        if (url.pathname === "/plugins/servlet/oauth/request-token") {
          const oauth = oauthHeaderParameters(request.headers.get("authorization"));
          if (
            oauth.oauth_consumer_key !== "bitbucket-dc-key"
            || typeof oauth.oauth_callback !== "string"
            || !validHmacOAuth1Request(request.method, request.url, request.headers.get("authorization"), "", {
              oauth_callback: oauth.oauth_callback,
              oauth_consumer_key: "bitbucket-dc-key",
            })
          ) return new Response("invalid signature", { status: 401 });
          return new Response("oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true");
        }
        if (url.pathname === "/plugins/servlet/oauth/access-token") {
          if (!validHmacOAuth1Request(request.method, request.url, request.headers.get("authorization"), "request-secret", {
            oauth_consumer_key: "bitbucket-dc-key",
            oauth_token: "request-token",
            oauth_verifier: "provider-verifier",
          })) return new Response("invalid signature", { status: 401 });
          return new Response("oauth_token=access-token&oauth_token_secret=access-secret");
        }
        if (url.pathname === "/plugins/servlet/applinks/whoami") {
          if (!validHmacOAuth1Request(request.method, request.url, request.headers.get("authorization"), "access-secret", {
            oauth_consumer_key: "bitbucket-dc-key",
            oauth_token: "access-token",
          })) return new Response("invalid signature", { status: 401 });
          return new Response("bitbucket-service-user");
        }
        return new Response("not found", { status: 404 });
      },
    });

    await db.insert(users).values([
      { id: userId, username: userId, passwordHash: "unused" },
      { id: otherUserId, username: otherUserId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: otherOrgId, name: `other-${orgName}` },
    ]);
    await db.insert(organizationMemberships).values([
      { id: `orgmem-oauth-handshake-${suffix}`, userId, orgId, role: "owner" },
      { id: `orgmem-oauth-handshake-other-${suffix}`, userId: otherUserId, orgId: otherOrgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([
      {
        id: `api-oauth-handshake-${suffix}`,
        token: createHash("sha256").update(apiToken).digest("hex"),
        userId,
      },
      {
        id: `api-oauth-handshake-other-${suffix}`,
        token: createHash("sha256").update(otherApiToken).digest("hex"),
        userId: otherUserId,
      },
    ]);
    await db.insert(projects).values([
      { id: projectId, orgId, name: `oauth-project-${suffix}` },
      { id: otherProjectId, orgId: otherOrgId, name: `oauth-project-other-${suffix}` },
    ]);

    const providerBase = `http://${provider.hostname}:${provider.port}`;
    const createResponse = await withPrivateVcsUrls(() => app.handle(new Request(
      `http://terrence.test/api/v2/organizations/${orgName}/oauth-clients`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "oauth-clients",
            attributes: {
              name: "GitHub Enterprise",
              "service-provider": "github_enterprise",
              "http-url": providerBase,
              "api-url": `${providerBase}/api/v3`,
              key: "client-key",
              secret: "client-secret",
            },
            relationships: {
              projects: { data: [{ id: projectId, type: "projects" }] },
            },
          },
        }),
      },
    )));
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    clientId = created.data.id;
    expect(created.data.attributes).toMatchObject({
      "callback-url": `http://terrence.test/api/v2/oauth-clients/${clientId}/callback`,
      "connect-path": `/api/v2/oauth-clients/${clientId}/connect`,
    });
    expect(created.data.attributes.secret).toBeUndefined();
  });

  afterAll(async () => {
    await provider.stop(true);
    await db.delete(oauthClients).where(eq(oauthClients.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, otherUserId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, otherOrgId));
    await db.delete(projects).where(eq(projects.orgId, orgId));
    await db.delete(projects).where(eq(projects.orgId, otherOrgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  test("enforces organization and project scope before redirecting", async () => {
    expect((await request(`/api/v2/oauth-clients/${clientId}/connect`, null)).status).toBe(404);
    expect((await request(`/api/v2/oauth-clients/${clientId}/connect`, otherApiToken)).status).toBe(404);
    expect((await request(`/api/v2/oauth-clients/${clientId}/connect`)).status).toBe(403);
    expect((await request(`/api/v2/oauth-clients/${clientId}/connect?project_id=${otherProjectId}`)).status).toBe(403);

    const response = await request(`/api/v2/oauth-clients/${clientId}/connect?project_id=${projectId}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-key");
    expect(location.searchParams.get("scope")).toBe("repo user:email");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `http://terrence.test/api/v2/oauth-clients/${clientId}/callback`,
    );
    expect(location.searchParams.get("state")).not.toBeEmpty();
  });

  test("returns the same one-time authorization URL as JSON for authenticated SPAs", async () => {
    const response = await request(
      `/api/v2/oauth-clients/${clientId}/connect?project_id=${projectId}`,
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
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-key");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `http://terrence.test/api/v2/oauth-clients/${clientId}/callback`,
    );
    expect(location.searchParams.get("state")).toBe(body.data.id);
    expect(location.toString()).not.toContain(apiToken);
  });

  test("uses the shared OAuth2 flow only for compatible providers", async () => {
    const clients = [
      {
        id: `oc-gitlab-${suffix}`,
        orgId,
        name: "GitLab",
        serviceProvider: "gitlab",
        httpUrl: "https://gitlab.example.test",
        apiUrl: "https://gitlab.example.test/api/v4",
        key: "gitlab-key",
        secret: "gitlab-secret",
      },
      {
        id: `oc-bitbucket-${suffix}`,
        orgId,
        name: "Bitbucket Cloud",
        serviceProvider: "bitbucket",
        key: "bitbucket-key",
        secret: "bitbucket-secret",
      },
    ];
    await db.insert(oauthClients).values(clients);

    const gitlab = new URL((await request(`/api/v2/oauth-clients/${clients[0]!.id}/connect`)).headers.get("location")!);
    expect(gitlab.pathname).toBe("/oauth/authorize");
    expect(gitlab.searchParams.get("scope")).toBe("api");

    const bitbucket = new URL((await request(`/api/v2/oauth-clients/${clients[1]!.id}/connect`)).headers.get("location")!);
    expect(bitbucket.hostname).toBe("bitbucket.org");
    expect(bitbucket.pathname).toBe("/site/oauth2/authorize");
    expect(bitbucket.searchParams.has("scope")).toBeFalse();

  });

  test("completes a signed, project-scoped Bitbucket Data Center OAuth 1.0 handshake once", async () => {
    const dcClientId = `oc-bitbucket-dc-${suffix}`;
    await db.insert(oauthClients).values({
      id: dcClientId,
      orgId,
      name: "Bitbucket Data Center",
      serviceProvider: "bitbucket_data_center",
      httpUrl: `http://${provider.hostname}:${provider.port}`,
      apiUrl: `http://${provider.hostname}:${provider.port}/rest/api/1.0`,
      key: "bitbucket-dc-key",
      secret: "bitbucket-dc-secret",
    });
    await db.insert(oauthClientProjects).values({
      id: `ocp-bitbucket-dc-${suffix}`,
      oauthClientId: dcClientId,
      projectId,
    });

    expect((await request(`/api/v2/oauth-clients/${dcClientId}/connect`)).status).toBe(403);
    const connect = await request(`/api/v2/oauth-clients/${dcClientId}/connect?project_id=${projectId}`);
    expect(connect.status).toBe(302);
    const authorization = new URL(connect.headers.get("location")!);
    expect(authorization.pathname).toBe("/plugins/servlet/oauth/authorize");
    expect(authorization.searchParams.get("oauth_token")).toBe("request-token");

    const requestTokenCall = providerRequests.findLast((item): boolean =>
      item.path === "/plugins/servlet/oauth/request-token");
    const requestTokenOAuth = oauthHeaderParameters(requestTokenCall?.authorization ?? null);
    expect(requestTokenOAuth.oauth_signature_method).toBe("HMAC-SHA1");
    expect(requestTokenOAuth.oauth_nonce).not.toBeEmpty();
    expect(requestTokenOAuth.oauth_timestamp).toMatch(/^\d+$/);
    const callbackUrl = requestTokenOAuth.oauth_callback;
    if (callbackUrl === undefined) throw new Error("Provider request did not include an OAuth callback");
    const providerCallback = new URL(callbackUrl);
    const state = providerCallback.searchParams.get("state");
    expect(state).not.toBeEmpty();

    providerCallback.searchParams.set("oauth_token", "request-token");
    providerCallback.searchParams.set("oauth_verifier", "provider-verifier");
    const callback = await request(`${providerCallback.pathname}${providerCallback.search}`, null);
    expect(callback.status).toBe(303);
    const destination = new URL(callback.headers.get("location")!);
    const tokenId = destination.searchParams.get("oauth_token_id")!;
    expect(destination.pathname).toBe(`/app/${orgName}/settings/vcs`);
    expect(destination.toString()).not.toContain("access-token");
    expect(destination.toString()).not.toContain("access-secret");

    const stored = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) });
    expect(stored).toMatchObject({
      oauthClientId: dcClientId,
      serviceProviderUser: "bitbucket-service-user",
    });
    expect(isEncryptedSecret(stored?.token ?? "")).toBeTrue();
    expect(JSON.parse(await decryptSecret(stored?.token ?? ""))).toEqual({
      oauth_token: "access-token",
      oauth_token_secret: "access-secret",
    });
    expect((await request(`${providerCallback.pathname}${providerCallback.search}`, null)).status).toBe(400);
    expect((await db.query.oauthTokens.findMany({
      where: eq(oauthTokens.oauthClientId, dcClientId),
    }))).toHaveLength(1);
  });

  test("exchanges the callback once and persists a non-exposed provider token", async () => {
    expect((await request(`/api/v2/oauth-clients/${clientId}/callback?code=forged&state=forged`, null)).status).toBe(400);

    const connect = await request(`/api/v2/oauth-clients/${clientId}/connect?project_id=${projectId}`);
    const authorization = new URL(connect.headers.get("location")!);
    const state = authorization.searchParams.get("state")!;
    const callbackPath = `/api/v2/oauth-clients/${clientId}/callback?code=provider-code&state=${state}`;
    const callback = await request(callbackPath, null);
    expect(callback.status).toBe(303);
    const destination = new URL(callback.headers.get("location")!);
    expect(destination.pathname).toBe(`/app/${orgName}/settings/vcs`);
    const tokenId = destination.searchParams.get("oauth_token_id")!;
    expect(destination.toString()).not.toContain(providerToken);

    const stored = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) });
    expect(stored).toMatchObject({
      oauthClientId: clientId,
      serviceProviderUser: "octocat",
    });
    expect(isEncryptedSecret(stored?.token ?? "")).toBeTrue();
    expect(await decryptSecret(stored?.token ?? "")).toBe(providerToken);
    expect(providerRequests).toContainEqual(expect.objectContaining({
      path: "/login/oauth/access_token",
      body: expect.stringContaining("client_secret=client-secret"),
    }));
    expect(providerRequests).toContainEqual({
      path: "/api/v3/user",
      authorization: `Bearer ${providerToken}`,
      body: "",
    });

    expect((await request(callbackPath, null)).status).toBe(400);
    expect((await db.query.oauthTokens.findMany({
      where: eq(oauthTokens.oauthClientId, clientId),
    }))).toHaveLength(1);
  });
});
