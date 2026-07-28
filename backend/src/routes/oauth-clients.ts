import { Elysia } from "elysia";
import { createHmac, createSign } from "node:crypto";
import { db } from "../db";
import { agentPools, oauthClientProjects, oauthClients, oauthTokens, organizations, projects, type users } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { encryptSecret } from "../lib/secrets";
import { apiURL, checkOrganizationPermission, serviceProviderDisplayName } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, unknown>>;
  body?: unknown;
  request: Readonly<{ url: string }>;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObj;
}>;

type OcItem = Readonly<typeof oauthClients.$inferSelect>;

type OtItem = Readonly<{
  readonly id: string;
  readonly serviceProviderUser: string | null;
  readonly hasSshKey: boolean;
  readonly createdAt: number;
}>;

type OAuth2Endpoints = Readonly<{
  authorization: URL;
  token: URL;
  user: URL;
  scope?: string;
  basicTokenAuth?: boolean;
}>;

type OAuth1Endpoints = Readonly<{
  requestToken: URL;
  authorization: URL;
  accessToken: URL;
  user: URL;
}>;

type OAuthHandshakeStateBase = Readonly<{
  clientId: string;
  expiresAt: number;
  projectId: string | null;
  redirectUri: string;
  tokenOrgId: string | null;
  tokenTeamId: string | null;
  userId: string | null;
}>;

type OAuthHandshakeState = OAuthHandshakeStateBase & (
  | Readonly<{ flow: "oauth2" }>
  | Readonly<{ flow: "oauth1"; requestToken: string; requestTokenSecret: string }>
);

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
// ponytail: handshake state is in-memory; use shared TTL storage before multi-instance deployment.
const oauthHandshakeStates = new Map<string, OAuthHandshakeState>();

const SERVICE_PROVIDERS = new Set([
  "github",
  "gitlab",
  "bitbucket",
  "github_enterprise",
  "gitlab_ce",
  "gitlab_ee",
  "azure_devops_server",
  "bitbucket_data_center",
]);

function stringQuery(query: Readonly<Record<string, unknown>> | undefined, name: string): string {
  const value = query?.[name];
  return typeof value === "string" ? value : "";
}

