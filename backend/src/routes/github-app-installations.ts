import { newResourceId } from "../lib/resource-id";
import { integrationSetting } from "../lib/runtime-config";
import { Elysia } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { authPlugin } from "../auth";
import { db, isPostgres } from "../db";
import { apiTokens, githubAppInstallations, oauthClients, oauthTokens, organizations, users } from "../db/schema";
import { apiURL, checkOrganizationPermission, checkOrganizationVcsReadPermission, requestBaseUrl } from "../lib/utils";
import { decryptSecret } from "../lib/secrets";
import { fetchVcsUrl, getGitHubAppAccessToken, getGitHubAppAccessTokenDetails, type GitHubAppAccessTokenDetails } from "../lib/webhooks";
import { findVcsIntegrationUsage, isVcsIntegrationReferenceConflict, vcsIntegrationUsageDetail, type VcsIntegrationUsage } from "../lib/vcs-integration-usage";
import { AvatarService } from "../lib/avatars";
import { githubAppApiBase } from "../lib/github-api";
import {
  activatePendingGitHubAppConfiguration,
  disconnectGitHubApp,
  getGitHubAppConfiguration,
  getGitHubAppRecord,
  markGitHubAppInvalid,
  persistGitHubAppConfiguration,
  persistPendingGitHubAppConfiguration,
  recoverLegacyGitHubAppConfiguration,
  validateGitHubAppConfiguration,
  type GitHubAppConfiguration,
  type GitHubAppInstallationSummary,
  type GitHubAppPendingConfiguration,
  type GitHubAppRecord,
} from "../lib/github-app-config";

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

type ManifestSetupState = Readonly<{
  expiresAt: number;
  tokenId: string;
  userId: string;
}>;

type ManifestInstallState = ManifestSetupState & Readonly<{ pendingId: string }>;

type GitHubAppConfig = Readonly<GitHubAppConfiguration & { installUrl: string }>;

type VerifiedInstallation = Readonly<{
  iconUrl: string | null;
  installationType: "Organization" | "User";
  installationUrl: string | null;
  name: string;
}>;

const SETUP_STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 10_000;
const setupStates = new Map<string, SetupState>();
const manifestSetupStates = new Map<string, ManifestSetupState>();
const manifestInstallStates = new Map<string, ManifestInstallState>();

function stringQuery(query: Readonly<Record<string, unknown>> | undefined, key: string): string {
  const value = query?.[key];
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: unknown): number | null {
  const text = typeof value === "string"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : "";
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function githubAppConfig(): Promise<GitHubAppConfig | null> {
  const configuration = await getGitHubAppConfiguration();
  if (configuration === null) return null;
  const installUrl = new URL(`/apps/${encodeURIComponent(configuration.slug)}/installations/new`, configuration.httpUrl);
  return { ...configuration, installUrl: installUrl.toString() };
}

function manifestGitHubHttpUrl(): string {
  try {
    const configured = new URL(integrationSetting("GITHUB_APP_HTTP_URL") ?? "https://github.com");
    if ((configured.protocol !== "https:" && configured.protocol !== "http:") || configured.username !== "" || configured.password !== "" || configured.search !== "" || configured.hash !== "") return "https://github.com";
    return configured.toString().replace(/\/$/u, "");
  } catch {
    return "https://github.com";
  }
}

function manifestGitHubApiUrl(): string {
  return githubAppApiBase(true) ?? "https://api.github.com";
}

function manifestPayload(request: Readonly<{ url: string }>): Readonly<Record<string, unknown>> {
  const publicUrl = new URL(requestBaseUrl(request));
  publicUrl.pathname = "/";
  publicUrl.search = "";
  publicUrl.hash = "";
  return {
    name: `terrence-${publicUrl.hostname}`.slice(0, 34),
    url: publicUrl.toString(),
    description: "Terrence VCS integration",
    public: false,
    redirect_url: apiURL(request, "/api/v2/admin/github-app/manifest/callback"),
    setup_url: apiURL(request, "/api/v2/admin/github-app/manifest/install-callback"),
    hook_attributes: {
      url: apiURL(request, "/api/webhooks/github"),
      active: true,
    },
    default_permissions: {
      contents: "read",
      metadata: "read",
      pull_requests: "read",
      repository_hooks: "read",
      statuses: "write",
    },
    default_events: ["push", "pull_request", "repository", "installation", "installation_repositories"],
  };
}

async function manifestConversion(code: string): Promise<Readonly<{ configuration: GitHubAppConfiguration; htmlUrl: string | null }> | null> {
  const apiUrl = manifestGitHubApiUrl();
  const controller = new AbortController();
  const timer = setTimeout((): void => { controller.abort(); }, GITHUB_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiUrl.replace(/\/$/u, "")}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "Terrence",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch((): unknown => ({}));
    if (!response.ok) return null;
    const record = recordValue(body);
    if (record === null) return null;
    const pem = stringValue(record["pem"]);
    const webhookSecret = stringValue(record["webhook_secret"]);
    const clientId = stringValue(record["client_id"]);
    const clientSecret = stringValue(record["client_secret"]);
    const appId = positiveInteger(record["id"]);
    const slug = stringValue(record["slug"]);
    if (pem === null || webhookSecret === null || clientId === null || clientSecret === null || appId === null || slug === null) return null;
    const configuration: GitHubAppConfiguration = {
      appId,
      appIdText: String(appId),
      slug,
      name: stringValue(record["name"]),
      owner: null,
      privateKey: pem,
      webhookSecret,
      clientId,
      clientSecret,
      apiUrl,
      httpUrl: manifestGitHubHttpUrl(),
      source: "manifest",
    };
    const validation = await validateGitHubAppConfiguration(configuration);
    if (!validation.ok) return null;
    return {
      configuration: {
        ...configuration,
        appId: validation.appId ?? configuration.appId,
        appIdText: String(validation.appId ?? configuration.appId),
        slug: validation.slug ?? configuration.slug,
        name: validation.name ?? configuration.name,
        owner: validation.owner ?? configuration.owner,
      },
      htmlUrl: httpUrl(record["html_url"]),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function siteAdminManifestStateAuthorized(state: ManifestSetupState): Promise<boolean> {
  const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, state.tokenId) });
  if (token === undefined || token.userId !== state.userId) return false;
  const user = await db.query.users.findFirst({ where: eq(users.id, state.userId), columns: { isSiteAdmin: true } });
  return user?.isSiteAdmin === true;
}

