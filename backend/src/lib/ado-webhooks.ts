/** Azure DevOps Services service-hook wire format. Payload URLs never become credential destinations. */
import { createHash, timingSafeEqual } from "node:crypto";
import { azureDevOpsRepositoryHttpUrl, azureDevOpsOrganization, parseAzureDevOpsRepository } from "./azure-devops";
import { vcsSourceIdentity, type VcsSourceIdentity } from "./vcs-source";

const SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_SHA = "0".repeat(40);
export const MAX_AZURE_DEVOPS_DELIVERY_REFS = 32;

export type AzureDevOpsWebhookDetails = Readonly<{
  branch?: string;
  targetBranch?: string;
  beforeCommitSha?: string;
  cloneUrl: string;
  commitMessage: string;
  commitSha: string;
  commitUrl: string;
  filesChanged: ReadonlySet<string>;
  pullRequestNumber?: number;
  trustedPullRequest?: boolean;
  repoFullName: string;
  repositoryId: string;
  senderUsername: string;
  sourceIdentity: VcsSourceIdentity;
  tag?: string;
}>;
export type AzureDevOpsWebhook = Readonly<{ kind: "push" | "pull_request"; details: AzureDevOpsWebhookDetails }>;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function sha(value: unknown): string | undefined {
  return typeof value === "string" && SHA.test(value) ? value.toLowerCase() : undefined;
}

/** Compare fixed-size digests, including for differently sized supplied secrets. */
export function verifyAzureDevOpsWebhook(authorization: string | null, username: string, secret: string): boolean {
  if (
    authorization === null ||
    authorization.length > 16384 ||
    secret === "" ||
    username === "" ||
    username.includes(":")
  )
    return false;
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)?.[1];
  if (encoded === undefined) return false;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return false;
  return timingSafeEqual(
    createHash("sha256").update(decoded).digest(),
    createHash("sha256").update(`${username}:${secret}`).digest(),
  );
}

export function azureDevOpsWebhookEvent(payload: Readonly<Record<string, unknown>>): string | undefined {
  if (payload["publisherId"] !== "tfs") return undefined;
  const event = payload["eventType"];
  return event === "git.push" || event === "git.pullrequest.created" || event === "git.pullrequest.updated"
    ? event
    : undefined;
}

/** Event IDs are mandatory and scoped to the authenticated connection, never a caller-supplied header. */
export function azureDevOpsWebhookDeliveryId(
  payload: Readonly<Record<string, unknown>>,
  clientId: string,
): string | undefined {
  const id = payload["id"];
  return typeof id === "string" && UUID.test(id) && clientId !== ""
    ? `azure_devops:${encodeURIComponent(clientId)}:${id.toLowerCase()}`
    : undefined;
}

type RepositoryIdentity = Readonly<{
  cloneUrl: string;
  repoFullName: string;
  repositoryId: string;
  sourceIdentity: VcsSourceIdentity;
}>;
type WebhookBase = RepositoryIdentity & Readonly<{ senderUsername: string; filesChanged: ReadonlySet<string> }>;

function legacyRepositoryPath(
  url: Readonly<Pick<URL, "hostname">>,
  inputParts: readonly string[],
  project: string | undefined,
  name: string | undefined,
): string | undefined {
  const organization = azureDevOpsOrganization(/^([a-z0-9-]+)\.visualstudio\.com$/iu.exec(url.hostname)?.[1]);
  const parts = inputParts[0] === "DefaultCollection" ? inputParts.slice(1) : inputParts;
  if (organization === undefined || project === undefined || name === undefined) return undefined;
  if (parts.at(-1) !== name || parts.at(-2) !== "_git") return undefined;
  if (parts.length !== 2 && (parts.length !== 3 || parts[0] !== project)) return undefined;
  return `${organization}/${project}/_git/${name}`;
}