function endpoint(base: string, suffix: string): URL | null {
  try {
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function oauth2Endpoints(oc: OcItem): OAuth2Endpoints | null {
  if (oc.serviceProvider === "github" || oc.serviceProvider === "github_enterprise") {
    const httpUrl = oc.httpUrl ?? (oc.serviceProvider === "github" ? "https://github.com" : "");
    const apiUrl = oc.apiUrl ?? (oc.serviceProvider === "github" ? "https://api.github.com" : "");
    const authorization = endpoint(httpUrl, "/login/oauth/authorize");
    const token = endpoint(httpUrl, "/login/oauth/access_token");
    const user = endpoint(apiUrl, "/user");
    return authorization !== null && token !== null && user !== null
      ? { authorization, token, user, scope: "repo user:email" }
      : null;
  }
  if (["gitlab", "gitlab_ce", "gitlab_ee"].includes(oc.serviceProvider)) {
    const httpUrl = oc.httpUrl ?? (oc.serviceProvider === "gitlab" ? "https://gitlab.com" : "");
    const apiUrl = oc.apiUrl ?? (oc.serviceProvider === "gitlab" ? "https://gitlab.com/api/v4" : "");
    const authorization = endpoint(httpUrl, "/oauth/authorize");
    const token = endpoint(httpUrl, "/oauth/token");
    const user = endpoint(apiUrl, "/user");
    return authorization !== null && token !== null && user !== null
      ? { authorization, token, user, scope: "api" }
      : null;
  }
  if (oc.serviceProvider === "bitbucket") {
    const authorization = endpoint(oc.httpUrl ?? "https://bitbucket.org", "/site/oauth2/authorize");
    const token = endpoint(oc.httpUrl ?? "https://bitbucket.org", "/site/oauth2/access_token");
    const user = endpoint(oc.apiUrl ?? "https://api.bitbucket.org/2.0", "/user");
    return authorization !== null && token !== null && user !== null
      ? { authorization, token, user, basicTokenAuth: true }
      : null;
  }
  return null;
}

function oauth1Endpoints(oc: OcItem): OAuth1Endpoints | null {
  if (oc.serviceProvider !== "bitbucket_data_center" || oc.httpUrl === null) return null;
  const requestToken = endpoint(oc.httpUrl, "/plugins/servlet/oauth/request-token");
  const authorization = endpoint(oc.httpUrl, "/plugins/servlet/oauth/authorize");
  const accessToken = endpoint(oc.httpUrl, "/plugins/servlet/oauth/access-token");
  const user = endpoint(oc.httpUrl, "/plugins/servlet/applinks/whoami");
  return requestToken !== null && authorization !== null && accessToken !== null && user !== null
    ? { requestToken, authorization, accessToken, user }
    : null;
}

function oauthPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character: string): string =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthSignatureBase(method: string, rawUrl: string, parameters: readonly (readonly [string, string])[]): string {
  const url = new URL(rawUrl);
  const normalizedParameters = [...url.searchParams.entries(), ...parameters]
    .map(([key, value]): readonly [string, string] => [oauthPercentEncode(key), oauthPercentEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]): number =>
      leftKey === rightKey
        ? leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
        : leftKey < rightKey ? -1 : 1)
    .map(([key, value]): string => `${key}=${value}`)
    .join("&");
  const baseUrl = `${url.protocol}//${url.host}${url.pathname === "" ? "/" : url.pathname}`;
  return [
    method.toUpperCase(),
    oauthPercentEncode(baseUrl),
    oauthPercentEncode(normalizedParameters),
  ].join("&");
}

function oauth1Authorization(
  method: "GET" | "POST",
  url: string,
  consumerKey: string,
  consumerSecret: string,
  token?: string,
  tokenSecret = "",
  extraParameters: Readonly<Record<string, string>> = {},
): string {
  const rsa = /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(consumerSecret);
  const oauthParameters: [string, string][] = [
    ["oauth_consumer_key", consumerKey],
    ["oauth_nonce", crypto.randomUUID().replaceAll("-", "")],
    ["oauth_signature_method", rsa ? "RSA-SHA1" : "HMAC-SHA1"],
    ["oauth_timestamp", Math.floor(Date.now() / 1000).toString()],
    ["oauth_version", "1.0"],
    ...Object.entries(extraParameters),
  ];
  if (token !== undefined) oauthParameters.push(["oauth_token", token]);

  const signatureBase = oauthSignatureBase(method, url, oauthParameters);
  let signature: string;
  if (rsa) {
    const signer = createSign("RSA-SHA1");
    signer.update(signatureBase);
    signer.end();
    signature = signer.sign(consumerSecret, "base64");
  } else {
    signature = createHmac(
      "sha1",
      `${oauthPercentEncode(consumerSecret)}&${oauthPercentEncode(tokenSecret)}`,
    ).update(signatureBase).digest("base64");
  }
  oauthParameters.push(["oauth_signature", signature]);

  return `OAuth ${oauthParameters
    .sort(([left], [right]): number => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]): string => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
    .join(", ")}`;
}

async function oauth1TokenRequest(
  oc: OcItem,
  url: string,
  extraParameters: Readonly<Record<string, string>>,
  token?: string,
  tokenSecret = "",
): Promise<{ token: string; tokenSecret: string; callbackConfirmed: boolean } | null> {
  if (oc.key === null || oc.key === "" || oc.secret === null || oc.secret === "") return null;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/x-www-form-urlencoded",
      Authorization: oauth1Authorization(
        "POST",
        url,
        oc.key,
        oc.secret,
        token,
        tokenSecret,
        extraParameters,
      ),
    },
  });
  if (!response.ok) return null;
  const payload = providerPayload(await response.text());
  return typeof payload.oauth_token === "string"
    && payload.oauth_token !== ""
    && typeof payload.oauth_token_secret === "string"
    ? {
      token: payload.oauth_token,
      tokenSecret: payload.oauth_token_secret,
      callbackConfirmed: payload.oauth_callback_confirmed === "true",
    }
    : null;
}

