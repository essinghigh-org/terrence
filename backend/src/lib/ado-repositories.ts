import {
  azureDevOpsBaseUrl,
  fetchAzureDevOpsUrl,
  parseAzureDevOpsRepository,
  type AzureDevOpsCredentials,
} from "./azure-devops";

type RepositoryResource = Readonly<{
  id: string;
  type: "vcs-repositories";
  attributes: Readonly<{ identifier: string; name: string; owner: string }>;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function azureDevOpsRepositories(payload: unknown, organization: string): RepositoryResource[] {
  const values = record(payload)?.["value"];
  if (!Array.isArray(values) || values.length > 10000) throw new Error("Invalid Azure DevOps repository response");
  const repositories = new Map<string, RepositoryResource>();
  for (const value of values) {
    const repo = record(value);
    const project = record(repo?.["project"]);
    const name = repo?.["name"];
    const projectName = project?.["name"];
    if (typeof name !== "string" || typeof projectName !== "string" || repo?.["isDisabled"] === true) continue;
    const identifier = `${organization}/${projectName}/_git/${name}`;
    if (parseAzureDevOpsRepository(identifier, organization) === undefined) continue;
    repositories.set(identifier, {
      id: identifier,
      type: "vcs-repositories",
      attributes: { identifier, name, owner: `${organization}/${projectName}` },
    });
  }
  return [...repositories.values()];
}

/** Azure's organization-wide repository list is not paginated (REST API 7.1). */
export async function discoverAzureDevOpsRepositories(
  credentials: AzureDevOpsCredentials,
): Promise<RepositoryResource[]> {
  const base = azureDevOpsBaseUrl(credentials.organization, credentials.apiUrl);
  if (base === undefined) throw new Error("Invalid Azure DevOps organization URL");
  const response = await fetchAzureDevOpsUrl(credentials, `${base}/_apis/git/repositories?api-version=7.1`, {
    maxResponseBytes: 8 * 1024 * 1024,
  });
  if (!response.ok) throw new Error("Azure DevOps repository discovery failed");
  return azureDevOpsRepositories(await response.json(), credentials.organization.toLowerCase());
}
