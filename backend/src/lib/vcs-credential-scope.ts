/**
 * Bind Git HTTP credentials to the configured VCS origin.
 *
 * Git's global http.extraHeader applies to every HTTP(S) remote contacted by a
 * clone. Stack repository-http-url is caller-controlled, so credentials must
 * instead use Git's URL-scoped http.<url>.extraHeader form.
 */

function configured(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function hostedHttpUrl(serviceProvider: string): string | null {
  if (serviceProvider === "github") return "https://github.com";
  if (serviceProvider === "gitlab" || serviceProvider === "gitlab_hosted") return "https://gitlab.com";
  return null;
}

export function vcsCredentialOrigin(
  serviceProvider: string,
  apiUrl: string | null | undefined,
  httpUrl: string | null | undefined,
): string | null {
  const candidate = configured(httpUrl) ?? hostedHttpUrl(serviceProvider) ?? configured(apiUrl);
  if (candidate === null) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.hostname === "") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Git config key whose extra header is sent only to the trusted VCS origin. */
export function gitExtraHeaderConfigKey(
  serviceProvider: string,
  apiUrl: string | null | undefined,
  httpUrl: string | null | undefined,
): string | null {
  const origin = vcsCredentialOrigin(serviceProvider, apiUrl, httpUrl);
  return origin === null ? null : `http.${origin}/.extraHeader`;
}