async function oauth1ProviderUser(
  oc: OcItem,
  url: string,
  token: string,
  tokenSecret: string,
): Promise<string | null> {
  if (oc.key === null || oc.key === "" || oc.secret === null || oc.secret === "") return null;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain",
      Authorization: oauth1Authorization("GET", url, oc.key, oc.secret, token, tokenSecret),
    },
  });
  if (!response.ok) return null;
  const text = (await response.text()).trim();
  const payload = providerPayload(text);
  const username = [payload.name, payload.username, payload.slug, payload.displayName]
    .find((value: unknown): value is string => typeof value === "string" && value !== "");
  return username ?? (text !== "" && !text.startsWith("{") ? text : null);
}

function pruneOAuthStates(now = Date.now()): void {
  for (const [state, value] of oauthHandshakeStates) {
    if (value.expiresAt <= now) oauthHandshakeStates.delete(state);
  }
}

async function validHandshakeProjectScope(oc: OcItem, projectId: string | null): Promise<boolean> {
  const scopedProjects = await db.query.oauthClientProjects.findMany({
    where: eq(oauthClientProjects.oauthClientId, oc.id),
  });
  if (scopedProjects.length > 0 && projectId === null) return false;
  if (projectId === null) return true;
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.orgId, oc.orgId)),
  });
  return project !== undefined
    && (scopedProjects.length === 0 || scopedProjects.some((scope): boolean => scope.projectId === projectId));
}

