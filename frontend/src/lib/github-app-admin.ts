export type GitHubAppAttributes = Readonly<{
  configured?: boolean;
  status?: string;
  source?: string | null;
  "app-id"?: number | null;
  slug?: string | null;
  name?: string | null;
  owner?: string | null;
  "registration-url"?: string | null;
  "invalid-reason"?: string | null;
  "pending-replacement"?: boolean;
  "missing-owners"?: string[];
  "credential-storage"?: "database" | "environment" | "none";
  "environment-removable"?: boolean;
  "environment-import-available"?: boolean;
  "connection-verified"?: boolean;
}>;

export function githubAppSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "legacy_environment_import": return "Imported from environment";
    case "manifest": return "Created with GitHub";
    case "manual": return "Added manually";
    case "environment": return "Using environment variables";
    default: return "Source unavailable";
  }
}

export function githubAppStorageNotice(attributes: GitHubAppAttributes): Readonly<{
  title: string;
  description: string;
  canRemoveEnvironment: boolean;
}> {
  const stored = attributes["credential-storage"] === "database";
  const canRemoveEnvironment = stored && attributes.status === "active"
    && attributes["environment-removable"] === true;
  if (canRemoveEnvironment) return {
    title: "Credentials saved in Terrence",
    description: "The private key and webhook secret are encrypted in the database. The four GitHub credential variables below are no longer required, including after a restart.",
    canRemoveEnvironment,
  };
  if (attributes["credential-storage"] === "environment") return {
    title: "Still using environment variables",
    description: "These credentials have not been saved in the database. Keep the GitHub credential variables until an import succeeds.",
    canRemoveEnvironment,
  };
  if (stored) return {
    title: "Stored credentials need attention",
    description: "Terrence has a database record, but cannot confirm a complete, active credential set. Check or reconnect the app before removing deployment credentials.",
    canRemoveEnvironment,
  };
  return {
    title: attributes.status === "disconnected" ? "No active credentials stored" : "Credential storage not confirmed",
    description: "Connect an app or import the environment configuration. Do not remove deployment credentials until this page confirms they are saved.",
    canRemoveEnvironment,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Creation must use Terrence's CSP-scoped handoff, never navigate to GitHub's
 * GET registration page. Installation itself still uses GitHub's GET flow. */
export function githubAppAuthorizationUrl(
  payload: unknown,
  origin: string,
  flow: "manifest" | "installation",
): string {
  const attributes = record(record(record(payload)["data"])["attributes"]);
  const value = attributes["authorization-url"];
  if (typeof value !== "string" || value === "") throw new Error("The server did not return a GitHub App setup URL.");
  const url = new URL(value, origin);
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== "" || url.password !== "" || url.hash !== ""
    || url.searchParams.has("manifest") || !url.searchParams.get("state")) {
    throw new Error("The server returned an unsafe GitHub App setup URL.");
  }
  const valid = flow === "manifest"
    ? url.origin === new URL(origin).origin && url.pathname === "/api/v2/admin/github-app/manifest/redirect"
    : /^\/apps\/[^/]+\/installations\/new$/.test(url.pathname);
  if (!valid) throw new Error("The server returned an unexpected GitHub App setup URL.");
  return url.toString();
}
