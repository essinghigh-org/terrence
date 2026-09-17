type CredentialRecord = Readonly<{
  status: string;
  configuration: Readonly<{ privateKey: string; webhookSecret: string | null }> | null;
}>;

/** Storage state is independent of provenance: an environment import is a DB
 * credential, while a successful environment-backed health check is not. */
export function githubAppCredentialStorage(
  record: CredentialRecord | null,
  hasEnvironmentConfiguration: boolean,
): Readonly<{
  "credential-storage": "database" | "environment" | "none";
  "environment-removable": boolean;
}> {
  const configuration = record?.configuration ?? null;
  return {
    "credential-storage":
      record === null
        ? hasEnvironmentConfiguration
          ? "environment"
          : "none"
        : configuration === null
          ? "none"
          : "database",
    "environment-removable":
      record?.status === "active" &&
      configuration !== null &&
      configuration.privateKey.trim() !== "" &&
      configuration.webhookSecret !== null &&
      configuration.webhookSecret.trim() !== "",
  };
}

function githubHttpUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Invalid GitHub URL");
  }
  return url;
}

/** A private App belongs to the selected account. Do not silently register an
 * organization integration under the administrator's personal account. */
export function githubAppRegistrationUrl(httpUrl: string, organization: string): URL {
  const owner = organization.trim();
  if (owner !== "" && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error("Enter a GitHub organization login, not a URL.");
  }
  const base = githubHttpUrl(httpUrl);
  if (base.search !== "") throw new Error("Invalid GitHub URL");
  return new URL(
    owner === "" ? "/settings/apps/new" : `/organizations/${encodeURIComponent(owner)}/settings/apps/new`,
    base,
  );
}

export function githubAppSettingsUrl(
  httpUrl: string,
  slug: string,
  owner: string | null,
  ownerType: string | undefined,
): string {
  const path =
    ownerType === "Organization" && owner !== null
      ? `/organizations/${encodeURIComponent(owner)}/settings/apps/${encodeURIComponent(slug)}`
      : ownerType === "User"
        ? `/settings/apps/${encodeURIComponent(slug)}`
        : `/apps/${encodeURIComponent(slug)}`;
  return new URL(path, githubHttpUrl(httpUrl)).toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The SPA keeps form-action 'self'. Only this one-use handoff document may
 * submit a form to the configured GitHub origin. No credentials are included;
 * GitHub generates those after the administrator approves the registration. */
export function githubAppManifestDocument(
  action: string,
  manifest: Readonly<Record<string, unknown>>,
): Readonly<{ html: string; headers: Readonly<Record<string, string>> }> {
  const destination = githubHttpUrl(action);
  if (
    !/^\/(?:organizations\/[^/]+\/)?settings\/apps\/new$/.test(destination.pathname) ||
    destination.searchParams.has("manifest") ||
    !destination.searchParams.get("state")
  ) {
    throw new Error("Invalid GitHub App manifest destination");
  }
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      `form-action ${destination.origin}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; "),
  };
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continue to GitHub — Terrence</title></head>
<body>
<main>
<h1>Create your GitHub App</h1>
<p>Continue to GitHub to review the app name and create the preconfigured registration.</p>
<form id="github-app-manifest" method="post" action="${escapeHtml(destination.toString())}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<noscript><p>JavaScript is disabled. Use the button to continue.</p></noscript>
</main>
<script nonce="${nonce}">document.getElementById("github-app-manifest").requestSubmit();</script>
</body>
</html>`;
  return { html, headers };
}