function providerPayload(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

async function exchangeAuthorizationCode(
  oc: OcItem,
  tokenUrl: string,
  userUrl: string,
  basicTokenAuth: boolean,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; serviceProviderUser: string | null } | null> {
  if (oc.key === null || oc.key === "" || oc.secret === null || oc.secret === "") return null;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (basicTokenAuth) {
    headers.Authorization = `Basic ${Buffer.from(`${oc.key}:${oc.secret}`).toString("base64")}`;
  } else {
    body.set("client_id", oc.key);
    body.set("client_secret", oc.secret);
  }

  const tokenResponse = await fetch(tokenUrl, { method: "POST", headers, body });
  if (!tokenResponse.ok) return null;
  const tokenPayload = providerPayload(await tokenResponse.text());
  const accessToken = tokenPayload.access_token;
  if (typeof accessToken !== "string" || accessToken === "") return null;

  const userResponse = await fetch(userUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const userPayload = userResponse.ok ? providerPayload(await userResponse.text()) : {};
  const username = [userPayload.login, userPayload.username, userPayload.nickname, userPayload.display_name]
    .find((value: unknown): value is string => typeof value === "string" && value !== "");
  return { accessToken, serviceProviderUser: username ?? null };
}

function parseProjectIdentifiers(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object") return null;
    const identifier = item as Record<string, unknown>;
    if (identifier.type !== "projects" || typeof identifier.id !== "string" || identifier.id === "") return null;
    ids.add(identifier.id);
  }
  return [...ids];
}

function relationshipProjectIds(data: Readonly<Record<string, unknown>> | undefined): string[] | null | undefined {
  if (data?.relationships === undefined) return undefined;
  if (data.relationships === null || typeof data.relationships !== "object") return null;
  const relationships = data.relationships as Record<string, unknown>;
  if (!Object.hasOwn(relationships, "projects")) return undefined;
  const projectRelationship = relationships.projects;
  if (projectRelationship === null || typeof projectRelationship !== "object") return null;
  return parseProjectIdentifiers((projectRelationship as Record<string, unknown>).data);
}

function relationshipAgentPoolId(
  data: Readonly<Record<string, unknown>> | undefined,
): string | null | undefined | false {
  if (data?.relationships === undefined) return undefined;
  if (data.relationships === null || typeof data.relationships !== "object") return false;
  const relationships = data.relationships as Record<string, unknown>;
  if (!Object.hasOwn(relationships, "agent-pool")) return undefined;
  const relationship = relationships["agent-pool"];
  if (relationship === null || typeof relationship !== "object") return false;
  const identifier = (relationship as Record<string, unknown>).data;
  if (identifier === null) return null;
  if (typeof identifier !== "object") return false;
  const resource = identifier as Record<string, unknown>;
  return resource.type === "agent-pools" && typeof resource.id === "string" && resource.id !== ""
    ? resource.id
    : false;
}

async function validProjectScope(projectIds: readonly string[], orgId: string): Promise<boolean> {
  if (projectIds.length === 0) return true;
  const matchingProjects = await db.query.projects.findMany({
    where: and(eq(projects.orgId, orgId), inArray(projects.id, [...projectIds])),
  });
  return matchingProjects.length === projectIds.length;
}

async function validAgentPool(agentPoolId: string, orgId: string): Promise<boolean> {
  return await db.query.agentPools.findFirst({
    where: and(eq(agentPools.id, agentPoolId), eq(agentPools.orgId, orgId)),
  }) !== undefined;
}

async function replaceProjectScope(oauthClientId: string, projectIds: readonly string[]): Promise<void> {
  await db.transaction(async (tx: unknown): Promise<void> => {
    const t = tx as typeof db;
    await t.delete(oauthClientProjects).where(eq(oauthClientProjects.oauthClientId, oauthClientId));
    if (projectIds.length > 0) {
      await t.insert(oauthClientProjects).values(projectIds.map((projectId: string): typeof oauthClientProjects.$inferInsert => ({
        id: `ocp-${crypto.randomUUID()}`,
        oauthClientId,
        projectId,
      })));
    }
  });
}

async function oauthClientResource(oc: OcItem, request: Readonly<{ url: string }>): Promise<Record<string, unknown>> {
  const projectLinks = await db.query.oauthClientProjects.findMany({
    where: eq(oauthClientProjects.oauthClientId, oc.id),
  });
  return {
    id: oc.id,
    type: "oauth-clients",
    attributes: {
      name: oc.name,
      "service-provider": oc.serviceProvider,
      "service-provider-display-name": serviceProviderDisplayName(oc.serviceProvider),
      "api-url": oc.apiUrl,
      "http-url": oc.httpUrl,
      "rsa-public-key": oc.rsaPublicKey,
      "organization-scoped": oc.organizationScoped === true,
      "callback-url": apiURL(request, `/api/v2/oauth-clients/${oc.id}/callback`),
      "connect-path": `/api/v2/oauth-clients/${oc.id}/connect`,
    },
    relationships: {
      projects: { data: projectLinks.map((link): Record<string, string> => ({ id: link.projectId, type: "projects" })) },
      "oauth-tokens": { links: { related: `/api/v2/oauth-clients/${oc.id}/oauth-tokens` } },
      "agent-pool": {
        data: oc.agentPoolId === null ? null : { id: oc.agentPoolId, type: "agent-pools" },
        links: oc.agentPoolId === null ? {} : { related: `/api/v2/agent-pools/${oc.agentPoolId}` },
      },
    },
  };
}

function unprocessable(set: SetObj, detail: string): { errors: { status: string; title: string; detail: string }[] } {
  (set as { status: number }).status = 422;
  return { errors: [{ status: "422", title: "Unprocessable Entity", detail }] };
}

function oauthFlowError(set: SetObj, status: number, title: string, detail: string): { errors: { status: string; title: string; detail: string }[] } {
  (set as { status: number }).status = status;
  return { errors: [{ status: String(status), title, detail }] };
}

function redirect(location: string, status: 302 | 303): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Location: location,
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function completeOAuthHandshake(
  oc: OcItem,
  storedToken: string,
  serviceProviderUser: string | null,
  request: Readonly<{ url: string }>,
): Promise<Response> {
  const tokenId = `ot-${crypto.randomUUID()}`;
  await db.insert(oauthTokens).values({
    id: tokenId,
    oauthClientId: oc.id,
    serviceProviderUser,
    token: await encryptSecret(storedToken),
    createdAt: Date.now(),
  });
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, oc.orgId) });
  const destination = new URL(
    `/app/organizations/${encodeURIComponent(org?.name ?? oc.orgId)}/settings/vcs`,
    request.url,
  );
  destination.searchParams.set("oauth_token_id", tokenId);
  return redirect(destination.toString(), 303);
}