function remoteRepositoryPath(remoteUrl: string, repository: Readonly<Record<string, unknown>>): string | undefined {
  const url = new URL(remoteUrl);
  if (
    remoteUrl.includes("\\") ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return undefined;
  const parts = url.pathname.replace(/^\//u, "").replace(/\/$/u, "").split("/").map(decodeURIComponent);
  const project = string(record(repository["project"])?.["name"]);
  const name = string(repository["name"]);
  if (url.hostname !== "dev.azure.com") return legacyRepositoryPath(url, parts, project, name);
  if (parts.length !== 3) return parts.join("/");
  if (parts[1] !== "_git" || project === undefined || name !== parts[2]) return undefined;
  return `${parts[0] ?? ""}/${project}/_git/${name}`;
}

function repositoryIdentity(resource: Readonly<Record<string, unknown>>): RepositoryIdentity | undefined {
  const repository = record(resource["repository"]);
  if (repository === undefined) return undefined;
  const remoteUrl = string(repository["remoteUrl"]);
  const repositoryId = string(repository["id"]);
  if (remoteUrl === undefined || repositoryId === undefined || !UUID.test(repositoryId)) return undefined;
  let identifier: string | undefined;
  try {
    identifier = remoteRepositoryPath(remoteUrl, repository);
  } catch {
    return undefined;
  }
  const parsed = identifier === undefined ? undefined : parseAzureDevOpsRepository(identifier);
  if (parsed === undefined) return undefined;
  const repoFullName = `${parsed.organization}/${parsed.project}/_git/${parsed.repository}`;
  const cloneUrl = azureDevOpsRepositoryHttpUrl(repoFullName);
  const sourceIdentity = vcsSourceIdentity("azure_devops", cloneUrl);
  if (cloneUrl === undefined || sourceIdentity === undefined) return undefined;
  return { cloneUrl, repoFullName, repositoryId: repositoryId.toLowerCase(), sourceIdentity };
}

function branch(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("refs/heads/") && value.length > 11
    ? value.slice(11)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function inactivePullRequest(resource: Readonly<Record<string, unknown>>): boolean {
  return resource["status"] !== "active" || resource["isDraft"] === true || resource["forkSource"] != null;
}

function parsePullRequest(
  resource: Readonly<Record<string, unknown>>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- base contains an immutable ReadonlySet
  base: WebhookBase,
): readonly AzureDevOpsWebhook[] | undefined {
  if (inactivePullRequest(resource)) return [];
  const pullRequestNumber = positiveInteger(resource["pullRequestId"]);
  const sourceBranch = branch(resource["sourceRefName"]);
  const targetBranch = branch(resource["targetRefName"]);
  const commitSha = sha(record(resource["lastMergeSourceCommit"])?.["commitId"]);
  const beforeCommitSha = sha(record(resource["lastMergeTargetCommit"])?.["commitId"]);
  if (
    pullRequestNumber === undefined ||
    sourceBranch === undefined ||
    targetBranch === undefined ||
    commitSha === undefined ||
    commitSha === ZERO_SHA
  )
    return undefined;
  return [
    {
      kind: "pull_request",
      details: {
        ...base,
        branch: sourceBranch,
        targetBranch,
        commitSha,
        ...(beforeCommitSha === undefined ? {} : { beforeCommitSha }),
        pullRequestNumber,
        // Independently verified against the authenticated repository API before a run is admitted.
        trustedPullRequest: false,
        commitMessage: string(resource["title"]) ?? `Pull request #${pullRequestNumber}`,
        commitUrl: `${base.cloneUrl}/pullrequest/${pullRequestNumber}`,
      },
    },
  ];
}

function commitComment(commit: Readonly<Record<string, unknown>> | undefined, ref: string): string {
  return string(commit?.["comment"]) ?? `Push ${ref}`;
}

function parsePushRef(
  update: unknown,
  commits: readonly unknown[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- base contains an immutable ReadonlySet
  base: WebhookBase,
): AzureDevOpsWebhook | null | undefined {
  const item = record(update);
  const ref = string(item?.["name"]);
  const commitSha = sha(item?.["newObjectId"]);
  const beforeCommitSha = sha(item?.["oldObjectId"]);
  if (ref === undefined || commitSha === undefined || beforeCommitSha === undefined) return undefined;
  if (commitSha === ZERO_SHA) return null;
  const sourceBranch = branch(ref);
  const tag = ref.startsWith("refs/tags/") && ref.length > 10 ? ref.slice(10) : undefined;
  if (sourceBranch === undefined && tag === undefined) return null;
  const head = commits.map(record).find((commit): boolean => sha(commit?.["commitId"]) === commitSha);
  return {
    kind: "push",
    details: {
      ...base,
      commitSha,
      beforeCommitSha,
      ...(sourceBranch === undefined ? {} : { branch: sourceBranch }),
      ...(tag === undefined ? {} : { tag }),
      commitMessage: commitComment(head, ref),
      commitUrl: `${base.cloneUrl}/commit/${commitSha}`,
    },
  };
}

function parsePush(
  resource: Readonly<Record<string, unknown>>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- base contains an immutable ReadonlySet
  base: WebhookBase,
): readonly AzureDevOpsWebhook[] | undefined {
  const updates = resource["refUpdates"];
  if (!Array.isArray(updates) || updates.length === 0 || updates.length > MAX_AZURE_DEVOPS_DELIVERY_REFS)
    return undefined;
  const commits = Array.isArray(resource["commits"]) ? resource["commits"] : [];
  const parsed: AzureDevOpsWebhook[] = [];
  const refs = new Set<unknown>();
  for (const update of updates) {
    const ref = record(update)?.["name"];
    if (refs.has(ref)) return undefined;
    refs.add(ref);
    const event = parsePushRef(update, commits, base);
    if (event === undefined) return undefined;
    if (event !== null) parsed.push(event);
  }
  return parsed;
}

export function parseAzureDevOpsWebhook(
  eventName: string,
  payload: Readonly<Record<string, unknown>>,
): readonly AzureDevOpsWebhook[] | undefined {
  if (azureDevOpsWebhookEvent(payload) !== eventName) return undefined;
  const resource = record(payload["resource"]);
  if (resource === undefined) return undefined;
  const identity = repositoryIdentity(resource);
  if (identity === undefined) return undefined;
  const actor = record(resource[eventName === "git.push" ? "pushedBy" : "createdBy"]);
  const senderUsername = string(actor?.["displayName"]) ?? string(actor?.["uniqueName"]) ?? string(actor?.["id"]);
  if (senderUsername === undefined) return undefined;
  const base = { ...identity, senderUsername, filesChanged: new Set<string>() };
  return eventName === "git.push" ? parsePush(resource, base) : parsePullRequest(resource, base);
}