function jsonApiAttributes(body: unknown, type: string): Record<string, unknown> | null {
  const root = recordValue(body);
  const data = recordValue(root?.["data"]);
  if (data === null || data["type"] !== type) return null;
  return recordValue(data["attributes"]);
}

function manualGitHubAppConfiguration(body: unknown): GitHubAppConfiguration | null {
  const attributes = jsonApiAttributes(body, "github-app");
  if (attributes === null) return null;
  const appId = positiveInteger(attributes["app-id"]);
  const slug = stringValue(attributes["slug"]);
  const privateKeyValue = stringValue(attributes["private-key"]);
  const privateKey = privateKeyValue === null ? null : privateKeyValue.replaceAll("\\n", "\n");
  const webhookSecret = stringValue(attributes["webhook-secret"]);
  if (appId === null || slug === null || privateKey === null || webhookSecret === null) return null;
  const apiUrl = safeGithubUrl(attributes["api-url"], manifestGitHubApiUrl());
  const httpUrl = safeGithubUrl(attributes["http-url"], manifestGitHubHttpUrl());
  if (apiUrl === null || httpUrl === null || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(slug)) return null;
  return {
    appId,
    appIdText: String(appId),
    slug,
    name: stringValue(attributes["name"]),
    owner: null,
    privateKey,
    webhookSecret,
    clientId: stringValue(attributes["client-id"]),
    clientSecret: stringValue(attributes["client-secret"]),
    apiUrl,
    httpUrl,
    source: "manual",
  };
}

function safeGithubUrl(value: unknown, fallback: string): string | null {
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

async function validatePendingInstallation(config: GitHubAppConfig, installationId: number): Promise<boolean> {
  let appToken: string;
  try {
    appToken = jwt.sign({
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + (9 * 60),
      iss: config.appIdText,
    }, config.privateKey, { algorithm: "RS256" });
  } catch {
    return false;
  }
  try {
    const response = await fetchVcsUrl(`${config.apiUrl.replace(/\/$/u, "")}/app/installations/${String(installationId)}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appToken}`,
        "User-Agent": "Terrence",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeoutMs: GITHUB_TIMEOUT_MS,
    });
    if (!response.ok) return false;
    const tokenBody = recordValue(await response.json());
    const token = stringValue(tokenBody?.["token"]);
    if (token === null) return false;
    const permissions = recordValue(tokenBody?.["permissions"]);
    if (permissions !== null) {
      const requiredPermissions: Readonly<Record<string, string>> = {
        contents: "read",
        pull_requests: "read",
        statuses: "write",
      };
      if (Object.entries(requiredPermissions).some(([name, required]): boolean => permissions[name] !== required)) return false;
    }
    const repositories = await fetchVcsUrl(`${config.apiUrl.replace(/\/$/u, "")}/installation/repositories?per_page=1`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Terrence",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeoutMs: GITHUB_TIMEOUT_MS,
    });
    if (!repositories.ok) return false;
    const repositoryBody = recordValue(await repositories.json());
    return Array.isArray(repositoryBody?.["repositories"]);
  } catch {
    return false;
  }
}

