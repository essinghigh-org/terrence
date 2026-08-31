import { ArrowUpRight } from "lucide-react";

import { githubRepositoryUrl, type GitHubRepositoryReference } from "@/lib/github-repository-url";

type WorkspaceRepositoryLinkProps = Readonly<{
  repo: GitHubRepositoryReference | null | undefined;
}>;

export function WorkspaceRepositoryLink({
  repo,
}: WorkspaceRepositoryLinkProps): React.JSX.Element {
  const identifier = typeof repo?.identifier === "string" ? repo.identifier.trim() : "";
  if (identifier === "") return <span className="text-muted-foreground">None</span>;

  const repositoryUrl = githubRepositoryUrl(repo);
  if (repositoryUrl === null) {
    return <span className="block max-w-64 truncate" title={identifier}>{identifier}</span>;
  }

  return (
    <a
      href={repositoryUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-w-0 max-w-full items-center gap-1 text-primary hover:underline"
      aria-label={`Open GitHub repository ${identifier}`}
    >
      <span className="truncate">{identifier}</span>
      <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
  );
}
