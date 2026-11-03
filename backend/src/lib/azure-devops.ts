import { azureDevOpsZipToTarGz, type AzureDevOpsArchiveLimits } from "./ado-archive";
import { readBytesWithLimit, readTextWithLimit } from "./body-limit";
import { fetchResolvedExternalUrl, resolveExternalUrl, type ExternalRequestInit } from "./url-safety";

/** Azure DevOps Services endpoints are tenant-scoped even though all tenants share one origin. */
export type AzureDevOpsRepository = Readonly<{
  organization: string;
  project: string;
  repository: string;
}>;

export function azureDevOpsOrganization(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/.test(value))
    return undefined;
  return value.toLowerCase();
}

function safeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !/[\x00-\x1f\x7f/\\%?#]/u.test(value)
  );
}

/** Upstream TFE uses organization/project/_git/repository, not owner/repository. */
export function parseAzureDevOpsRepository(
  identifier: string,
  expectedOrganization?: string,
): AzureDevOpsRepository | undefined {
  const parts = identifier.split("/");
  if (parts.length !== 4 || parts[2] !== "_git") return undefined;
  const organization = azureDevOpsOrganization(parts[0]);
  const project = parts[1];
  const repository = parts[3];
  if (
    organization === undefined ||
    project === undefined ||
    repository === undefined ||
    !safeSegment(project) ||
    !safeSegment(repository)
  )
    return undefined;
  if (expectedOrganization !== undefined && azureDevOpsOrganization(expectedOrganization) !== organization)
    return undefined;
  return { organization, project, repository };
}

