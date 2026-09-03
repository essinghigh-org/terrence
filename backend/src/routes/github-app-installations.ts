import { Elysia } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { authPlugin } from "../auth";
import { db, isPostgres } from "../db";
import { apiTokens, githubAppInstallations, oauthClients, oauthTokens, organizations, type users } from "../db/schema";
import { apiURL, checkOrganizationPermission, checkOrganizationVcsReadPermission } from "../lib/utils";
import { decryptSecret } from "../lib/secrets";
import { getGitHubAppAccessToken, getGitHubAppAccessTokenDetails } from "../lib/webhooks";
import { findVcsIntegrationUsage, isVcsIntegrationReferenceConflict, vcsIntegrationUsageDetail, type VcsIntegrationUsage } from "../lib/vcs-integration-usage";
import { AvatarService } from "../lib/avatars";
import { githubAppApiBase } from "../lib/github-api";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, unknown>>;
  request?: Readonly<{ headers: Readonly<Headers>; url: string }>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  token?: Readonly<{ id: string }> | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObj;
}>;

type SetupState = Readonly<{
  expiresAt: number;
  orgId: string;
  orgName: string;
  tokenId: string;
  tokenOrgId: string | null;
  tokenTeamId: string | null;
  userId: string | null;
}>;

type GitHubAppConfig = Readonly<{
  apiUrl: string;
  appId: number;
  appIdText: string;
  installUrl: string;
  privateKey: string;
}>;

type VerifiedInstallation = Readonly<{
  iconUrl: string | null;
  installationType: "Organization" | "User";
  installationUrl: string | null;
  name: string;
}>;

const SETUP_STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 10_000;
const setupStates = new Map<string, SetupState>();

