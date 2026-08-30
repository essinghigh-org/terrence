import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { githubAppInstallations, oauthClients, oauthTokens } from "../db/schema";

export type VcsProvider = "github" | "gitlab" | "bitbucket";

export type VcsSourceIdentity = Readonly<{
  provider: VcsProvider;
  host: string;
  installationId?: number;
}>;

function configuredValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

export function firstConfiguredValue(...values: readonly (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    const configured = configuredValue(value);
    if (configured !== undefined) return configured;
  }
  return undefined;
}

function canonicalHost(provider: VcsProvider, hostname: string, port: string): string {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
  const host = port === "" ? normalizedHostname : `${normalizedHostname}:${port}`;
  if (provider === "github" && host === "api.github.com") return "github.com";
  if (provider === "bitbucket" && (host === "api.bitbucket.org" || host === "bitbucket.org")) return "bitbucket.org";
  return host;
}

export function providerForServiceProvider(serviceProvider: string): VcsProvider | undefined {
  if (serviceProvider === "github" || serviceProvider === "github_enterprise") return "github";
  if (serviceProvider === "gitlab" || serviceProvider === "gitlab_ce" || serviceProvider === "gitlab_ee") return "gitlab";
  if (serviceProvider === "bitbucket") return "bitbucket";
  return undefined;
}

export function vcsSourceIdentity(
  provider: VcsProvider,
  sourceUrl: string | null | undefined,
  installationId?: number,
  requireHttps = false,
): VcsSourceIdentity | undefined {
  const configured = configuredValue(sourceUrl);
  if (configured === undefined) return undefined;
  try {
    const url = new URL(configured);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || (requireHttps && url.protocol !== "https:")
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
      || url.hostname === ""
    ) return undefined;
    return {
      provider,
      host: canonicalHost(provider, url.hostname, url.port),
      ...(installationId === undefined ? {} : { installationId }),
    };
  } catch {
    return undefined;
  }
}

export function configuredVcsSourceIdentity(
  provider: VcsProvider,
  serviceProvider: string,
  apiUrl: string | null | undefined,
  httpUrl: string | null | undefined,
  installationId?: number,
  requireHttps = false,
): VcsSourceIdentity | undefined {
  const configured = firstConfiguredValue(httpUrl, apiUrl) ?? (
    provider === "github"
      ? serviceProvider === "github" ? "https://api.github.com" : undefined
      : provider === "gitlab"
        ? serviceProvider === "gitlab" ? "https://gitlab.com/api/v4" : undefined
        : "https://bitbucket.org"
  );
  return vcsSourceIdentity(provider, configured, installationId, requireHttps);
}

/**
 * Compare a stored connection identity with an incoming webhook identity.
 * OAuth connections have no installation ID and therefore remain host-scoped;
 * GitHub App connections must have the matching delivery installation ID.
 */
export function vcsSourceMatchesConnection(
  configured: VcsSourceIdentity,
  incoming: VcsSourceIdentity,
): boolean {
  if (configured.provider !== incoming.provider || configured.host !== incoming.host) return false;
  return configured.installationId === undefined || configured.installationId === incoming.installationId;
}

export async function sourceIdentityForConnection(
  orgId: string,
  connectionType: string | null | undefined,
  connectionId: string | null | undefined,
): Promise<VcsSourceIdentity | undefined> {
  const id = configuredValue(connectionId);
  if (id === undefined) return undefined;

  if (connectionType === "github-app") {
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.id, id), eq(githubAppInstallations.orgId, orgId)),
      columns: { installationId: true },
    });
    if (installation === undefined) return undefined;
    return configuredVcsSourceIdentity(
      "github",
      "github",
      firstConfiguredValue(process.env.GITHUB_APP_API_URL, process.env.GITHUB_API_URL),
      null,
      installation.installationId,
      true,
    );
  }

  if (connectionType !== "oauth-token") return undefined;
  const token = await db.query.oauthTokens.findFirst({
    where: eq(oauthTokens.id, id),
    columns: { oauthClientId: true },
  });
  if (token === undefined) return undefined;
  const client = await db.query.oauthClients.findFirst({
    where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, orgId)),
    columns: { serviceProvider: true, apiUrl: true, httpUrl: true },
  });
  if (client === undefined) return undefined;
  const provider = providerForServiceProvider(client.serviceProvider);
  return provider === undefined
    ? undefined
    : configuredVcsSourceIdentity(provider, client.serviceProvider, client.apiUrl, client.httpUrl);
}