function azureDevOpsServiceSourceUrl(value: string): URL | undefined {
  if (value.trim() !== value || value.includes("\\")) return undefined;
  try {
    const url = new URL(value);
    return url.origin === "https://dev.azure.com" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

export function azureDevOpsSourceOrganization(sourceUrl: string): string | undefined {
  const url = azureDevOpsServiceSourceUrl(sourceUrl);
  return url === undefined ? undefined : azureDevOpsOrganization(url.pathname.split("/")[1]);
}

/** Only a root or the exact configured organization base may receive a PAT. */
export function azureDevOpsBaseUrl(
  organization: string | null | undefined,
  configuredUrl?: string | null,
): string | undefined {
  const org = azureDevOpsOrganization(organization);
  if (org === undefined) return undefined;
  const base = `https://dev.azure.com/${org}`;
  if (configuredUrl === null || configuredUrl === undefined || configuredUrl === "") return base;
  const url = azureDevOpsServiceSourceUrl(configuredUrl);
  if (url === undefined) return undefined;
  if (url.pathname !== "/" && url.pathname.toLowerCase() !== `/${org}` && url.pathname.toLowerCase() !== `/${org}/`)
    return undefined;
  return base;
}

export function azureDevOpsRepositoryApiUrl(identifier: string, expectedOrganization: string): string | undefined {
  const repo = parseAzureDevOpsRepository(identifier, expectedOrganization);
  return repo === undefined
    ? undefined
    : `https://dev.azure.com/${repo.organization}/${encodeURIComponent(repo.project)}/_apis/git/repositories/${encodeURIComponent(repo.repository)}`;
}

export function azureDevOpsRepositoryHttpUrl(identifier: string, expectedOrganization?: string): string | undefined {
  const repo = parseAzureDevOpsRepository(identifier, expectedOrganization);
  return repo === undefined
    ? undefined
    : `https://dev.azure.com/${repo.organization}/${encodeURIComponent(repo.project)}/_git/${encodeURIComponent(repo.repository)}`;
}

export function azureDevOpsPatAuthorization(token: string): string | undefined {
  if (token.length === 0 || token.length > 4096 || /[^\x21-\x7e]/u.test(token)) return undefined;
  return `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`;
}

export type AzureDevOpsCredentials = Readonly<{
  organization: string;
  token: string;
  apiUrl?: string | null;
  httpUrl?: string | null;
}>;

type AzureDevOpsFetchOptions = Readonly<{
  method?: "GET" | "POST";
  body?: string;
  accept?: string;
  maxResponseBytes?: number;
  timeoutMs?: number;
  signal?: Readonly<AbortSignal>;
}>;

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;

function authorizedRequestUrl(credentials: AzureDevOpsCredentials, value: string): boolean {
  const base = azureDevOpsBaseUrl(credentials.organization, credentials.apiUrl);
  if (base === undefined || azureDevOpsBaseUrl(credentials.organization, credentials.httpUrl) === undefined)
    return false;
  if (value.trim() !== value || /[\\\x00-\x20\x7f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.origin !== "https://dev.azure.com" || url.username !== "" || url.password !== "" || url.hash !== "")
      return false;
    const parts = url.pathname.split("/");
    if (azureDevOpsOrganization(parts[1]) !== azureDevOpsOrganization(credentials.organization)) return false;
    return parts.slice(2).every((part): boolean => {
      const decoded = decodeURIComponent(part);
      return decoded !== "." && decoded !== ".." && !/[\\/\x00-\x1f\x7f%]/u.test(decoded);
    });
  } catch {
    return false;
  }
}

function azureRequestInit(
  authorization: string,
  options: AzureDevOpsFetchOptions,
  maxResponseBytes: number,
): ExternalRequestInit {
  return {
    method: options.method ?? "GET",
    headers: {
      Authorization: authorization,
      Accept: options.accept ?? "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: options.timeoutMs ?? 15_000,
    maxResponseBytes,
  };
}

/** PAT requests stay pinned to the configured Services organization, including on redirects. */
export async function fetchAzureDevOpsUrl(
  credentials: AzureDevOpsCredentials,
  url: string,
  options: AzureDevOpsFetchOptions = {},
): Promise<Response> {
  const authorization = azureDevOpsPatAuthorization(credentials.token);
  if (authorization === undefined || !authorizedRequestUrl(credentials, url))
    throw new Error("Invalid Azure DevOps credentials or organization-scoped URL");
  const maxResponseBytes = options.maxResponseBytes ?? MAX_JSON_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_ARCHIVE_BYTES)
    throw new Error("Invalid Azure DevOps response byte limit");
  const destination = await resolveExternalUrl(url, false);
  if ("error" in destination) throw new Error("Azure DevOps URL could not be resolved safely");
  const response = await fetchResolvedExternalUrl(
    destination.target,
    azureRequestInit(authorization, options, maxResponseBytes),
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch((): undefined => undefined);
    throw new Error("Azure DevOps redirects are not permitted");
  }
  return response;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function repositoryJson(
  credentials: AzureDevOpsCredentials,
  identifier: string,
  suffix: string,
): Promise<Readonly<{ body: Readonly<Record<string, unknown>>; continuation?: string }> | undefined> {
  const base = azureDevOpsRepositoryApiUrl(identifier, credentials.organization);
  if (base === undefined) throw new Error("Invalid Azure DevOps repository identifier or organization");
  const response = await fetchAzureDevOpsUrl(credentials, `${base}${suffix}`);
  if (!response.ok) {
    await response.body?.cancel().catch((): undefined => undefined);
    return undefined;
  }
  const body = record(JSON.parse(await readTextWithLimit(response, MAX_JSON_BYTES)) as unknown);
  if (body === undefined) throw new Error("Invalid Azure DevOps repository response");
  const continuation = response.headers.get("x-ms-continuationtoken");
  if (continuation !== null && (continuation.length > 2048 || /[\x00-\x1f\x7f]/u.test(continuation)))
    throw new Error("Invalid Azure DevOps continuation token");
  return { body, ...(continuation === null || continuation === "" ? {} : { continuation }) };
}

function branchName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\x00-\x20\x7f]/u.test(value))
    return undefined;
  const name = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
  return name === "" ? undefined : name;
}

/** Return the configured default branch, never an assumed main/master fallback. */
export async function fetchAzureDevOpsDefaultBranch(
  credentials: AzureDevOpsCredentials,
  identifier: string,
): Promise<string | undefined> {
  const result = await repositoryJson(credentials, identifier, "?api-version=7.1");
  const ref = result?.body["defaultBranch"];
  return typeof ref === "string" && ref.startsWith("refs/heads/") ? branchName(ref) : undefined;
}

type AzureDevOpsRef = Readonly<{ name: string; objectId: string; peeledObjectId?: string }>;

function azureRef(value: unknown): AzureDevOpsRef {
  const ref = record(value);
  const name = ref?.["name"];
  const objectId = ref?.["objectId"];
  const peeledObjectId = ref?.["peeledObjectId"];
  if (typeof name !== "string" || typeof objectId !== "string" || !COMMIT_SHA.test(objectId))
    throw new Error("Invalid Azure DevOps ref");
  return {
    name,
    objectId,
    ...(typeof peeledObjectId === "string" && COMMIT_SHA.test(peeledObjectId) ? { peeledObjectId } : {}),
  };
}