async function uninstallGitHubInstallation(configuration: GitHubAppConfiguration, installationId: number): Promise<Readonly<{ ok: boolean; status: number | null; detail: string }>> {
  let appToken: string;
  try {
    appToken = jwt.sign({
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + (9 * 60),
      iss: configuration.appIdText,
    }, configuration.privateKey, { algorithm: "RS256" });
  } catch {
    return { ok: false, status: null, detail: "The configured GitHub App private key is invalid" };
  }
  try {
    const response = await fetchVcsUrl(`${configuration.apiUrl.replace(/\/$/u, "")}/app/installations/${String(installationId)}`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appToken}`,
        "User-Agent": "Terrence",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeoutMs: GITHUB_TIMEOUT_MS,
    });
    if (response.status === 204 || response.status === 404) return { ok: true, status: response.status, detail: "GitHub installation is uninstalled" };
    return { ok: false, status: response.status, detail: `GitHub refused to uninstall the installation (HTTP ${response.status})` };
  } catch {
    return { ok: false, status: null, detail: "GitHub installation uninstall could not reach GitHub" };
  }
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
  for (const [id, state] of manifestSetupStates) {
    if (state.expiresAt <= now) manifestSetupStates.delete(id);
  }
  for (const [id, state] of manifestInstallStates) {
    if (state.expiresAt <= now) manifestInstallStates.delete(id);
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
      url.protocol !== "https:"
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

function explicitApiUrlTarget(
  client: Readonly<typeof oauthClients.$inferSelect>,
): Readonly<{ base: URL }> | null | undefined {
  const configuredApiUrl = client.apiUrl?.trim() ?? "";
  if (configuredApiUrl === "") return undefined;
  const base = validRepositoryApiUrl(configuredApiUrl);
  return base === null ? null : { base };
}

function httpUrlApiTarget(
  client: Readonly<typeof oauthClients.$inferSelect>,
  provider: RepositoryProvider,
): Readonly<{ base: URL }> | null | undefined {
  const configuredHttpUrl = client.httpUrl?.trim() ?? "";
  if (configuredHttpUrl === "") return undefined;
  const httpUrl = validRepositoryApiUrl(configuredHttpUrl);
  if (httpUrl === null) return null;
  return {
    base: appendApiPath(
      httpUrl,
      provider === "github" ? "/api/v3" : provider === "gitlab" ? "/api/v4" : "/2.0",
    ),
  };
}

function defaultApiUrlTarget(
  client: Readonly<typeof oauthClients.$inferSelect>,
  provider: RepositoryProvider,
): Readonly<{ base: URL }> | null {
  const defaultApiUrl = provider === "github"
    ? client.serviceProvider === "github" ? "https://api.github.com" : null
    : provider === "gitlab"
      ? client.serviceProvider === "gitlab" ? "https://gitlab.com/api/v4" : null
      : "https://api.bitbucket.org/2.0";
  if (defaultApiUrl === null) return null;
  const base = validRepositoryApiUrl(defaultApiUrl);
  return base === null ? null : { base };
}

function repositoryApiTarget(client: Readonly<typeof oauthClients.$inferSelect>): { base: URL; provider: RepositoryProvider } | null {
  const provider = repositoryProvider(client.serviceProvider);
  if (provider === null) return null;
  const explicit = explicitApiUrlTarget(client);
  if (explicit !== undefined) return explicit === null ? null : { ...explicit, provider };
  const derived = httpUrlApiTarget(client, provider);
  if (derived !== undefined) return derived === null ? null : { ...derived, provider };
  const fallback = defaultApiUrlTarget(client, provider);
  return fallback === null ? null : { ...fallback, provider };
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

function gitlabFullName(record: RepositoryRecord): string | null {
  const direct = stringValue(record["path_with_namespace"]);
  if (direct !== null) return direct;
  const namespace = recordValue(record["namespace"]);
  const namespacePath = stringValue(namespace?.["full_path"]);
  const path = stringValue(record["path"]);
  if (namespacePath === null || path === null) return null;
  return `${namespacePath}/${path}`;
}

function repositoryOwner(record: RepositoryRecord, provider: RepositoryProvider): string | null {
  const ownerRecord = recordValue(record["owner"]);
  if (provider === "github") return stringValue(ownerRecord?.["login"]);
  if (provider === "bitbucket") {
    return stringValue(ownerRecord?.["display_name"]) ?? stringValue(ownerRecord?.["nickname"]) ?? stringValue(ownerRecord?.["username"]);
  }
  return null;
}

function normalizedRepository(record: RepositoryRecord, provider: RepositoryProvider): RepositoryResource | null {
  const fullName = provider === "gitlab" ? gitlabFullName(record) : stringValue(record["full_name"]);
  if (fullName === null) return null;
  const name = stringValue(record["name"]) ?? fullName.split("/").at(-1) ?? fullName;
  const owner = repositoryOwner(record, provider);
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
  if (url.protocol !== "https:") return null;
  try {
    const response = await fetchVcsUrl(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeoutMs: GITHUB_TIMEOUT_MS,
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

async function collectBitbucketWorkspaces(
  base: URL,
  token: string,
  budget: { remaining: number },
  serviceProviderUser: string | null,
): Promise<Set<string>> {
  const workspaceSlugs = new Set<string>();
  let workspaceUrl = repositoryEndpoint(base, "user/workspaces", { pagelen: String(REPOSITORY_PAGE_SIZE) });
  const seenWorkspaceUrls = new Set<string>();
  for (let requestCount = 0; requestCount < MAX_REPOSITORY_PAGES; requestCount += 1) {
    if (budget.remaining === 0) break;
    const urlKey = workspaceUrl.toString();
    if (seenWorkspaceUrls.has(urlKey)) break;
    seenWorkspaceUrls.add(urlKey);
    budget.remaining -= 1;
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
  return workspaceSlugs;
}

async function collectBitbucketWorkspaceRepositories(
  base: URL,
  token: string,
  budget: { remaining: number },
  workspace: string,
  repositories: Map<string, RepositoryResource>,
): Promise<void> {
  let url = repositoryEndpoint(base, `repositories/${encodeURIComponent(workspace)}`, {
    pagelen: String(REPOSITORY_PAGE_SIZE),
    sort: "-updated_on",
  });
  const seenUrls = new Set<string>();
  for (let requestCount = 0; requestCount < MAX_REPOSITORY_PAGES; requestCount += 1) {
    if (budget.remaining === 0) break;
    const urlKey = url.toString();
    if (seenUrls.has(urlKey)) break;
    seenUrls.add(urlKey);
    budget.remaining -= 1;
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

async function discoverBitbucketRepositories(
  base: URL,
  token: string,
  serviceProviderUser: string | null,
): Promise<RepositoryResource[]> {
  const requestBudget = { remaining: MAX_BITBUCKET_REQUESTS };
  const workspaceSlugs = await collectBitbucketWorkspaces(base, token, requestBudget, serviceProviderUser);
  const repositories = new Map<string, RepositoryResource>();
  for (const workspace of workspaceSlugs) {
    if (requestBudget.remaining === 0) break;
    await collectBitbucketWorkspaceRepositories(base, token, requestBudget, workspace, repositories);
  }
  return [...repositories.values()];
}

function nextRepositoryPageUrl(
  provider: RepositoryProvider,
  base: URL,
  page: number,
  headers: Headers,
  rawCount: number,
): Readonly<{ url: URL; page: number }> | null {
  if (provider === "github") {
    const next = safeNextRepositoryUrl(nextLink(headers), base);
    if (next !== null) return { url: next, page };
  } else {
    const nextPageText = headers.get("x-next-page")?.trim() ?? "";
    const nextPage = /^[1-9]\d*$/.test(nextPageText) ? Number(nextPageText) : null;
    if (nextPage !== null && Number.isSafeInteger(nextPage)) {
      return { url: repositoryPageUrl(base, provider, nextPage), page: nextPage };
    }
  }
  if (rawCount < REPOSITORY_PAGE_SIZE) return null;
  const followingPage = page + 1;
  return { url: repositoryPageUrl(base, provider, followingPage), page: followingPage };
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
    const next = nextRepositoryPageUrl(target.provider, target.base, page, response.headers, parsed.rawCount);
    if (next === null) break;
    page = next.page;
    url = next.url;
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
    const response = await fetchVcsUrl(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeoutMs: GITHUB_TIMEOUT_MS,
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

type GitHubAppHealth = Awaited<ReturnType<typeof validateGitHubAppConfiguration>>;

async function checkGitHubAppHealth(
  configuration: GitHubAppConfiguration | null,
  record: GitHubAppRecord | null,
): Promise<GitHubAppHealth | null> {
  if (configuration === null) return null;
  const health = await validateGitHubAppConfiguration(configuration);
  if (record !== null && record.status === "active" && !health.ok && health.credentialError) {
    await markGitHubAppInvalid(health.detail);
  }
  return health;
}

function resolveGitHubAppUrls(
  safeConfiguration: GitHubAppConfiguration | null,
): Readonly<{ registrationUrl: string; installUrl: string | null }> {
  if (safeConfiguration === null) {
    return { registrationUrl: `${manifestGitHubHttpUrl()}/settings/apps`, installUrl: null };
  }
  return {
    registrationUrl: `${safeConfiguration.httpUrl}/settings/apps/${encodeURIComponent(safeConfiguration.slug)}`,
    installUrl: new URL(`/apps/${encodeURIComponent(safeConfiguration.slug)}/installations/new`, safeConfiguration.httpUrl).toString(),
  };
}

function resolveGitHubAppStatus(
  effectiveStatus: GitHubAppRecord["status"] | undefined,
  health: GitHubAppHealth | null,
  hasConfiguration: boolean,
): string {
  if (effectiveStatus === "invalid" || (health !== null && !health.ok && health.credentialError)) return "invalid";
  return effectiveStatus ?? (hasConfiguration ? "active" : "unconfigured");
}

function resolvePendingOwners(
  pending: GitHubAppPendingConfiguration | null | undefined,
): Readonly<{ installed: string[]; required: string[]; missing: string[]; hasPending: boolean }> {
  if (pending === null || pending === undefined) return { installed: [], required: [], missing: [], hasPending: false };
  const installedOwners = new Set(pending.installations.map((installation): string => installation.owner));
  const required = [...pending.requiredOwners];
  return {
    installed: [...installedOwners].sort(),
    required,
    missing: required.filter((owner): boolean => !installedOwners.has(owner)),
    hasPending: true,
  };
}

function resolveSafeConfiguration(
  configuration: GitHubAppConfiguration | null,
  effectiveRecord: GitHubAppRecord | null,
): GitHubAppConfiguration | null {
  return configuration ?? effectiveRecord?.configuration ?? null;
}

function resolveGitHubAppSource(
  effectiveRecord: GitHubAppRecord | null,
  safeConfiguration: GitHubAppConfiguration | null,
): string | null {
  return effectiveRecord?.source ?? (safeConfiguration?.source === "legacy_environment_import" ? "environment" : null);
}

function resolveGitHubAppInvalidReason(
  health: GitHubAppHealth | null,
  effectiveRecord: GitHubAppRecord | null,
): string | null {
  if (health !== null && !health.ok) return health.detail;
  return effectiveRecord?.invalidReason ?? null;
}

function buildGitHubAppIdentity(safeConfiguration: GitHubAppConfiguration | null): Record<string, unknown> {
  return {
    "app-id": safeConfiguration?.appId ?? null,
    slug: safeConfiguration?.slug ?? null,
    name: safeConfiguration?.name ?? null,
    owner: safeConfiguration?.owner ?? null,
  };
}

function buildGitHubAppAttributes(
  effectiveRecord: GitHubAppRecord | null,
  configuration: GitHubAppConfiguration | null,
  health: GitHubAppHealth | null,
  request: ParamCtx["request"],
): Record<string, unknown> {
  const owners = resolvePendingOwners(effectiveRecord?.pending);
  const safeConfiguration = resolveSafeConfiguration(configuration, effectiveRecord);
  const urls = resolveGitHubAppUrls(safeConfiguration);
  return {
    configured: safeConfiguration !== null,
    status: resolveGitHubAppStatus(effectiveRecord?.status, health, safeConfiguration !== null),
    source: resolveGitHubAppSource(effectiveRecord, safeConfiguration),
    bootstrapConsumed: effectiveRecord?.bootstrapConsumed === true,
    ...buildGitHubAppIdentity(safeConfiguration),
    "registration-url": urls.registrationUrl,
    "install-url": urls.installUrl,
    "invalid-reason": resolveGitHubAppInvalidReason(health, effectiveRecord),
    "pending-replacement": owners.hasPending,
    "required-owners": owners.required,
    "installed-owners": owners.installed,
    "missing-owners": owners.missing,
    modes: ["manifest", "manual", "environment"],
    "manifest-flow": request === undefined ? null : apiURL(request, "/api/v2/admin/github-app/manifest/setup"),
  };
}

type DiagnosticCheck = Readonly<{
  id: string;
  label: string;
  ok: boolean;
  status: number | null;
  detail: string;
}>;

type RepositoryProbe = Readonly<
  { repo: Readonly<{ full_name: string }>; scopeCheck: null }
  | { repo: undefined; scopeCheck: DiagnosticCheck }
>;

async function probeInstallationRepositories(
  githubApiBase: string,
  repoHeaders: Readonly<Record<string, string>>,
): Promise<RepositoryProbe> {
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
    const statusRes = await fetchVcsUrl(repositoryUrl.toString(), {
      headers: repoHeaders,
      timeoutMs: GITHUB_TIMEOUT_MS,
    });
    if (!statusRes.ok) {
      return {
        repo: undefined,
        scopeCheck: { id: "installation-access", label: "Installation repo access", ok: false, status: statusRes.status, detail: `Installation could not list repositories (HTTP ${statusRes.status}). Re-install the app and grant repository access.` },
      };
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
    return {
      repo: undefined,
      scopeCheck: {
        id: "repo-scope",
        label: "Repository access scope",
        ok: false,
        status: null,
        detail: sawRepository
          ? "The installation only exposes archived repositories, which cannot accept commit statuses. Select at least one active repository for the installation."
          : "The installation has access to no repositories. Select at least one repository (including the ones this workspace points at).",
      },
    };
  }
  return { repo, scopeCheck: null };
}

async function checkCommitStatusesPermission(
  permissions: GitHubAppAccessTokenDetails["permissions"],
  githubApiBase: string,
  repoHeaders: Readonly<Record<string, string>>,
  repoFullName: string,
): Promise<DiagnosticCheck> {
  if (permissions !== null) {
    const statusesPermission = permissions["statuses"];
    if (statusesPermission === "write") {
      return { id: "commit-statuses", label: "Commit statuses (write)", ok: true, status: null, detail: `The installation access token grants Commit statuses write on active repository ${repoFullName}.` };
    }
    return { id: "commit-statuses", label: "Commit statuses (write)", ok: false, status: null, detail: `The installation access token reports Commit statuses permission as ${statusesPermission === undefined ? "not granted" : JSON.stringify(statusesPermission)} on ${repoFullName}. In the GitHub App settings for this installation, grant the 'Commit statuses' permission at 'Read and write', then save.` };
  }
  // Some GitHub-compatible APIs omit permissions from the access-token
  // response. Keep the synthetic write probe for those deployments.
  const testSha = "a".repeat(40);
  const writeRes = await fetchVcsUrl(`${githubApiBase}/repos/${encodeURIComponent(repoFullName)}/statuses/${testSha}`, {
    method: "POST",
    headers: repoHeaders,
    body: JSON.stringify({ state: "pending", context: "terrence/diagnostics", description: "Terrence permission check" }),
    timeoutMs: GITHUB_TIMEOUT_MS,
  });
  // GitHub-compatible APIs commonly return 422 for a synthetic
  // (non-existent) SHA when the token has the commit-statuses permission.
  // A 200 also proves the permission. 403/404 remain failure signals when
  // the API did not provide explicit permission metadata above.
  if (writeRes.ok || writeRes.status === 422) {
    return { id: "commit-statuses", label: "Commit statuses (write)", ok: true, status: writeRes.status, detail: `Commit statuses write path is authorized on active repository ${repoFullName}.` };
  }
  if (writeRes.status === 404) {
    return { id: "commit-statuses", label: "Commit statuses (write)", ok: false, status: 404, detail: `Commit statuses write returned 404 on ${repoFullName}. In the GitHub App settings for this installation, grant the 'Commit statuses' permission at 'Read and write', then save.` };
  }
  if (writeRes.status === 403) {
    return { id: "commit-statuses", label: "Commit statuses (write)", ok: false, status: 403, detail: `Commit statuses write returned 403 on ${repoFullName}. In the GitHub App settings for this installation, grant the 'Commit statuses' permission at 'Read and write', then save.` };
  }
  return { id: "commit-statuses", label: "Commit statuses (write)", ok: false, status: writeRes.status, detail: `Commit statuses write returned HTTP ${writeRes.status}. Check the GitHub App's permission settings.` };
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
      const apiBase = (await githubAppConfig())?.apiUrl;
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
      id: newResourceId("ghain"),
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
  .post("/api/v2/organizations/:org_name/github-app/installations/:installation_id/actions/uninstall", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.id, params["installation_id"] ?? ""), eq(githubAppInstallations.orgId, org.id)),
    });
    if (installation === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const configuration = await getGitHubAppConfiguration();
    if (configuration === null) return flowError(set, 409, "GitHub App Not Configured", "Disconnecting the App credentials prevents remote uninstall; reconnect the App first");
    const outcome = await db.transaction(async (tx): Promise<Readonly<{ conflict: VcsIntegrationUsage | null; uninstall: Readonly<{ ok: boolean; status: number | null; detail: string }> }>> => {
      if (isPostgres) {
        await (tx as unknown as { execute: (query: unknown) => Promise<unknown> })
          .execute(sql`SELECT id FROM github_app_installations WHERE id = ${installation.id} FOR UPDATE`);
      }
      const usage = await findVcsIntegrationUsage(org.id, { kind: "github-app", id: installation.id }, tx);
      if (usage.workspaces.length > 0 || usage.policySets.length > 0) return { conflict: usage, uninstall: { ok: false, status: null, detail: "" } };
      const uninstall = await uninstallGitHubInstallation(configuration, installation.installationId);
      if (uninstall.ok) await tx.delete(githubAppInstallations).where(eq(githubAppInstallations.id, installation.id));
      return { conflict: null, uninstall };
    });
    if (outcome.conflict !== null) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: vcsIntegrationUsageDetail(outcome.conflict) }] };
    }
    if (!outcome.uninstall.ok) return flowError(set, outcome.uninstall.status ?? 502, "GitHub Installation Uninstall Failed", outcome.uninstall.detail);
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/admin/github-app", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const record = await getGitHubAppRecord();
    const configuration = await getGitHubAppConfiguration();
    const health = await checkGitHubAppHealth(configuration, record);
    const effectiveRecord = await getGitHubAppRecord();
    return {
      data: {
        id: "github-app",
        type: "github-app",
        attributes: buildGitHubAppAttributes(effectiveRecord, configuration, health, request),
      },
    };
  })
  .post("/api/v2/admin/github-app", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const configuration = manualGitHubAppConfiguration(body);
    if (configuration === null) {
      return flowError(set, 422, "Invalid GitHub App", "app-id, slug, private-key, webhook-secret, and valid HTTP(S) URLs are required");
    }
    const validation = await validateGitHubAppConfiguration(configuration);
    if (!validation.ok) {
      return flowError(set, 422, "GitHub App Validation Failed", validation.detail);
    }
    await persistGitHubAppConfiguration({
      ...configuration,
      appId: validation.appId ?? configuration.appId,
      appIdText: String(validation.appId ?? configuration.appId),
      slug: validation.slug ?? configuration.slug,
      name: validation.name ?? configuration.name,
      owner: validation.owner ?? configuration.owner,
      source: "manual",
    });
    const record = await getGitHubAppRecord();
    return { data: { id: "github-app", type: "github-app", attributes: { status: "active", source: "manual", "app-id": record?.configuration?.appId ?? configuration.appId, slug: record?.configuration?.slug ?? configuration.slug } } };
  })
  .post("/api/v2/admin/github-app/actions/disconnect", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await disconnectGitHubApp();
    return { data: { id: "github-app", type: "github-app", attributes: { status: "disconnected", bootstrapConsumed: true } } };
  })
  .post("/api/v2/admin/github-app/actions/import-environment", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const result = await recoverLegacyGitHubAppConfiguration();
    if (!result.imported) return flowError(set, 422, "GitHub App Import Failed", result.reason === "legacy-environment-incomplete" ? "A complete legacy GitHub App environment configuration is required" : result.reason ?? "GitHub App validation failed");
    return { data: { id: "github-app", type: "github-app", attributes: { status: "active", source: "legacy_environment_import", bootstrapConsumed: true } } };
  })
  .post("/api/v2/admin/github-app/actions/validate", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const configuration = await getGitHubAppConfiguration();
    if (configuration === null) return flowError(set, 409, "GitHub App Not Configured", "Configure a GitHub App before validating it");
    const validation = await validateGitHubAppConfiguration(configuration);
    if (!validation.ok) {
      if (validation.credentialError) await markGitHubAppInvalid(validation.detail);
      return flowError(set, validation.credentialError ? 422 : 503, "GitHub App Validation Failed", validation.detail);
    }
    return { data: { id: "github-app", type: "github-app", attributes: { status: "active", appId: validation.appId ?? configuration.appId, slug: validation.slug ?? configuration.slug } } };
  })
  .get("/api/v2/admin/github-app/manifest/setup", async ({ request, user, token, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true || token === null || token === undefined || request === undefined) {
      return flowError(set, 404, "Not Found", "Site administrator access is required");
    }
    pruneSetupStates();
    const stateId = crypto.randomUUID();
    manifestSetupStates.set(stateId, {
      expiresAt: Date.now() + SETUP_STATE_TTL_MS,
      tokenId: token.id,
      userId: user.id,
    });
    const destination = new URL("/settings/apps/new", manifestGitHubHttpUrl());
    destination.searchParams.set("state", stateId);
    destination.searchParams.set("manifest", JSON.stringify(manifestPayload(request)));
    return authorizationResponse(request, stateId, destination.toString());
  })
  .get("/api/v2/admin/github-app/manifest/callback", async ({ query, set }: ParamCtx): Promise<unknown> => {
    pruneSetupStates();
    const stateId = stringQuery(query, "state");
    const state = manifestSetupStates.get(stateId);
    if (state === undefined) return flowError(set, 400, "Invalid GitHub App Manifest Callback", "Setup state is missing, expired, or invalid");
    manifestSetupStates.delete(stateId);
    if (!(await siteAdminManifestStateAuthorized(state))) return flowError(set, 403, "Forbidden", "Site administrator authorization is no longer valid");
    const code = stringQuery(query, "code");
    if (code === "") return flowError(set, 400, "Invalid GitHub App Manifest Callback", "GitHub did not return an app manifest code");
    const converted = await manifestConversion(code);
    if (converted === null) return flowError(set, 502, "GitHub App Provisioning Failed", "GitHub did not return a valid App manifest conversion");
    const existingInstallations = await db.query.githubAppInstallations.findMany({ columns: { name: true } });
    const requiredOwners = [...new Set(existingInstallations.map((installation): string => installation.name).filter((name): boolean => name.trim() !== ""))];
    const pendingId = crypto.randomUUID();
    await persistPendingGitHubAppConfiguration(converted.configuration, requiredOwners, [], pendingId);
    const installStateId = crypto.randomUUID();
    manifestInstallStates.set(installStateId, { ...state, pendingId });
    const destination = new URL(`/apps/${encodeURIComponent(converted.configuration.slug)}/installations/new`, converted.configuration.httpUrl);
    destination.searchParams.set("state", installStateId);
    return redirect(destination.toString(), 302);
  })
  .get("/api/v2/admin/github-app/manifest/install-callback", async ({ query, request, set }: ParamCtx): Promise<unknown> => {
    pruneSetupStates();
    const stateId = stringQuery(query, "state");
    const state = manifestInstallStates.get(stateId);
    if (state === undefined) return flowError(set, 400, "Invalid GitHub App Installation Callback", "Installation state is missing, expired, or invalid");
    manifestInstallStates.delete(stateId);
    if (!(await siteAdminManifestStateAuthorized(state))) return flowError(set, 403, "Forbidden", "Site administrator authorization is no longer valid");
    const record = await getGitHubAppRecord();
    const pending = record?.pending;
    const installationId = positiveInteger(stringQuery(query, "installation_id"));
    const setupAction = stringQuery(query, "setup_action");
    if (pending === null || pending === undefined || pending.flowId !== state.pendingId || installationId === null || (setupAction !== "install" && setupAction !== "update")) {
      return flowError(set, 400, "Invalid GitHub App Installation Callback", "GitHub returned an invalid installation or no pending replacement exists");
    }
    const config: GitHubAppConfig = { ...pending.configuration, installUrl: new URL(`/apps/${encodeURIComponent(pending.configuration.slug)}/installations/new`, pending.configuration.httpUrl).toString() };
    const verified = await fetchInstallation(config, installationId);
    if (verified === null || !(await validatePendingInstallation(config, installationId))) {
      return flowError(set, 422, "GitHub App Validation Failed", "The replacement installation could not authenticate, enumerate repositories, or match the new App");
    }
    const installations: GitHubAppInstallationSummary[] = [
      ...pending.installations.filter((installation): boolean => installation.owner !== verified.name),
      { installationId, owner: verified.name, ownerType: verified.installationType },
    ];
    const missingOwners = pending.requiredOwners.filter((owner): boolean => !installations.some((installation): boolean => installation.owner === owner));
    if (missingOwners.length > 0) {
      await persistPendingGitHubAppConfiguration(pending.configuration, pending.requiredOwners, installations, pending.flowId);
      const nextStateId = crypto.randomUUID();
      manifestInstallStates.set(nextStateId, { ...state, pendingId: pending.flowId });
      const destination = new URL(config.installUrl);
      destination.searchParams.set("state", nextStateId);
      return redirect(destination.toString(), 302);
    }
    await activatePendingGitHubAppConfiguration();
    const installedByOwner = new Map(installations.map((installation): [string, GitHubAppInstallationSummary] => [installation.owner, installation]));
    const existingRows = await db.query.githubAppInstallations.findMany();
    for (const existing of existingRows) {
      const replacement = installedByOwner.get(existing.name);
      if (replacement === undefined) continue;
      await db.update(githubAppInstallations).set({ installationId: replacement.installationId }).where(eq(githubAppInstallations.id, existing.id));
    }
    const destination = request === undefined ? "/app/admin" : apiURL(request, "/app/admin");
    const redirectUrl = new URL(destination);
    redirectUrl.searchParams.set("github_app", "connected");
    return redirect(redirectUrl.toString(), 303);
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
    const config = await githubAppConfig();
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
    const config = await githubAppConfig();
    if (config === null) {
      return flowError(set, 422, "GitHub App Not Configured", "GitHub App configuration is unavailable");
    }
    const verified = await fetchInstallation(config, installationId);
    if (verified === null) {
      return flowError(set, 502, "GitHub App Verification Failed", "GitHub did not return a matching installation for this App");
    }

    const insertedId = newResourceId("ghain");
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
    const config = await githubAppConfig();
    const appId = config?.appId ?? null;
    const githubApiBase = config?.apiUrl ?? "https://api.github.com";
    const results = await Promise.all(installations.map(async (installation) => {
      const checks: DiagnosticCheck[] = [];
      const tokenDetails = await getGitHubAppAccessTokenDetails(installation.installationId);
      if (tokenDetails === null) {
        checks.push({ id: "app-token", label: "GitHub App token creation", ok: false, status: null, detail: "GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is missing or invalid — token generation failed." });
        return { installationId: installation.installationId, config: appId, checks };
      }
      const token = tokenDetails.token;
      const repoHeaders = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Terrence",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      const probe = await probeInstallationRepositories(githubApiBase, repoHeaders);
      if (probe.scopeCheck !== null) {
        checks.push(probe.scopeCheck);
        return { installationId: installation.installationId, config: appId, checks };
      }
      checks.push(await checkCommitStatusesPermission(tokenDetails.permissions, githubApiBase, repoHeaders, probe.repo.full_name));
      return { installationId: installation.installationId, config: appId, checks };
    }));
    return { data: results };
  });