function stringQuery(query: Readonly<Record<string, unknown>> | undefined, key: string): string {
  const value = query?.[key];
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function configuredUrl(value: string | undefined, fallback: string): URL | null {
  try {
    const url = new URL(value === undefined || value.trim() === "" ? fallback : value);
    return (
      (url.protocol === "https:" || url.protocol === "http:")
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
    ) ? url : null;
  } catch {
    return null;
  }
}

function githubAppConfig(): GitHubAppConfig | null {
  const appIdText = process.env["GITHUB_APP_ID"]?.trim() ?? "";
  const appId = positiveInteger(appIdText);
  const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"]?.replaceAll("\\n", "\n").trim() ?? "";
  const slug = process.env["GITHUB_APP_SLUG"]?.trim() ?? "";
  const httpUrl = configuredUrl(process.env["GITHUB_APP_HTTP_URL"], "https://github.com");
  const apiUrl = githubAppApiBase(true);
  if (
    appId === null
    || privateKey === ""
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(slug)
    || httpUrl === null
    || apiUrl === undefined
  ) return null;
  const installUrl = new URL(`/apps/${encodeURIComponent(slug)}/installations/new`, httpUrl);
  return { apiUrl, appId, appIdText, installUrl: installUrl.toString(), privateKey };
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

function authorizationResponse(
  request: Readonly<{ headers: Readonly<Headers> }>,
  state: string,
  location: string,
): Response {
  const acceptsJson = (request.headers.get("accept") ?? "")
    .split(",")
    .some((value: string): boolean => {
      const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
      return mediaType === "application/json" || mediaType === "application/vnd.api+json";
    });
  if (!acceptsJson) return redirect(location, 302);
  return Response.json({
    data: {
      id: state,
      type: "vcs-authorization-requests",
      attributes: { "authorization-url": location },
    },
  }, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/vnd.api+json",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function flowError(
  set: SetObj,
  status: number,
  title: string,
  detail: string,
): { errors: { status: string; title: string; detail: string }[] } {
  (set as { status: number }).status = status;
  return { errors: [{ status: String(status), title, detail }] };
}

function pruneSetupStates(): void {
  const now = Date.now();
  for (const [id, state] of setupStates) {
    if (state.expiresAt <= now) setupStates.delete(id);
  }
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Base URL for GitHub REST API calls. Every App request uses the same
 * GITHUB_APP_API_URL > GITHUB_API_URL > public default resolution.
 */
type RepositoryProvider = "github" | "gitlab" | "bitbucket";
type RepositoryRecord = Readonly<Record<string, unknown>>;
type RepositoryResource = { id: string; type: string; attributes: { identifier: string; name: string; owner: string } };
type RepositoryPage = Readonly<{
  records: readonly RepositoryRecord[];
  rawCount: number;
  nextUrl: string | null;
}>;

const REPOSITORY_PAGE_SIZE = 100;
const MAX_REPOSITORY_PAGES = 20;
const MAX_BITBUCKET_WORKSPACES = 100;
const MAX_BITBUCKET_REQUESTS = 100;

function repositoryProvider(serviceProvider: string): RepositoryProvider | null {
  if (serviceProvider === "github" || serviceProvider === "github_enterprise") return "github";
  if (["gitlab", "gitlab_ce", "gitlab_ee"].includes(serviceProvider)) return "gitlab";
  if (serviceProvider === "bitbucket") return "bitbucket";
  return null;
}

function validRepositoryApiUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
    ) return null;
    return url;
  } catch {
    return null;
  }
}

function appendApiPath(base: URL, suffix: string): URL {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`;
  return url;
}

function repositoryApiTarget(client: Readonly<typeof oauthClients.$inferSelect>): { base: URL; provider: RepositoryProvider } | null {
  const provider = repositoryProvider(client.serviceProvider);
  if (provider === null) return null;

  const configuredApiUrl = client.apiUrl?.trim() ?? "";
  if (configuredApiUrl !== "") {
    const base = validRepositoryApiUrl(configuredApiUrl);
    return base === null ? null : { base, provider };
  }

  const configuredHttpUrl = client.httpUrl?.trim() ?? "";
  if (configuredHttpUrl !== "") {
    const httpUrl = validRepositoryApiUrl(configuredHttpUrl);
    if (httpUrl === null) return null;
    return {
      base: appendApiPath(
        httpUrl,
        provider === "github" ? "/api/v3" : provider === "gitlab" ? "/api/v4" : "/2.0",
      ),
      provider,
    };
  }

  const defaultApiUrl = provider === "github"
    ? client.serviceProvider === "github" ? "https://api.github.com" : null
    : provider === "gitlab"
      ? client.serviceProvider === "gitlab" ? "https://gitlab.com/api/v4" : null
      : "https://api.bitbucket.org/2.0";
  if (defaultApiUrl === null) return null;
  const base = validRepositoryApiUrl(defaultApiUrl);
  return base === null ? null : { base, provider };
}

function repositoryEndpoint(base: URL, path: string, parameters: Readonly<Record<string, string>>): URL {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${path.replace(/^\/+/, "")}`;
  url.search = "";
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
}

function repositoryPageUrl(base: URL, provider: RepositoryProvider, page: number): URL {
  return provider === "github"
    ? repositoryEndpoint(base, "user/repos", { per_page: String(REPOSITORY_PAGE_SIZE), sort: "updated", page: String(page) })
    : repositoryEndpoint(base, "projects", { membership: "true", per_page: String(REPOSITORY_PAGE_SIZE), order_by: "last_activity_at", sort: "desc", page: String(page) });
}

function safeNextRepositoryUrl(value: string | null, base: URL): URL | null {
  if (value === null || value.trim() === "") return null;
  try {
    const url = new URL(value, base);
    if (
      url.origin !== base.origin
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) return null;
    return url;
  } catch {
    return null;
  }
}

function nextLink(headers: Headers): string | null {
  const link = headers.get("link");
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel=["']?next["']?/i.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

async function discoverGithubInstallationRepositories(
  apiBase: string,
  token: string,
): Promise<RepositoryResource[]> {
  const base = new URL(apiBase);
  let url = repositoryEndpoint(base, "installation/repositories", { per_page: String(REPOSITORY_PAGE_SIZE) });
  const seenUrls = new Set<string>();
  const repositories = new Map<string, RepositoryResource>();
  for (let requestCount = 0; requestCount < MAX_REPOSITORY_PAGES; requestCount += 1) {
    const urlKey = url.toString();
    if (seenUrls.has(urlKey)) break;
    seenUrls.add(urlKey);
    const response = await fetchRepositoryPage(url, token);
    if (response === null) break;
    const body = recordValue(response.body);
    const records = body?.["repositories"];
    if (!Array.isArray(records)) break;
    for (const value of records) {
      const record = recordValue(value);
      const fullName = stringValue(record?.["full_name"]);
      if (record === null || fullName === null) continue;
      const name = stringValue(record["name"]) ?? fullName.split("/").at(-1) ?? fullName;
      repositories.set(fullName, {
        id: fullName,
        type: "vcs-repositories",
        attributes: { identifier: fullName, name, owner: fullName.split("/")[0] ?? "" },
      });
    }
    const next = safeNextRepositoryUrl(nextLink(response.headers), base);
    if (next === null) break;
    url = next;
  }
  return [...repositories.values()];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function recordValue(value: unknown): RepositoryRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RepositoryRecord
    : null;
}

function normalizedRepository(record: RepositoryRecord, provider: RepositoryProvider): RepositoryResource | null {
  const namespace = recordValue(record["namespace"]);
  const ownerRecord = recordValue(record["owner"]);
  const fullName = provider === "gitlab"
    ? stringValue(record["path_with_namespace"])
      ?? (stringValue(namespace?.["full_path"]) === null || stringValue(record["path"]) === null
        ? null
        : `${stringValue(namespace?.["full_path"])}/${stringValue(record["path"])}`)
    : stringValue(record["full_name"]);
  if (fullName === null) return null;

  const name = stringValue(record["name"]) ?? fullName.split("/").at(-1) ?? fullName;
  const owner = provider === "github"
    ? stringValue(ownerRecord?.["login"])
    : provider === "bitbucket"
      ? stringValue(ownerRecord?.["display_name"]) ?? stringValue(ownerRecord?.["nickname"]) ?? stringValue(ownerRecord?.["username"])
      : null;
  const pathOwner = fullName.split("/").slice(0, -1).join("/");
  return {
    id: fullName,
    type: "vcs-repositories",
    attributes: { identifier: fullName, name, owner: owner ?? pathOwner },
  };
}

function repositoryPage(body: unknown, provider: RepositoryProvider): RepositoryPage | null {
  if (provider === "bitbucket") {
    const container = recordValue(body);
    const values = container?.["values"];
    if (!Array.isArray(values)) return null;
    return {
      nextUrl: stringValue(container?.["next"]),
      rawCount: values.length,
      records: values.flatMap((value): RepositoryRecord[] => {
        const record = recordValue(value);
        return record === null ? [] : [record];
      }),
    };
  }
  if (!Array.isArray(body)) return null;
  return {
    nextUrl: null,
    rawCount: body.length,
    records: body.flatMap((value): RepositoryRecord[] => {
      const record = recordValue(value);
      return record === null ? [] : [record];
    }),
  };
}

async function fetchRepositoryPage(url: URL, token: string): Promise<{ body: unknown; headers: Headers } | null> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return { body: await response.json() as unknown, headers: response.headers };
  } catch {
    return null;
  }
}

function workspaceSlug(record: RepositoryRecord): string | null {
  return stringValue(recordValue(record["workspace"])?.["slug"]);
}

async function discoverBitbucketRepositories(
  base: URL,
  token: string,
  serviceProviderUser: string | null,
): Promise<RepositoryResource[]> {
  const requestBudget = { remaining: MAX_BITBUCKET_REQUESTS };
  const workspaceSlugs = new Set<string>();
  let workspaceUrl = repositoryEndpoint(base, "user/workspaces", { pagelen: String(REPOSITORY_PAGE_SIZE) });
  const seenWorkspaceUrls = new Set<string>();
  for (let requestCount = 0; requestCount < MAX_REPOSITORY_PAGES; requestCount += 1) {
    if (requestBudget.remaining === 0) break;
    const urlKey = workspaceUrl.toString();
    if (seenWorkspaceUrls.has(urlKey)) break;
    seenWorkspaceUrls.add(urlKey);
    requestBudget.remaining -= 1;
    const response = await fetchRepositoryPage(workspaceUrl, token);
    if (response === null) break;
    const parsed = repositoryPage(response.body, "bitbucket");
    if (parsed === null) break;
    for (const record of parsed.records) {
      const slug = workspaceSlug(record);
      if (slug !== null && workspaceSlugs.size < MAX_BITBUCKET_WORKSPACES) workspaceSlugs.add(slug);
    }
    if (workspaceSlugs.size >= MAX_BITBUCKET_WORKSPACES) break;
    const next = safeNextRepositoryUrl(parsed.nextUrl, base);
    if (next === null) break;
    workspaceUrl = next;
  }
  if (workspaceSlugs.size === 0) {
    const fallbackWorkspace = stringValue(serviceProviderUser);
    if (fallbackWorkspace !== null) workspaceSlugs.add(fallbackWorkspace);
  }

  const repositories = new Map<string, RepositoryResource>();
  for (const workspace of workspaceSlugs) {
    if (requestBudget.remaining === 0) break;
    let url = repositoryEndpoint(base, `repositories/${encodeURIComponent(workspace)}`, {
      pagelen: String(REPOSITORY_PAGE_SIZE),
      sort: "-updated_on",
    });
    const seenUrls = new Set<string>();
    for (let requestCount = 0; requestCount < MAX_REPOSITORY_PAGES; requestCount += 1) {
      if (requestBudget.remaining === 0) break;
      const urlKey = url.toString();
      if (seenUrls.has(urlKey)) break;
      seenUrls.add(urlKey);
      requestBudget.remaining -= 1;
      const response = await fetchRepositoryPage(url, token);
      if (response === null) break;
      const parsed = repositoryPage(response.body, "bitbucket");
      if (parsed === null) break;
      for (const record of parsed.records) {
        const repository = normalizedRepository(record, "bitbucket");
        if (repository !== null) repositories.set(repository.id, repository);
      }
      const next = safeNextRepositoryUrl(parsed.nextUrl, base);
      if (next === null) break;
      url = next;
    }
  }
  return [...repositories.values()];
}

async function discoverOAuthRepositories(
  client: Readonly<typeof oauthClients.$inferSelect>,
  token: string,
  serviceProviderUser: string | null,
): Promise<RepositoryResource[]> {
  const target = repositoryApiTarget(client);
  if (target === null) return [];
  if (target.provider === "bitbucket") return discoverBitbucketRepositories(target.base, token, serviceProviderUser);

  let page = 1;
  let url = repositoryPageUrl(target.base, target.provider, page);
  const seenUrls = new Set<string>();
  const repositories: RepositoryResource[] = [];

  for (let requestCount = 0; requestCount < MAX_REPOSITORY_PAGES; requestCount += 1) {
    const urlKey = url.toString();
    if (seenUrls.has(urlKey)) break;
    seenUrls.add(urlKey);
    const response = await fetchRepositoryPage(url, token);
    if (response === null) break;
    const parsed = repositoryPage(response.body, target.provider);
    if (parsed === null) break;
    for (const record of parsed.records) {
      const repository = normalizedRepository(record, target.provider);
      if (repository !== null) repositories.push(repository);
    }

    if (target.provider === "github") {
      const next = safeNextRepositoryUrl(nextLink(response.headers), target.base);
      if (next !== null) {
        url = next;
        continue;
      }
    } else {
      const nextPageText = response.headers.get("x-next-page")?.trim() ?? "";
      const nextPage = /^[1-9]\d*$/.test(nextPageText) ? Number(nextPageText) : null;
      if (nextPage !== null && Number.isSafeInteger(nextPage)) {
        page = nextPage;
        url = repositoryPageUrl(target.base, target.provider, page);
        continue;
      }
    }

    if (parsed.rawCount < REPOSITORY_PAGE_SIZE) break;
    page += 1;
    url = repositoryPageUrl(target.base, target.provider, page);
  }
  return repositories;
}

async function fetchInstallation(
  config: Readonly<GitHubAppConfig>,
  installationId: number,
): Promise<VerifiedInstallation | null> {
  let appToken: string;
  try {
    appToken = jwt.sign({
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + (9 * 60),
      iss: config.appIdText,
    }, config.privateKey, { algorithm: "RS256" });
  } catch {
    return null;
  }

  try {
    const endpoint = `${config.apiUrl.replace(/\/$/, "")}/app/installations/${String(installationId)}`;
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json() as Record<string, unknown>;
    const account = payload["account"] !== null && typeof payload["account"] === "object"
      ? payload["account"] as Record<string, unknown>
      : {};
    const returnedId = payload["id"];
    const returnedAppId = payload["app_id"];
    const rawName = typeof account["login"] === "string"
      ? account["login"]
      : typeof account["name"] === "string"
        ? account["name"]
        : "";
    const name = rawName.trim();
    const rawType = payload["target_type"] ?? account["type"];
    if (
      returnedId !== installationId
      || returnedAppId !== config.appId
      || name === ""
      || (rawType !== "Organization" && rawType !== "User")
    ) return null;
    return {
      iconUrl: httpUrl(account["avatar_url"]),
      installationType: rawType,
      installationUrl: httpUrl(payload["html_url"]),
      name: name.slice(0, 255),
    };
  } catch {
    return null;
  }
}

function installationResource(installation: Readonly<typeof githubAppInstallations.$inferSelect>): Record<string, unknown> {
  return {
    id: installation.id,
    type: "github-app-installations",
    attributes: {
      name: installation.name,
      "installation-id": installation.installationId,
      "icon-url": installation.iconUrl === null ? null : AvatarService.resolveUrl("github-app", installation.iconUrl),
      "installation-type": installation.installationType,
      "installation-url": installation.installationUrl,
      "created-at": new Date(installation.createdAt).toISOString(),
    },
  };
}

export const githubAppInstallationRoutes = new Elysia({ name: "githubAppInstallations" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/vcs-connections/:connection_id/repositories", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (org === undefined || !(await checkOrganizationVcsReadPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    let connectionId = params["connection_id"] ?? "";
    if (connectionId.startsWith("github-app:")) connectionId = connectionId.slice("github-app:".length);
    if (connectionId.startsWith("oauth-token:")) connectionId = connectionId.slice("oauth-token:".length);

    const repos: { id: string; type: string; attributes: { identifier: string; name: string; owner: string } }[] = [];

    // 1. Check if connection is GitHub App Installation
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.id, connectionId), eq(githubAppInstallations.orgId, org.id)),
    });

    if (installation !== undefined) {
      const token = await getGitHubAppAccessToken(installation.installationId);
      const apiBase = githubAppApiBase(true);
      if (token !== null && apiBase !== undefined) {
        try {
          repos.push(...await discoverGithubInstallationRepositories(apiBase, token));
        } catch {
          // A valid installation with a temporarily unavailable API returns an
          // empty discovery result, matching OAuth discovery semantics.
        }
      }
      return { data: repos };
    } else {
      // 2. Resolve OAuth token -> OAuth client inside this organization before
      // decrypting the token or contacting any provider API. The token ID is a
      // client-controlled path parameter and must not be looked up globally.
      const oauthToken = await db.query.oauthTokens.findFirst({
        where: eq(oauthTokens.id, connectionId),
      });
      const oauthClient = oauthToken === undefined
        ? undefined
        : await db.query.oauthClients.findFirst({
            where: and(eq(oauthClients.id, oauthToken.oauthClientId), eq(oauthClients.orgId, org.id)),
          });
      if (oauthToken === undefined || oauthClient === undefined) {
        (set as { status: number }).status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
      }
      try {
        const tokenStr = await decryptSecret(oauthToken.token);
        repos.push(...await discoverOAuthRepositories(oauthClient, tokenStr, oauthToken.serviceProviderUser));
      } catch {
        // Preserve the existing discovery behavior for provider/decryption
        // failures: the connection is valid, but currently has no results.
      }
    }

    return { data: repos };
  })
  .get("/api/v2/github-app/installations", async ({ user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    // go-tfe GHAInstallations.List (global list across orgs) — used by the
    // tfe_github_app_installation data source, which pages through this.
    // User tokens need a logged-in user; organization and team tokens are
    // scoped by their own identifiers even when user is null.
    const isOrgtoken = tokenOrgId !== null && tokenOrgId !== undefined;
    const isTeamToken = tokenTeamId !== null && tokenTeamId !== undefined;
    if ((user === null || user === undefined) && !isOrgtoken && !isTeamToken) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    const installations = await db.query.githubAppInstallations.findMany();
    // Never leak another organization's installations: a site admin sees all,
    // an org token is scoped to its org, and user/team tokens only see
    // installs in orgs where they have VCS read access.
    const filtered: typeof installations = [];
    for (const installation of installations) {
      if (user !== undefined && user !== null && user.isSiteAdmin === true) { filtered.push(installation); continue; }
      if (isOrgtoken) {
        if (installation.orgId === tokenOrgId) filtered.push(installation);
        continue;
      }
      if (await checkOrganizationVcsReadPermission(installation.orgId, user?.id, tokenOrgId, tokenTeamId)) filtered.push(installation);
    }
    return {
      data: filtered.map((installation): Record<string, unknown> => installationResource({ ...installation, iconUrl: null, installationType: "Organization", installationUrl: null })),
      meta: { pagination: { "current-page": 1, "total-pages": 1 } },
    };
  })
  .get("/api/v2/github-app/installation/:gh_app_installation_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const installation = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, params["gh_app_installation_id"] ?? "") });
    if (installation === undefined || (user?.isSiteAdmin !== true && !(await checkOrganizationVcsReadPermission(installation.orgId, user?.id, tokenOrgId, tokenTeamId)))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: installationResource(installation) };
  })
  .get("/api/v2/organizations/:org_name/github-app/installations", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (org === undefined || !(await checkOrganizationVcsReadPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const installations = await db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.orgId, org.id),
    });
    return { data: installations.map(installationResource) };
  })
  .post("/api/v2/organizations/:org_name/github-app/installations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload["data"] !== null && typeof payload["data"] === "object" ? payload["data"] as Record<string, unknown> : {};
    const attributes = data["attributes"] !== null && typeof data["attributes"] === "object" ? data["attributes"] as Record<string, unknown> : {};
    const name = typeof attributes["name"] === "string" ? attributes["name"].trim() : "";
    const installationId = attributes["installation-id"];
    if (name === "" || typeof installationId !== "number" || !Number.isSafeInteger(installationId) || installationId <= 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and a positive integer installation ID are required" }] };
    }
    const existing = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.orgId, org.id), eq(githubAppInstallations.installationId, installationId)),
    });
    if (existing !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Installation ID is already registered in this organization" }] };
    }
    const installation = {
      id: `ghain-${crypto.randomUUID()}`,
      orgId: org.id,
      name,
      installationId,
      createdAt: Date.now(),
    };
    await db.insert(githubAppInstallations).values(installation);
    (set as { status: number }).status = 201;
    return { data: installationResource({ ...installation, iconUrl: null, installationType: "Organization", installationUrl: null }) };
  })
  .delete("/api/v2/organizations/:org_name/github-app/installations/:installation_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.id, params["installation_id"] ?? ""),
        eq(githubAppInstallations.orgId, org.id),
      ),
    });
    if (installation === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const conflict = await db.transaction(async (tx): Promise<VcsIntegrationUsage | null> => {
      if (isPostgres) {
        await (tx as unknown as { execute: (query: unknown) => Promise<unknown> })
          .execute(sql`SELECT id FROM github_app_installations WHERE id = ${installation.id} FOR UPDATE`);
      }
      const usage = await findVcsIntegrationUsage(org.id, { kind: "github-app", id: installation.id }, tx);
      if (usage.workspaces.length > 0 || usage.policySets.length > 0) return usage;
      try {
        await tx.transaction(async (savepoint): Promise<void> => {
          await savepoint.delete(githubAppInstallations).where(eq(githubAppInstallations.id, installation.id));
        });
      } catch (error: unknown) {
        if (!isVcsIntegrationReferenceConflict(error)) throw error;
        return findVcsIntegrationUsage(org.id, { kind: "github-app", id: installation.id }, tx);
      }
      return null;
    });
    if (conflict !== null) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: vcsIntegrationUsageDetail(conflict) }] };
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/organizations/:org_name/github-app/installations/setup", async ({ params, request, user, token, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (
      org === undefined
      || request === undefined
      || token === null
      || token === undefined
      || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))
    ) {
      return flowError(set, 404, "Not Found", "Organization not found");
    }
    const config = githubAppConfig();
    if (config === null) {
      return flowError(
        set,
        422,
        "GitHub App Not Configured",
        "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_SLUG must be configured",
      );
    }

    pruneSetupStates();
    const stateId = crypto.randomUUID();
    setupStates.set(stateId, {
      expiresAt: Date.now() + SETUP_STATE_TTL_MS,
      orgId: org.id,
      orgName: org.name,
      tokenId: token.id,
      tokenOrgId: tokenOrgId ?? null,
      tokenTeamId: tokenTeamId ?? null,
      userId: user?.id ?? null,
    });
    const installUrl = new URL(config.installUrl);
    installUrl.searchParams.set("state", stateId);
    return authorizationResponse(request, stateId, installUrl.toString());
  })
  .get("/api/v2/github-app/installations/callback", async ({ query, request, set }: ParamCtx): Promise<unknown> => {
    pruneSetupStates();
    const stateId = stringQuery(query, "state");
    const state = setupStates.get(stateId);
    if (state === undefined) {
      return flowError(set, 400, "Invalid GitHub App Callback", "Setup state is missing, expired, or invalid");
    }
    setupStates.delete(stateId);

    const setupAction = stringQuery(query, "setup_action");
    const installationId = positiveInteger(stringQuery(query, "installation_id"));
    if ((setupAction !== "install" && setupAction !== "update") || installationId === null) {
      return flowError(set, 400, "Invalid GitHub App Callback", "GitHub returned an invalid setup action or installation ID");
    }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, state.orgId) });
    const initiatingToken = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, state.tokenId) });
    const stillAuthorized = initiatingToken !== undefined
      && (
        state.userId !== null
          ? initiatingToken.userId === state.userId
          : state.tokenTeamId !== null
            ? initiatingToken.teamId === state.tokenTeamId
            : initiatingToken.orgId === state.orgId && state.tokenOrgId === state.orgId
      )
      && await checkOrganizationPermission(
        state.orgId,
        state.userId ?? undefined,
        state.tokenOrgId,
        state.tokenTeamId,
        "manage-vcs-settings",
      );
    if (org?.name !== state.orgName || !stillAuthorized) {
      return flowError(set, 403, "Forbidden", "Organization authorization is no longer valid");
    }
    const config = githubAppConfig();
    if (config === null) {
      return flowError(set, 422, "GitHub App Not Configured", "GitHub App configuration is unavailable");
    }
    const verified = await fetchInstallation(config, installationId);
    if (verified === null) {
      return flowError(set, 502, "GitHub App Verification Failed", "GitHub did not return a matching installation for this App");
    }

    const insertedId = `ghain-${crypto.randomUUID()}`;
    await db.insert(githubAppInstallations).values({
      id: insertedId,
      orgId: org.id,
      name: verified.name,
      installationId,
      iconUrl: verified.iconUrl,
      installationType: verified.installationType,
      installationUrl: verified.installationUrl,
      createdAt: Date.now(),
    }).onConflictDoUpdate({
      target: [githubAppInstallations.orgId, githubAppInstallations.installationId],
      set: {
        name: verified.name,
        iconUrl: verified.iconUrl,
        installationType: verified.installationType,
        installationUrl: verified.installationUrl,
      },
    });
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.orgId, org.id),
        eq(githubAppInstallations.installationId, installationId),
      ),
    });
    if (installation === undefined || request === undefined) {
      return flowError(set, 500, "Internal Server Error", "GitHub App installation could not be saved");
    }

    const destination = new URL(apiURL(request, `/app/${encodeURIComponent(org.name)}/settings/vcs`));
    destination.searchParams.set("github_app_installation", installation.id);
    return redirect(destination.toString(), 303);
  })
  .get("/api/v2/organizations/:org_name/github-app/diagnostics", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    // 8.12 GitHub App permission diagnostics — detects missing required
    // permissions by exercising the exact API calls Terrence makes with the
    // installation (commit statuses write path) and reports what to change.
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const installations = await db.query.githubAppInstallations.findMany({ where: eq(githubAppInstallations.orgId, org.id) });
    if (installations.length === 0) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "No GitHub App installation is registered for this organization. Install the app on the target repository first." }] };
    }
    const config = githubAppConfig();
    const results = await Promise.all(installations.map(async (installation) => {
      const checks: {
        id: string; label: string; ok: boolean; status: number | null; detail: string;
      }[] = [];
      const tokenDetails = await getGitHubAppAccessTokenDetails(installation.installationId);
      if (tokenDetails === null) {
        checks.push({ id: "app-token", label: "GitHub App token creation", ok: false, status: null, detail: "GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is missing or invalid — token generation failed." });
        return { installationId: installation.installationId, config: config?.appId ?? null, checks };
      }
      const token = tokenDetails.token;
      const githubApiBase = githubAppApiBase(true) ?? "https://api.github.com";
      const repoHeaders = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Terrence",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      // Listing repositories is the read path Terrence uses to resolve a
      // workspace's VCS repo; an install scoped to too few repos breaks it.
      // GitHub returns archived repositories in this list, but archived repos
      // reject status writes even when the App has the required permission.
      let repositoryUrl = repositoryEndpoint(new URL(githubApiBase), "installation/repositories", {
        per_page: String(REPOSITORY_PAGE_SIZE),
      });
      let repo: { full_name: string } | undefined;
      let sawRepository = false;
      for (let requestCount = 0; requestCount < MAX_REPOSITORY_PAGES; requestCount += 1) {
        const statusRes = await fetch(repositoryUrl, {
          headers: repoHeaders, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });
        if (!statusRes.ok) {
          checks.push({ id: "installation-access", label: "Installation repo access", ok: false, status: statusRes.status, detail: `Installation could not list repositories (HTTP ${statusRes.status}). Re-install the app and grant repository access.` });
          return { installationId: installation.installationId, config: config?.appId ?? null, checks };
        }
        const repoList = await statusRes.json() as { repositories?: { full_name?: unknown; archived?: unknown }[] };
        for (const candidate of repoList.repositories ?? []) {
          if (typeof candidate.full_name !== "string" || candidate.full_name === "") continue;
          sawRepository = true;
          if (candidate.archived !== true) {
            repo = { full_name: candidate.full_name };
            break;
          }
        }
        if (repo !== undefined) break;
        const next = safeNextRepositoryUrl(nextLink(statusRes.headers), new URL(githubApiBase));
        if (next === null) break;
        repositoryUrl = next;
      }
      if (repo === undefined) {
        checks.push({
          id: "repo-scope",
          label: "Repository access scope",
          ok: false,
          status: null,
          detail: sawRepository
            ? "The installation only exposes archived repositories, which cannot accept commit statuses. Select at least one active repository for the installation."
            : "The installation has access to no repositories. Select at least one repository (including the ones this workspace points at).",
        });
        return { installationId: installation.installationId, config: config?.appId ?? null, checks };
      }
      if (tokenDetails.permissions !== null) {
        const statusesPermission = tokenDetails.permissions["statuses"];
        if (statusesPermission === "write") {
          checks.push({ id: "commit-statuses", label: "Commit statuses (write)", ok: true, status: null, detail: `The installation access token grants Commit statuses write on active repository ${repo.full_name}.` });
        } else {
          checks.push({ id: "commit-statuses", label: "Commit statuses (write)", ok: false, status: null, detail: `The installation access token reports Commit statuses permission as ${statusesPermission === undefined ? "not granted" : JSON.stringify(statusesPermission)} on ${repo.full_name}. In the GitHub App settings for this installation, grant the 'Commit statuses' permission at 'Read and write', then save.` });
        }
        return { installationId: installation.installationId, config: config?.appId ?? null, checks };
      }
      // Some GitHub-compatible APIs omit permissions from the access-token
      // response. Keep the synthetic write probe for those deployments.
      const testSha = "a".repeat(40);
      const writeRes = await fetch(`${githubApiBase}/repos/${encodeURIComponent(repo.full_name)}/statuses/${testSha}`, {
        method: "POST",
        headers: repoHeaders,
        body: JSON.stringify({ state: "pending", context: "terrence/diagnostics", description: "Terrence permission check" }),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      // GitHub-compatible APIs commonly return 422 for a synthetic
      // (non-existent) SHA when the token has the commit-statuses permission.
      // A 200 also proves the permission. 403/404 remain failure signals when
      // the API did not provide explicit permission metadata above.
      if (writeRes.ok || writeRes.status === 422) {
        checks.push({ id: "commit-statuses", label: "Commit statuses (write)", ok: true, status: writeRes.status, detail: `Commit statuses write path is authorized on active repository ${repo.full_name}.` });
      } else if (writeRes.status === 404) {
        checks.push({ id: "commit-statuses", label: "Commit statuses (write)", ok: false, status: 404, detail: `Commit statuses write returned 404 on ${repo.full_name}. In the GitHub App settings for this installation, grant the 'Commit statuses' permission at 'Read and write', then save.` });
      } else if (writeRes.status === 403) {
        checks.push({ id: "commit-statuses", label: "Commit statuses (write)", ok: false, status: 403, detail: `Commit statuses write returned 403 on ${repo.full_name}. In the GitHub App settings for this installation, grant the 'Commit statuses' permission at 'Read and write', then save.` });
      } else {
        checks.push({ id: "commit-statuses", label: "Commit statuses (write)", ok: false, status: writeRes.status, detail: `Commit statuses write returned HTTP ${writeRes.status}. Check the GitHub App's permission settings.` });
      }
      return { installationId: installation.installationId, config: config?.appId ?? null, checks };
    }));
    return { data: results };
  });
