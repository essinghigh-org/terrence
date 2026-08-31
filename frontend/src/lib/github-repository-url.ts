export type GitHubRepositoryReference = Readonly<{
  identifier?: string | null;
  "github-app-installation-id"?: string | null;
}>;

const GITHUB_REPOSITORY_PART = /^(?!\.{1,2}$)[A-Za-z0-9.][A-Za-z0-9_.-]*$/;

/**
 * Build a public GitHub repository URL only for a repository backed by a
 * registered GitHub App installation. OAuth-backed repositories do not carry
 * enough provider information in the workspace response to infer a host.
 */
export function githubRepositoryUrl(
  repo: GitHubRepositoryReference | null | undefined,
): string | null {
  if (
    typeof repo?.["github-app-installation-id"] !== "string"
    || repo["github-app-installation-id"] === ""
    || typeof repo.identifier !== "string"
  ) return null;

  const identifier = repo.identifier.trim();
  const parts = identifier.split("/");
  if (
    parts.length !== 2
    || parts.some((part): boolean => !GITHUB_REPOSITORY_PART.test(part))
  ) return null;

  return `https://github.com/${parts.map((part): string => encodeURIComponent(part)).join("/")}`;
}