async function repositoryRefs(
  credentials: AzureDevOpsCredentials,
  identifier: string,
  filter: string,
): Promise<readonly AzureDevOpsRef[] | undefined> {
  const refs: AzureDevOpsRef[] = [];
  const seen = new Set<string>();
  let continuation: string | undefined;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ "api-version": "7.1", filter, peelTags: "true", $top: "100" });
    if (continuation !== undefined) query.set("continuationToken", continuation);
    const result = await repositoryJson(credentials, identifier, `/refs?${query}`);
    if (result === undefined) return undefined;
    const values = result.body["value"];
    if (!Array.isArray(values) || values.length > 100) throw new Error("Invalid Azure DevOps ref listing");
    for (const value of values) {
      refs.push(azureRef(value));
    }
    continuation = result.continuation;
    if (continuation === undefined) return refs;
    if (seen.has(continuation)) throw new Error("Repeated Azure DevOps continuation token");
    seen.add(continuation);
  }
  throw new Error("Azure DevOps ref listing exceeds the page limit");
}

/** Ref filters are prefixes in Azure DevOps; only the exact branch may select a commit. */
export async function fetchAzureDevOpsLatestCommit(
  credentials: AzureDevOpsCredentials,
  identifier: string,
  branch: string,
): Promise<string | undefined> {
  const name = branchName(branch);
  if (name === undefined) return undefined;
  const refs = await repositoryRefs(credentials, identifier, `heads/${name}`);
  const matches = refs?.filter((ref): boolean => ref.name === `refs/heads/${name}`);
  const sha = matches?.length === 1 ? matches[0]?.objectId : undefined;
  return sha === undefined || /^0{40}$/u.test(sha) ? undefined : sha;
}

/** Annotated tags resolve to the peeled commit rather than the tag-object ID. */
export async function fetchAzureDevOpsTags(
  credentials: AzureDevOpsCredentials,
  identifier: string,
): Promise<readonly Readonly<{ name: string; sha: string }>[]> {
  const refs = await repositoryRefs(credentials, identifier, "tags/");
  if (refs === undefined) throw new Error("Azure DevOps tags could not be retrieved");
  return refs
    .filter((ref): boolean => ref.name.startsWith("refs/tags/"))
    .map(
      (ref): Readonly<{ name: string; sha: string }> => ({
        name: ref.name.slice("refs/tags/".length),
        sha: ref.peeledObjectId ?? ref.objectId,
      }),
    );
}

function archiveCommitUrl(credentials: AzureDevOpsCredentials, identifier: string, commit: string): string {
  const base = azureDevOpsRepositoryApiUrl(identifier, credentials.organization);
  if (base === undefined || !COMMIT_SHA.test(commit) || /^0{40}$/u.test(commit))
    throw new Error("Invalid Azure DevOps repository or commit SHA");
  const query = new URLSearchParams({
    path: "/",
    recursionLevel: "Full",
    $format: "zip",
    download: "true",
    "versionDescriptor.version": commit,
    "versionDescriptor.versionType": "commit",
    "api-version": "7.1",
  });
  return `${base}/items?${query}`;
}

/** Download immutable commit contents and convert the bounded ZIP to our validated tar format. */
export async function fetchAzureDevOpsArchive(
  credentials: AzureDevOpsCredentials,
  identifier: string,
  commit: string,
  limits: AzureDevOpsArchiveLimits = {},
  signal?: Readonly<AbortSignal>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- One delivery shares a cumulative network budget.
  downloadBudget?: { remainingBytes: number },
): Promise<Uint8Array> {
  const url = archiveCommitUrl(credentials, identifier, commit);
  const maxBytes = Math.min(
    limits.maxCompressedBytes ?? MAX_ARCHIVE_BYTES,
    downloadBudget?.remainingBytes ?? MAX_ARCHIVE_BYTES,
  );
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Azure DevOps archive download budget exhausted");
  // Reserve before the request. Failed/oversized transports keep the reservation,
  // because their consumed bytes cannot safely be inferred from a missing body.
  if (downloadBudget !== undefined) downloadBudget.remainingBytes -= maxBytes;
  const response = await fetchAzureDevOpsUrl(credentials, url, {
    accept: "application/zip",
    timeoutMs: 10 * 60_000,
    maxResponseBytes: maxBytes,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch((): undefined => undefined);
    throw new Error(`Azure DevOps archive request failed with HTTP ${response.status}`);
  }
  const downloaded = await readBytesWithLimit(response, maxBytes);
  if (downloadBudget !== undefined) downloadBudget.remainingBytes += maxBytes - downloaded.length;
  const archive = azureDevOpsZipToTarGz(downloaded, limits);
  if (archive.length > maxBytes) throw new Error("Azure DevOps converted archive exceeds the byte limit");
  return archive;
}
