const DEFAULT_GITHUB_API_URL = "https://api.github.com";

function configuredGithubApiUrl(): string {
  const appUrl = process.env["GITHUB_APP_API_URL"]?.trim();
  if (appUrl !== undefined && appUrl !== "") return appUrl;
  const generalUrl = process.env["GITHUB_API_URL"]?.trim();
  return generalUrl === undefined || generalUrl === "" ? DEFAULT_GITHUB_API_URL : generalUrl;
}

export function normalizeGithubApiBase(raw: string, requireHttps = false): string | undefined {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || (requireHttps && url.protocol !== "https:")
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
    ) return undefined;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

/**
 * Resolve the GitHub App REST base once for every App call site.
 * GITHUB_APP_API_URL is the explicit Enterprise override; GITHUB_API_URL is
 * retained as the general fallback for existing deployments.
 */
export function githubAppApiBase(requireHttps = false): string | undefined {
  return normalizeGithubApiBase(configuredGithubApiUrl(), requireHttps);
}