export const oauthClientRoutes = new Elysia({ name: "oauthClients" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/oauth-clients", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const clientList = await db.query.oauthClients.findMany({ where: eq(oauthClients.orgId, org.id) });
    return { data: await Promise.all(clientList.map(async (oc: OcItem): Promise<Record<string, unknown>> => oauthClientResource(oc, request))) };
  })
  .post("/api/v2/organizations/:org_name/oauth-clients", async ({ params, body, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") return unprocessable(set, "Name is required");
    const id = `oc-${crypto.randomUUID()}`;
    const rawServiceProvider = attributes["service-provider"];
    if (rawServiceProvider !== undefined && typeof rawServiceProvider !== "string") return unprocessable(set, "Unsupported service provider");
    const serviceProvider = rawServiceProvider ?? "github";
    if (!SERVICE_PROVIDERS.has(serviceProvider)) return unprocessable(set, "Unsupported service provider");
    const projectIds = relationshipProjectIds(data);
    if (projectIds === null) return unprocessable(set, "Projects must be valid project resource identifiers");
    if (projectIds !== undefined && !(await validProjectScope(projectIds, org.id))) return unprocessable(set, "One or more projects do not belong to the organization");
    const agentPoolId = relationshipAgentPoolId(data);
    if (agentPoolId === false) return unprocessable(set, "Agent pool must be a valid agent-pools resource identifier");
    if (typeof agentPoolId === "string" && !(await validAgentPool(agentPoolId, org.id))) {
      return unprocessable(set, "Agent pool does not belong to the organization");
    }
    const apiUrl = typeof attributes["api-url"] === "string" ? attributes["api-url"] : null;
    const httpUrl = typeof attributes["http-url"] === "string" ? attributes["http-url"] : null;
    const key = typeof attributes.key === "string" ? attributes.key : null;
    const secret = typeof attributes.secret === "string" ? attributes.secret : null;
    const rsaPublicKey = typeof attributes["rsa-public-key"] === "string" ? attributes["rsa-public-key"] : null;
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.insert(oauthClients).values({
        id,
        orgId: org.id,
        agentPoolId: agentPoolId ?? null,
        name,
        serviceProvider,
        apiUrl,
        httpUrl,
        key,
        secret,
        rsaPublicKey,
        createdAt: Date.now(),
      });
      if (projectIds !== undefined && projectIds.length > 0) {
        await t.insert(oauthClientProjects).values(projectIds.map((projectId: string): typeof oauthClientProjects.$inferInsert => ({
          id: `ocp-${crypto.randomUUID()}`,
          oauthClientId: id,
          projectId,
        })));
      }
    });
    const created = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, id) });
    if (created === undefined) throw new Error("OAuth client was not created");
    (set as { status: number }).status = 201;
    return { data: await oauthClientResource(created, request) };
  })
  .get("/api/v2/oauth-clients/:oc_id", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const ocId = params.oc_id ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrganizationPermission(oc.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await oauthClientResource(oc, request) };
  })
  .patch("/api/v2/oauth-clients/:oc_id", async ({ params, body, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const ocId = params.oc_id ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrganizationPermission(oc.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof oauthClients.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes["service-provider"] !== undefined) {
      if (typeof attributes["service-provider"] !== "string" || !SERVICE_PROVIDERS.has(attributes["service-provider"])) return unprocessable(set, "Unsupported service provider");
      updates.serviceProvider = attributes["service-provider"];
    }
    const projectIds = relationshipProjectIds(data);
    if (projectIds === null) return unprocessable(set, "Projects must be valid project resource identifiers");
    if (projectIds !== undefined && !(await validProjectScope(projectIds, oc.orgId))) return unprocessable(set, "One or more projects do not belong to the organization");
    const agentPoolId = relationshipAgentPoolId(data);
    if (agentPoolId === false) return unprocessable(set, "Agent pool must be a valid agent-pools resource identifier");
    if (typeof agentPoolId === "string" && !(await validAgentPool(agentPoolId, oc.orgId))) {
      return unprocessable(set, "Agent pool does not belong to the organization");
    }
    if (agentPoolId !== undefined) updates.agentPoolId = agentPoolId;
    if (attributes["api-url"] !== undefined) updates.apiUrl = typeof attributes["api-url"] === "string" ? attributes["api-url"] : null;
    if (attributes["http-url"] !== undefined) updates.httpUrl = typeof attributes["http-url"] === "string" ? attributes["http-url"] : null;
    if (attributes.key !== undefined) updates.key = typeof attributes.key === "string" ? attributes.key : null;
    if (attributes.secret !== undefined) updates.secret = typeof attributes.secret === "string" ? attributes.secret : null;
    if (attributes["rsa-public-key"] !== undefined) updates.rsaPublicKey = typeof attributes["rsa-public-key"] === "string" ? attributes["rsa-public-key"] : null;
    if (Object.keys(updates).length > 0) await db.update(oauthClients).set(updates).where(eq(oauthClients.id, ocId));
    if (projectIds !== undefined) await replaceProjectScope(ocId, projectIds);
    const updated = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await oauthClientResource(updated, request) };
  })
  .post("/api/v2/oauth-clients/:oc_id/relationships/projects", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const ocId = params.oc_id ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrganizationPermission(oc.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const projectIds = parseProjectIdentifiers(payload.data);
    if (projectIds === null) return unprocessable(set, "Projects must be valid project resource identifiers");
    if (!(await validProjectScope(projectIds, oc.orgId))) return unprocessable(set, "One or more projects do not belong to the organization");
    if (projectIds.length > 0) {
      await db.insert(oauthClientProjects).values(projectIds.map((projectId: string): typeof oauthClientProjects.$inferInsert => ({
        id: `ocp-${crypto.randomUUID()}`,
        oauthClientId: ocId,
        projectId,
      }))).onConflictDoNothing();
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/oauth-clients/:oc_id/relationships/projects", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const ocId = params.oc_id ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrganizationPermission(oc.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const projectIds = parseProjectIdentifiers(payload.data);
    if (projectIds === null) return unprocessable(set, "Projects must be valid project resource identifiers");
    if (!(await validProjectScope(projectIds, oc.orgId))) return unprocessable(set, "One or more projects do not belong to the organization");
    if (projectIds.length > 0) {
      await db.delete(oauthClientProjects).where(and(
        eq(oauthClientProjects.oauthClientId, ocId),
        inArray(oauthClientProjects.projectId, projectIds),
      ));
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/oauth-clients/:oc_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const ocId = params.oc_id ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrganizationPermission(oc.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(oauthClients).where(eq(oauthClients.id, ocId));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/oauth-clients/:oc_id/connect", async ({ params, query, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const ocId = params.oc_id ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrganizationPermission(oc.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const rawProjectId = stringQuery(query, "project_id");
    const projectId = rawProjectId === "" ? null : rawProjectId;
    if (!(await validHandshakeProjectScope(oc, projectId))) {
      return oauthFlowError(set, 403, "Forbidden", "The OAuth client is not available to that project");
    }
    const oauth2 = oauth2Endpoints(oc);
    const oauth1 = oauth1Endpoints(oc);
    if (oauth2 === null && oauth1 === null) return unprocessable(set, "This VCS provider does not support an OAuth handshake");
    if (oc.key === null || oc.key === "" || oc.secret === null || oc.secret === "") {
      return unprocessable(set, "OAuth client key and secret are required");
    }

    pruneOAuthStates();
    const state = crypto.randomUUID();
    const redirectUri = apiURL(request, `/api/v2/oauth-clients/${oc.id}/callback`);
    if (oauth1 !== null) {
      const callback = new URL(redirectUri);
      callback.searchParams.set("state", state);
      let requestToken: { token: string; tokenSecret: string; callbackConfirmed: boolean } | null;
      try {
        requestToken = await oauth1TokenRequest(oc, oauth1.requestToken.toString(), {
          oauth_callback: callback.toString(),
        });
      } catch {
        requestToken = null;
      }
      if (requestToken?.callbackConfirmed !== true) {
        return oauthFlowError(set, 502, "VCS Provider Error", "Bitbucket Data Center did not return a usable request token");
      }
      oauthHandshakeStates.set(state, {
        clientId: oc.id,
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
        flow: "oauth1",
        projectId,
        redirectUri: callback.toString(),
        requestToken: requestToken.token,
        requestTokenSecret: requestToken.tokenSecret,
        tokenOrgId: tokenOrgId ?? null,
        tokenTeamId: tokenTeamId ?? null,
        userId: user?.id ?? null,
      });
      oauth1.authorization.searchParams.set("oauth_token", requestToken.token);
      return redirect(oauth1.authorization.toString(), 302);
    }
    if (oauth2 === null) return unprocessable(set, "This VCS provider does not support the OAuth2 authorization-code flow");

    oauthHandshakeStates.set(state, {
      clientId: oc.id,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      flow: "oauth2",
      projectId,
      redirectUri,
      tokenOrgId: tokenOrgId ?? null,
      tokenTeamId: tokenTeamId ?? null,
      userId: user?.id ?? null,
    });
    oauth2.authorization.searchParams.set("client_id", oc.key);
    oauth2.authorization.searchParams.set("redirect_uri", redirectUri);
    oauth2.authorization.searchParams.set("response_type", "code");
    oauth2.authorization.searchParams.set("state", state);
    if (oauth2.scope !== undefined) oauth2.authorization.searchParams.set("scope", oauth2.scope);
    return redirect(oauth2.authorization.toString(), 302);
  })
  .get("/api/v2/oauth-clients/:oc_id/callback", async ({ params, query, request, set }: ParamCtx): Promise<unknown> => {
    pruneOAuthStates();
    const stateId = stringQuery(query, "state");
    const state = oauthHandshakeStates.get(stateId);
    if (state?.clientId !== (params.oc_id ?? "")) {
      return oauthFlowError(set, 400, "Invalid OAuth Callback", "OAuth state is missing, expired, or invalid");
    }
    oauthHandshakeStates.delete(stateId);
    if (stringQuery(query, "error") !== "") {
      return oauthFlowError(set, 400, "OAuth Authorization Failed", "The VCS provider did not authorize the connection");
    }

    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, state.clientId) });
    const stillAuthorized = await checkOrganizationPermission(
      oc?.orgId ?? "",
      state.userId ?? undefined,
      state.tokenOrgId,
      state.tokenTeamId,
      "manage-vcs-settings",
    );
    if (
      oc === undefined
      || !stillAuthorized
      || !(await validHandshakeProjectScope(oc, state.projectId))
    ) {
      return oauthFlowError(set, 403, "Forbidden", "OAuth client authorization is no longer valid");
    }
    if (state.flow === "oauth1") {
      const callbackToken = stringQuery(query, "oauth_token");
      const verifier = stringQuery(query, "oauth_verifier");
      if (callbackToken !== state.requestToken || verifier === "") {
        return oauthFlowError(set, 400, "Invalid OAuth Callback", "OAuth request token or verifier is invalid");
      }
      const endpoints = oauth1Endpoints(oc);
      if (endpoints === null) return unprocessable(set, "This VCS provider does not support the OAuth 1.0 flow");

      let exchanged: { token: string; tokenSecret: string } | null;
      try {
        exchanged = await oauth1TokenRequest(
          oc,
          endpoints.accessToken.toString(),
          { oauth_verifier: verifier },
          state.requestToken,
          state.requestTokenSecret,
        );
      } catch {
        exchanged = null;
      }
      if (exchanged === null) {
        return oauthFlowError(set, 502, "VCS Provider Error", "Bitbucket Data Center did not return a usable access token");
      }
      let serviceProviderUser: string | null = null;
      try {
        serviceProviderUser = await oauth1ProviderUser(
          oc,
          endpoints.user.toString(),
          exchanged.token,
          exchanged.tokenSecret,
        );
      } catch {
        // The token is still usable when Bitbucket's optional identity endpoint is unavailable.
      }
      return completeOAuthHandshake(
        oc,
        JSON.stringify({
          oauth_token: exchanged.token,
          oauth_token_secret: exchanged.tokenSecret,
        }),
        serviceProviderUser,
        request,
      );
    }

    const code = stringQuery(query, "code");
    if (code === "") return oauthFlowError(set, 400, "Invalid OAuth Callback", "Authorization code is required");
    const endpoints = oauth2Endpoints(oc);
    if (endpoints === null) return unprocessable(set, "This VCS provider does not support the OAuth2 authorization-code flow");

    let exchanged: { accessToken: string; serviceProviderUser: string | null } | null;
    try {
      exchanged = await exchangeAuthorizationCode(
        oc,
        endpoints.token.toString(),
        endpoints.user.toString(),
        endpoints.basicTokenAuth === true,
        code,
        state.redirectUri,
      );
    } catch {
      exchanged = null;
    }
    if (exchanged === null) {
      return oauthFlowError(set, 502, "VCS Provider Error", "The VCS provider did not return a usable access token");
    }
    return completeOAuthHandshake(oc, exchanged.accessToken, exchanged.serviceProviderUser, request);
  })
  .get("/api/v2/oauth-clients/:oc_id/oauth-tokens", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const ocId = params.oc_id ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrganizationPermission(oc.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tokenList = await db.query.oauthTokens.findMany({ where: eq(oauthTokens.oauthClientId, ocId) });
    return { data: tokenList.map((ot: OtItem): Record<string, unknown> => ({ id: ot.id, type: "oauth-tokens", attributes: { "service-provider-user": ot.serviceProviderUser, "has-ssh-key": ot.hasSshKey, "created-at": new Date(ot.createdAt).toISOString() } })) };
  })
  .get("/api/v2/oauth-tokens/:ot_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const otId = params.ot_id ?? "";
    const ot = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, otId) });
    if (ot === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ot.oauthClientId) });
    if (oc === undefined || !(await checkOrganizationPermission(oc.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ot.id, type: "oauth-tokens", attributes: { "service-provider-user": ot.serviceProviderUser, "has-ssh-key": ot.hasSshKey, "created-at": new Date(ot.createdAt).toISOString() } } };
  })
  .delete("/api/v2/oauth-tokens/:ot_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const otId = params.ot_id ?? "";
    const ot = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, otId) });
    if (ot === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ot.oauthClientId) });
    if (oc === undefined || !(await checkOrganizationPermission(oc.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(oauthTokens).where(eq(oauthTokens.id, otId));
    (set as { status: number }).status = 204;
    return {};
  });
