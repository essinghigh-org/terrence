import { copyFile, mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import jwt from "jsonwebtoken";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { jsonExtract, jsonSet } from "./db-json";
import {
  configurationVersions,
  githubAppInstallations,
  oauthClients,
  oauthTokens,
  organizations,
  policySets,
  registryModules,
  runs,
  workspaces,
} from "../db/schema";
import { decryptSecret } from "./secrets";
import { matchesPolicySetWebhook, synchronizeVcsPolicySet } from "./policy-sync";
import { synchronizeRegistryModule } from "./registry-module-sync";
import { auditLog, type DeepReadonly } from "./utils";
import { envEnabled } from "./env";
import { fetchResolvedExternalUrl, fetchResolvedExternalUrlStream, resolveExternalUrl, type ExternalRequestInit, type ResolvedExternalUrl } from "./url-safety";
import {
  providerForServiceProvider,
  sourceIdentityForConnection,
  vcsSourceMatchesConnection,
  vcsSourceIdentity,
  type VcsProvider,
  type VcsSourceIdentity,
} from "./vcs-source";
import { githubAppApiBase } from "./github-api";
import { newRunId } from "./run-id";

type WebhookPayload = Readonly<Record<string, unknown>>;
type VcsRepo = DeepReadonly<NonNullable<typeof workspaces.$inferSelect.vcsRepo>>;
type WebhookDetails = Readonly<{
  readonly branch?: string;
  readonly targetBranch?: string;
  readonly cloneUrl: string;
  readonly commitMessage: string;
  readonly commitSha: string;
  readonly commitUrl: string;
  readonly filesChanged: ReadonlySet<string>;
  readonly githubInstallationId?: number;
  readonly pullRequestNumber?: number;
  readonly repoFullName: string;
  readonly senderUsername: string;
  readonly senderAvatarUrl?: string;
  readonly sourceIdentity: VcsSourceIdentity;
  readonly tag?: string;
}>;
type OAuthProvider = "gitlab" | "bitbucket";
type ParsedProviderWebhook = Readonly<{
  details: WebhookDetails;
  kind: "push" | "pull_request";
}>;
type ProviderCredentials = Readonly<{
  apiUrl: string;
  provider: VcsProvider;
  token: string;
  /** The bound oauth-clients.id that authorized this integration (if OAuth). */
  oauthClientId?: string;
}>;
type VcsCredentialSubject = Readonly<{
  orgId: string;
  vcsRepo: Readonly<{
    githubAppInstallationId?: string;
    oauthTokenId?: string;
  }> | null;
}>;

const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_VCS_REDIRECTS = 5;

type VcsFetchInit = Readonly<{
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

/** Resolve and pin every provider request before sending credentials. */
function normalizedVcsFetchInit(init: VcsFetchInit): {
  method: string;
  timeoutMs: number;
  maxResponseBytes: number;
  headers?: Readonly<Record<string, string>>;
  body?: string;
} {
  return {
    method: init.method ?? "GET",
    timeoutMs: init.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    maxResponseBytes: init.maxResponseBytes ?? 16 * 1024 * 1024,
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
  };
}

type VcsResolvedFetcher = (target: ResolvedExternalUrl, init: ExternalRequestInit) => Promise<Response>;

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body !== null) await response.body.cancel().catch((): undefined => undefined);
}

async function fetchVcsUrlWithRedirects(
  url: string,
  init: VcsFetchInit,
  fetcher: VcsResolvedFetcher,
): Promise<Response> {
  const allowPrivate = envEnabled(process.env["TERRENCE_ALLOW_PRIVATE_VCS_URLS"]);
  const requestInit = normalizedVcsFetchInit(init);
  let currentUrl = url;
  const requestHeaders = new Headers(requestInit.headers);

  for (let redirectCount = 0; ; redirectCount += 1) {
    const destination = await resolveExternalUrl(currentUrl, allowPrivate);
    if ("error" in destination) return new Response(destination.error, { status: 422 });
    const response = await fetcher(destination.target, {
      ...requestInit,
      headers: Object.fromEntries(requestHeaders.entries()),
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    await cancelResponseBody(response);
    if (redirectCount >= MAX_VCS_REDIRECTS) return new Response("Too many VCS redirects", { status: 502 });
    const location = response.headers.get("location");
    if (location === null || location.trim() === "") return new Response("Redirect response missing Location", { status: 502 });

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, destination.target.url);
    } catch {
      return new Response("Invalid redirect URL", { status: 422 });
    }
    if (new URL(destination.target.url).origin !== redirectUrl.origin) requestHeaders.delete("authorization");
    currentUrl = redirectUrl.toString();
  }
}

async function fetchVcsUrl(url: string, init: VcsFetchInit = {}): Promise<Response> {
  return fetchVcsUrlWithRedirects(url, init, fetchResolvedExternalUrl);
}

async function fetchVcsUrlStream(url: string, init: VcsFetchInit = {}): Promise<Response> {
  return fetchVcsUrlWithRedirects(url, init, fetchResolvedExternalUrlStream);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const candidate = requiredString(value);
  if (candidate === undefined) return undefined;
  try {
    return new URL(candidate).protocol === "https:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function commitSubject(message: string): string {
  const subject = message.split(/\r?\n/u, 1)[0]?.trim();
  return subject === undefined || subject === "" ? message.trim() : subject;
}

function changedFiles(payload: WebhookPayload): ReadonlySet<string> | undefined {
  if (!Array.isArray(payload["commits"])) return undefined;
  const files = new Set<string>();
  for (const value of payload["commits"]) {
    const commit = asRecord(value);
    if (commit === undefined) return undefined;
    for (const key of ["added", "removed", "modified"]) {
      const entries = commit[key];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || entries.some((entry: unknown): boolean => typeof entry !== "string")) return undefined;
      for (const entry of entries as string[]) files.add(entry);
    }
  }
  return files;
}


function extractDeliveryInstallationId(payload: WebhookPayload): number | undefined {
  const installation = asRecord(payload["installation"]);
  if (typeof installation?.["id"] !== "number") return undefined;
  if (!Number.isSafeInteger(installation["id"])) return undefined;
  if (installation["id"] <= 0) return undefined;
  return installation["id"];
}

function parseRefBranchTag(ref: string): { branch?: string; tag?: string } | undefined {
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
  const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : undefined;
  if (branch === undefined && tag === undefined) return undefined;
  if (branch === "" || tag === "") return undefined;
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(tag === undefined ? {} : { tag }),
  };
}

function validateGithubPushFields(ref: string | undefined, commitSha: string | undefined, commitMessage: string | undefined, commitUrl: string | undefined, filesChanged: Readonly<ReadonlySet<string>> | undefined): string | undefined {
  if (ref === undefined) return "ref";
  if (commitSha === undefined) return "commitSha";
  if (commitMessage === undefined) return "commitMessage";
  if (commitUrl === undefined) return "commitUrl";
  if (filesChanged === undefined) return "filesChanged";
  return undefined;
}

function parseGithubPushWebhook(payload: WebhookPayload, base: DeepReadonly<{ cloneUrl: string; repoFullName: string; senderUsername: string; senderAvatarUrl: string | undefined; deliveryInstallationId: number | undefined; sourceIdentity: VcsSourceIdentity }>): WebhookDetails | undefined {
  const ref = requiredString(payload["ref"]);
  const commitSha = requiredString(payload["after"]);
  const headCommit = asRecord(payload["head_commit"]);
  const commitMessage = requiredString(headCommit?.["message"]);
  const commitUrl = requiredString(headCommit?.["url"]);
  const filesChanged = changedFiles(payload);
  if (validateGithubPushFields(ref, commitSha, commitMessage, commitUrl, filesChanged) !== undefined) return undefined;
  if (ref === undefined || commitSha === undefined || commitMessage === undefined || commitUrl === undefined || filesChanged === undefined) return undefined;
  const branchTag = parseRefBranchTag(ref);
  if (branchTag === undefined) return undefined;
  if (branchTag.branch !== undefined && filesChanged.size === 0) return undefined;
  return {
    ...(branchTag.branch === undefined ? {} : { branch: branchTag.branch }),
    cloneUrl: base.cloneUrl,
    commitMessage,
    commitSha,
    commitUrl,
    filesChanged,
    ...(base.deliveryInstallationId === undefined ? {} : { githubInstallationId: base.deliveryInstallationId }),
    repoFullName: base.repoFullName,
    senderUsername: base.senderUsername,
    ...(base.senderAvatarUrl === undefined ? {} : { senderAvatarUrl: base.senderAvatarUrl }),
    sourceIdentity: base.sourceIdentity,
    ...(branchTag.tag === undefined ? {} : { tag: branchTag.tag }),
  };
}

function validateGithubPrFields(branch: string | undefined, commitSha: string | undefined, commitMessage: string | undefined, commitUrl: string | undefined, pullRequestNumber: unknown): string | undefined {
  if (branch === undefined) return "branch";
  if (commitSha === undefined) return "commitSha";
  if (commitMessage === undefined) return "commitMessage";
  if (commitUrl === undefined) return "commitUrl";
  if (typeof pullRequestNumber !== "number") return "pullRequestNumber";
  if (!Number.isSafeInteger(pullRequestNumber)) return "pullRequestNumber";
  return undefined;
}

function buildGithubPrDetails(branch: string, targetBranch: string | undefined, base: DeepReadonly<{ cloneUrl: string; repoFullName: string; senderUsername: string; senderAvatarUrl: string | undefined; deliveryInstallationId: number | undefined; sourceIdentity: VcsSourceIdentity }>, commitMessage: string, commitSha: string, commitUrl: string, pullRequestNumber: number): WebhookDetails {
  return {
    branch,
    cloneUrl: base.cloneUrl,
    commitMessage,
    commitSha,
    commitUrl,
    filesChanged: new Set<string>(),
    pullRequestNumber,
    repoFullName: base.repoFullName,
    senderUsername: base.senderUsername,
    ...(targetBranch === undefined ? {} : { targetBranch }),
    ...(base.deliveryInstallationId === undefined ? {} : { githubInstallationId: base.deliveryInstallationId }),
    ...(base.senderAvatarUrl === undefined ? {} : { senderAvatarUrl: base.senderAvatarUrl }),
    sourceIdentity: base.sourceIdentity,
  };
}

function parseGithubPullRequestWebhook(payload: WebhookPayload, base: DeepReadonly<{ cloneUrl: string; repoFullName: string; senderUsername: string; senderAvatarUrl: string | undefined; deliveryInstallationId: number | undefined; sourceIdentity: VcsSourceIdentity }>): WebhookDetails | undefined {
  const pullRequest = asRecord(payload["pull_request"]);
  const head = asRecord(pullRequest?.["head"]);
  const baseRef = asRecord(pullRequest?.["base"]);
  const branch = requiredString(head?.["ref"]);
  const targetBranch = requiredString(baseRef?.["ref"]);
  const commitSha = requiredString(head?.["sha"]);
  const commitMessage = requiredString(pullRequest?.["title"]);
  const commitUrl = requiredString(pullRequest?.["html_url"]);
  const pullRequestNumber = payload["number"];
  if (validateGithubPrFields(branch, commitSha, commitMessage, commitUrl, pullRequestNumber) !== undefined) return undefined;
  if (branch === undefined || commitSha === undefined || commitMessage === undefined || commitUrl === undefined || typeof pullRequestNumber !== "number" || !Number.isSafeInteger(pullRequestNumber)) return undefined;
  return buildGithubPrDetails(branch, targetBranch, base, commitMessage, commitSha, commitUrl, pullRequestNumber);
}

function extractGitlabCommits(payload: WebhookPayload): unknown[] {
  return Array.isArray(payload["commits"]) ? payload["commits"] : [];
}

/** GitLab limits the inline commit list (normally to 20 entries). A larger
 * total means the file list is incomplete and file-trigger matching is unsafe. */
export function gitlabPushCommitListTruncated(payload: WebhookPayload): boolean {
  const commits = payload["commits"];
  const total = payload["total_commits_count"];
  return Array.isArray(commits)
    && typeof total === "number"
    && Number.isSafeInteger(total)
    && total > commits.length;
}

function resolveGitlabCommitUrl(headCommit: Readonly<Record<string, unknown>> | undefined, project: Readonly<Record<string, unknown>> | undefined, cloneUrl: string, commitSha: string | undefined): string {
  const fromHead = requiredString(headCommit?.["url"]);
  if (fromHead !== undefined) return fromHead;
  const webUrl = requiredString(project?.["web_url"]) ?? cloneUrl;
  return `${webUrl}/-/commit/${commitSha ?? ""}`;
}

function resolveGitlabCommitSha(payload: WebhookPayload): string | undefined {
  return requiredString(payload["checkout_sha"]) ?? requiredString(payload["after"]);
}

function validateGitlabPushFields(ref: string | undefined, commitSha: string | undefined, filesChanged: Readonly<ReadonlySet<string>> | undefined): string | undefined {
  if (ref === undefined) return "ref";
  if (commitSha === undefined) return "commitSha";
  if (filesChanged === undefined) return "filesChanged";
  return undefined;
}

function parseGitlabPushWebhook(payload: WebhookPayload, project: Readonly<Record<string, unknown>> | undefined, repoFullName: string, cloneUrl: string, senderUsername: string, sourceIdentity: VcsSourceIdentity): ParsedProviderWebhook | undefined {
  const ref = requiredString(payload["ref"]);
  const commitSha = resolveGitlabCommitSha(payload);
  const commits = extractGitlabCommits(payload);
  const headCommit = asRecord(commits.at(-1));
  const commitMessage = requiredString(headCommit?.["message"]) ?? "VCS push";
  const commitUrl = resolveGitlabCommitUrl(headCommit, project, cloneUrl, commitSha);
  const filesTruncated = gitlabPushCommitListTruncated(payload);
  const filesChanged = filesTruncated ? new Set<string>() : changedFiles(payload);
  if (validateGitlabPushFields(ref, commitSha, filesChanged) !== undefined) return undefined;
  if (ref === undefined || commitSha === undefined || filesChanged === undefined) return undefined;
  const branchTag = parseRefBranchTag(ref);
  if (branchTag === undefined) return undefined;
  // An actually empty complete push has no useful file trigger and is ignored.
  // A truncated inline list is different: continue with an empty set so the
  // file-trigger matcher fails open rather than suppressing the push.
  if (branchTag.branch !== undefined && filesChanged.size === 0 && !filesTruncated) return undefined;
  return {
    kind: "push",
    details: {
      ...(branchTag.branch === undefined ? {} : { branch: branchTag.branch }),
      cloneUrl,
      commitMessage,
      commitSha,
      commitUrl,
      filesChanged,
      repoFullName,
      senderUsername,
      sourceIdentity,
      ...(branchTag.tag === undefined ? {} : { tag: branchTag.tag }),
    },
  };
}

function resolveGitlabMrCommitMessage(attributes: Readonly<Record<string, unknown>> | undefined, lastCommit: Readonly<Record<string, unknown>> | undefined): string {
  const fromTitle = requiredString(attributes?.["title"]);
  if (fromTitle !== undefined) return fromTitle;
  const fromCommit = requiredString(lastCommit?.["message"]);
  if (fromCommit !== undefined) return fromCommit;
  return "Merge request";
}

function resolveGitlabMrCommitUrl(attributes: Readonly<Record<string, unknown>> | undefined, lastCommit: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const fromAttr = requiredString(attributes?.["url"]);
  if (fromAttr !== undefined) return fromAttr;
  return requiredString(lastCommit?.["url"]);
}

function validateGitlabMrFields(branch: string | undefined, commitSha: string | undefined, commitUrl: string | undefined, pullRequestNumber: unknown): string | undefined {
  if (branch === undefined) return "branch";
  if (commitSha === undefined) return "commitSha";
  if (commitUrl === undefined) return "commitUrl";
  if (typeof pullRequestNumber !== "number") return "pullRequestNumber";
  if (!Number.isSafeInteger(pullRequestNumber)) return "pullRequestNumber";
  return undefined;
}

function parseGitlabMergeRequestWebhook(payload: WebhookPayload, repoFullName: string, cloneUrl: string, senderUsername: string, sourceIdentity: VcsSourceIdentity): ParsedProviderWebhook | undefined {
  const attributes = asRecord(payload["object_attributes"]);
  const action = attributes?.["action"];
  if (!["open", "reopen", "update"].includes(typeof action === "string" ? action : "")) return undefined;
  const lastCommit = asRecord(attributes?.["last_commit"]);
  const branch = requiredString(attributes?.["source_branch"]);
  const targetBranch = requiredString(attributes?.["target_branch"]);
  const commitSha = requiredString(lastCommit?.["id"]);
  const commitMessage = resolveGitlabMrCommitMessage(attributes, lastCommit);
  const commitUrl = resolveGitlabMrCommitUrl(attributes, lastCommit);
  const pullRequestNumber = attributes?.["iid"];
  if (validateGitlabMrFields(branch, commitSha, commitUrl, pullRequestNumber) !== undefined) return undefined;
  if (branch === undefined || commitSha === undefined || commitUrl === undefined || typeof pullRequestNumber !== "number" || !Number.isSafeInteger(pullRequestNumber)) return undefined;
  return {
    kind: "pull_request",
    details: {
      branch,
      ...(targetBranch === undefined ? {} : { targetBranch }),
      cloneUrl,
      commitMessage,
      commitSha,
      commitUrl,
      filesChanged: new Set<string>(),
      pullRequestNumber,
      repoFullName,
      senderUsername,
      sourceIdentity,
    },
  };
}

function extractBitbucketChanges(payload: WebhookPayload): unknown[] | undefined {
  const push = asRecord(payload["push"]);
  const changes = push?.["changes"];
  if (!Array.isArray(changes)) return undefined;
  return changes as unknown[];
}

function validateBitbucketPushFields(referenceType: string | undefined, referenceName: string | undefined, commitSha: string | undefined, commitUrl: string | undefined): string | undefined {
  if (!["branch", "tag"].includes(referenceType ?? "")) return "referenceType";
  if (referenceName === undefined) return "referenceName";
  if (commitSha === undefined) return "commitSha";
  if (commitUrl === undefined) return "commitUrl";
  return undefined;
}

function parseBitbucketPushChange(
  changeValue: unknown,
  repoFullName: string,
  cloneUrl: string,
  senderUsername: string,
  sourceIdentity: VcsSourceIdentity,
): ParsedProviderWebhook | undefined {
  const change = asRecord(changeValue);
  const reference = asRecord(change?.["new"]);
  const target = asRecord(reference?.["target"]);
  const targetLinks = asRecord(target?.["links"]);
  const html = asRecord(targetLinks?.["html"]);
  const referenceType = requiredString(reference?.["type"]);
  const referenceName = requiredString(reference?.["name"]);
  const commitSha = requiredString(target?.["hash"]);
  const commitMessage = requiredString(target?.["message"]) ?? "VCS push";
  const commitUrl = requiredString(html?.["href"]);
  if (validateBitbucketPushFields(referenceType, referenceName, commitSha, commitUrl) !== undefined) return undefined;
  if ((referenceType !== "branch" && referenceType !== "tag") || referenceName === undefined || commitSha === undefined || commitUrl === undefined) return undefined;
  return {
    kind: "push",
    details: {
      ...(referenceType === "branch" ? { branch: referenceName } : { tag: referenceName }),
      cloneUrl,
      commitMessage,
      commitSha,
      commitUrl,
      filesChanged: new Set<string>(),
      repoFullName,
      senderUsername,
      sourceIdentity,
    },
  };
}

function parseBitbucketPushWebhooks(
  payload: WebhookPayload,
  repoFullName: string,
  cloneUrl: string,
  senderUsername: string,
  sourceIdentity: VcsSourceIdentity,
): readonly ParsedProviderWebhook[] {
  const changes = extractBitbucketChanges(payload);
  if (changes === undefined) return [];
  const parsed: ParsedProviderWebhook[] = [];
  for (const change of changes) {
    const parsedChange = parseBitbucketPushChange(change, repoFullName, cloneUrl, senderUsername, sourceIdentity);
    if (parsedChange !== undefined) parsed.push(parsedChange);
  }
  return parsed;
}

function validateBitbucketPrFields(branch: string | undefined, commitSha: string | undefined, commitUrl: string | undefined, pullRequestNumber: unknown): string | undefined {
  if (branch === undefined) return "branch";
  if (commitSha === undefined) return "commitSha";
  if (commitUrl === undefined) return "commitUrl";
  if (typeof pullRequestNumber !== "number") return "pullRequestNumber";
  if (!Number.isSafeInteger(pullRequestNumber)) return "pullRequestNumber";
  return undefined;
}

function resolveBitbucketPrCommitUrl(pullRequest: Readonly<Record<string, unknown>> | undefined, commit: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const prLinks = asRecord(pullRequest?.["links"]);
  const prHtml = asRecord(prLinks?.["html"]);
  const fromPr = requiredString(prHtml?.["href"]);
  if (fromPr !== undefined) return fromPr;
  const commitLinks = asRecord(commit?.["links"]);
  const commitHtml = asRecord(commitLinks?.["html"]);
  return requiredString(commitHtml?.["href"]);
}

function parseBitbucketPullRequestWebhook(payload: WebhookPayload, repoFullName: string, cloneUrl: string, senderUsername: string, sourceIdentity: VcsSourceIdentity): ParsedProviderWebhook | undefined {
  const pullRequest = asRecord(payload["pullrequest"]);
  const source = asRecord(pullRequest?.["source"]);
  const destination = asRecord(pullRequest?.["destination"]);
  const branchValue = asRecord(source?.["branch"]);
  const destinationBranch = asRecord(destination?.["branch"]);
  const commit = asRecord(source?.["commit"]);
  const branch = requiredString(branchValue?.["name"]);
  const targetBranch = requiredString(destinationBranch?.["name"]);
  const commitSha = requiredString(commit?.["hash"]);
  const commitMessage = requiredString(pullRequest?.["title"]) ?? "Pull request";
  const commitUrl = resolveBitbucketPrCommitUrl(pullRequest, commit);
  const pullRequestNumber = pullRequest?.["id"];
  if (validateBitbucketPrFields(branch, commitSha, commitUrl, pullRequestNumber) !== undefined) return undefined;
  if (branch === undefined || commitSha === undefined || commitUrl === undefined || typeof pullRequestNumber !== "number" || !Number.isSafeInteger(pullRequestNumber)) return undefined;
  return {
    kind: "pull_request",
    details: {
      branch,
      ...(targetBranch === undefined ? {} : { targetBranch }),
      cloneUrl,
      commitMessage,
      commitSha,
      commitUrl,
      filesChanged: new Set<string>(),
      pullRequestNumber,
      repoFullName,
      senderUsername,
      sourceIdentity,
    },
  };
}

function parseWebhook(eventName: string, payload: WebhookPayload): WebhookDetails | undefined {
  const repository = asRecord(payload["repository"]);
  const sender = asRecord(payload["sender"]);
  const deliveryInstallationId = extractDeliveryInstallationId(payload);
  const repoFullName = requiredString(repository?.["full_name"]);
  const cloneUrl = requiredString(repository?.["clone_url"]);
  const senderUsername = requiredString(sender?.["login"]);
  const senderAvatarUrl = httpsUrl(sender?.["avatar_url"]);
  if (repoFullName === undefined) return undefined;
  if (cloneUrl === undefined) return undefined;
  if (senderUsername === undefined) return undefined;
  const sourceIdentity = vcsSourceIdentity("github", cloneUrl, deliveryInstallationId);
  if (sourceIdentity === undefined) return undefined;
  const base = { cloneUrl, repoFullName, senderUsername, senderAvatarUrl, deliveryInstallationId, sourceIdentity };
  if (eventName === "push") return parseGithubPushWebhook(payload, base);
  if (eventName === "pull_request" && (payload["action"] === "opened" || payload["action"] === "synchronize" || payload["action"] === "reopened")) return parseGithubPullRequestWebhook(payload, base);
  return undefined;
}

function gitlabWebhook(eventName: string, payload: WebhookPayload): ParsedProviderWebhook | undefined {
  const project = asRecord(payload["project"]);
  const user = asRecord(payload["user"]);
  const repoFullName = requiredString(project?.["path_with_namespace"]);
  const cloneUrl = requiredString(project?.["git_http_url"]) ?? requiredString(project?.["web_url"]);
  const senderUsername = requiredString(payload["user_username"]) ?? requiredString(user?.["username"]) ?? requiredString(payload["user_name"]);
  if (repoFullName === undefined) return undefined;
  if (cloneUrl === undefined) return undefined;
  if (senderUsername === undefined) return undefined;
  const sourceIdentity = vcsSourceIdentity("gitlab", cloneUrl);
  if (sourceIdentity === undefined) return undefined;
  if (eventName === "Push Hook" || eventName === "Tag Push Hook") return parseGitlabPushWebhook(payload, project, repoFullName, cloneUrl, senderUsername, sourceIdentity);
  if (eventName === "Merge Request Hook") return parseGitlabMergeRequestWebhook(payload, repoFullName, cloneUrl, senderUsername, sourceIdentity);
  return undefined;
}

function bitbucketCloneUrl(repository: Readonly<Record<string, unknown>>): string | undefined {
  const links = asRecord(repository["links"]);
  const cloneLinks = links?.["clone"];
  if (!Array.isArray(cloneLinks)) return undefined;
  for (const value of cloneLinks) {
    const link = asRecord(value);
    if (link?.["name"] === "https") return requiredString(link["href"]);
  }
  return undefined;
}

function bitbucketWebhook(eventName: string, payload: WebhookPayload): readonly ParsedProviderWebhook[] | undefined {
  const repository = asRecord(payload["repository"]);
  const actor = asRecord(payload["actor"]);
  const repoFullName = requiredString(repository?.["full_name"]);
  const cloneUrl = repository === undefined ? undefined : bitbucketCloneUrl(repository);
  const senderUsername = requiredString(actor?.["username"]) ?? requiredString(actor?.["nickname"]) ?? requiredString(actor?.["display_name"]);
  if (repoFullName === undefined) return undefined;
  if (cloneUrl === undefined) return undefined;
  if (senderUsername === undefined) return undefined;
  const sourceIdentity = vcsSourceIdentity("bitbucket", cloneUrl);
  if (sourceIdentity === undefined) return undefined;
  if (eventName === "repo:push") return parseBitbucketPushWebhooks(payload, repoFullName, cloneUrl, senderUsername, sourceIdentity);
  if (eventName === "pullrequest:created" || eventName === "pullrequest:updated") {
    const parsed = parseBitbucketPullRequestWebhook(payload, repoFullName, cloneUrl, senderUsername, sourceIdentity);
    return parsed === undefined ? undefined : [parsed];
  }
  return undefined;
}

function matchesTag(vcsRepo: DeepReadonly<VcsRepo>, tag: string): boolean {
  const pattern = vcsRepo.tagsRegex;
  if (typeof pattern !== "string" || pattern === "" || pattern.length > 256 || tag.length > 256) return false;
  try {
    return new RegExp(pattern).test(tag);
  } catch {
    return false;
  }
}

function matchesFileTriggers(workspace: DeepReadonly<typeof workspaces.$inferSelect>, files: Readonly<ReadonlySet<string>>): boolean {
  if (workspace.fileTriggersEnabled !== true || files.size === 0) return true;
  const patterns = Array.isArray(workspace.triggerPatterns)
    ? workspace.triggerPatterns.filter((pattern: string): boolean => pattern !== "")
    : [];
  if (patterns.length > 0) {
    return patterns.some((pattern: string): boolean => {
      try {
        const glob = new Bun.Glob(pattern.replace(/^\/+/, ""));
        return [...files].some((file: string): boolean => glob.match(file));
      } catch {
        return false;
      }
    });
  }
  const workingDirectory = workspace.workingDirectory?.replace(/^\/|\/$/g, "") ?? "";
  const prefixes = Array.isArray(workspace.triggerPrefixes)
    ? workspace.triggerPrefixes
      .map((prefix: string): string => prefix.replace(/^\/|\/$/g, ""))
      .filter((prefix: string): boolean => prefix !== "")
    : [];
  const paths = prefixes.length > 0
    ? prefixes.map((prefix: string): string => workingDirectory === "" ? prefix : `${workingDirectory}/${prefix}`)
    : [workingDirectory];
  return paths.includes("") || [...files].some((file: string): boolean => paths.some((path: string): boolean => file === path || file.startsWith(`${path}/`)));
}

export type GitHubAppAccessTokenDetails = Readonly<{
  permissions: Readonly<Record<string, string>> | null;
  token: string;
}>;

export async function getGitHubAppAccessTokenDetails(installationId: number): Promise<GitHubAppAccessTokenDetails | null> {
  const appId = process.env["GITHUB_APP_ID"];
  const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
  if (appId === undefined || privateKey === undefined || appId === "" || privateKey === "") {
    console.error("[terrence] GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured.");
    return null;
  }

  try {
    const key = privateKey.replace(/\\n/g, "\n");
    const token = jwt.sign({
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + (10 * 60),
      iss: appId,
    }, key, { algorithm: "RS256" });
    const apiUrl = githubAppApiUrl();
    if (apiUrl === undefined) return null;
    const response = await fetchVcsUrl(`${apiUrl}/app/installations/${String(installationId)}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Terrence",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      console.error("[terrence] Failed to fetch access token:", await response.text());
      return null;
    }
    const data = await response.json() as { permissions?: unknown; token?: unknown };
    const tokenValue = requiredString(data.token);
    if (tokenValue === undefined) return null;
    const rawPermissions = asRecord(data.permissions);
    const permissions = rawPermissions === undefined
      ? null
      : Object.fromEntries(Object.entries(rawPermissions).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return { permissions, token: tokenValue };
  } catch (error) {
    console.error("[terrence] Exception creating GitHub access token:", error);
    return null;
  }
}

export async function getGitHubAppAccessToken(installationId: number): Promise<string | null> {
  const details = await getGitHubAppAccessTokenDetails(installationId);
  return details?.token ?? null;
}

/**
 * Resolve the source configured for a workspace without decrypting its token.
 * An unresolved reference deliberately returns undefined so stale or
 * cross-organization configurations cannot match an incoming webhook.
 */
async function configuredVcsSource(
  workspace: DeepReadonly<VcsCredentialSubject>,
): Promise<VcsSourceIdentity | undefined> {
  const vcs = workspace.vcsRepo;
  if (vcs?.githubAppInstallationId !== undefined && vcs.githubAppInstallationId !== "") {
    return sourceIdentityForConnection(workspace.orgId, "github-app", vcs.githubAppInstallationId);
  }
  const tokenId = vcs?.oauthTokenId;
  if (tokenId === undefined || tokenId === "") return undefined;
  return sourceIdentityForConnection(workspace.orgId, "oauth-token", tokenId);
}

async function matchesGithubAppInstallation(
  workspace: DeepReadonly<VcsCredentialSubject>,
  deliveryInstallationId: number,
): Promise<boolean> {
  const installationReference = workspace.vcsRepo?.githubAppInstallationId;
  if (installationReference === undefined || installationReference === "") return true;
  const installation = await db.query.githubAppInstallations.findFirst({
    where: and(
      eq(githubAppInstallations.id, installationReference),
      eq(githubAppInstallations.orgId, workspace.orgId),
      eq(githubAppInstallations.installationId, deliveryInstallationId),
    ),
    columns: { id: true },
  });
  return installation !== undefined;
}

function providerApiUrl(value: string | null, fallback: string, requireHttps = false): string | undefined {
  try {
    const url = new URL(value === null || value === "" ? fallback : value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || (requireHttps && url.protocol !== "https:")) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function githubAppApiUrl(): string | undefined {
  return githubAppApiBase(true);
}

async function oauthProviderCredentials(
  workspace: DeepReadonly<VcsCredentialSubject>,
  provider: VcsProvider,
): Promise<ProviderCredentials | undefined> {
  const tokenId = workspace.vcsRepo?.oauthTokenId;
  if (tokenId === undefined || tokenId === "") return undefined;
  const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) });
  if (token === undefined) return undefined;
  const client = await db.query.oauthClients.findFirst({
    where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, workspace.orgId)),
  });
  if (client === undefined || providerForServiceProvider(client.serviceProvider) !== provider) return undefined;
  const apiUrl = providerApiUrl(
    client.apiUrl,
    provider === "github"
      ? "https://api.github.com"
      : provider === "gitlab"
        ? "https://gitlab.com/api/v4"
        : "https://api.bitbucket.org/2.0",
  );
  if (apiUrl === undefined) return undefined;
  try {
    return { apiUrl, provider, token: await decryptSecret(token.token), oauthClientId: client.id };
  } catch {
    return undefined;
  }
}

async function githubCredentials(
  workspace: DeepReadonly<VcsCredentialSubject>,
  // The cache is intentionally mutated while processing one webhook event.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  installationTokens?: Map<string, string | null>,
): Promise<ProviderCredentials | undefined> {
  const installationReference = workspace.vcsRepo?.githubAppInstallationId;
  if (installationReference !== undefined && installationReference !== "") {
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.id, installationReference),
        eq(githubAppInstallations.orgId, workspace.orgId),
      ),
    });
    if (installation !== undefined) {
      const installationKey = `${workspace.orgId}:${installationReference}`;
      let token: string | null;
      if (installationTokens?.has(installationKey) === true) {
        token = installationTokens.get(installationKey) ?? null;
      } else {
        token = await getGitHubAppAccessToken(installation.installationId);
        installationTokens?.set(installationKey, token);
      }
      const apiUrl = githubAppApiUrl();
      if (token !== null && apiUrl !== undefined) return { apiUrl, provider: "github", token };
    }
  }
  return oauthProviderCredentials(workspace, "github");
}

function vcsStatus(runStatus: string): "pending" | "success" | "failure" | undefined {
  if ([
    "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
    "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated", "policy_checking",
    "post_plan_running", "post_plan_completed", "confirmed", "apply_queued", "applying",
  ].includes(runStatus)) return "pending";
  if (["policy_checked", "planned", "planned_and_finished", "planned_and_saved", "applied"].includes(runStatus)) return "success";
  if (["policy_override", "policy_soft_failed", "errored", "canceled", "force_canceled", "discarded", "unreachable"].includes(runStatus)) return "failure";
  return undefined;
}

function validRepository(repoFullName: string, provider: VcsProvider): boolean {
  const parts = repoFullName.split("/");
  return parts.length >= 2
    && (provider === "gitlab" || parts.length === 2)
    && parts.every((part: string): boolean => REPOSITORY_PATTERN.test(part));
}


function extractGithubPrFilenames(body: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(body)) return undefined;
  const files = new Set<string>();
  for (const item of body) {
    const filename = asRecord(item)?.["filename"];
    if (typeof filename !== "string" || filename === "") return undefined;
    files.add(filename);
  }
  return files;
}

function githubNextPageUrl(headers: Headers, baseUrl: string): string | null | undefined {
  const link = headers.get("link");
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel=["']?next["']?/iu.exec(part);
    if (match?.[1] === undefined) continue;
    try {
      const base = new URL(baseUrl);
      const next = new URL(match[1], base);
      if (next.origin !== base.origin || next.username !== "" || next.password !== "" || next.hash !== "") return undefined;
      return next.toString();
    } catch {
      return undefined;
    }
  }
  return null;
}

const MAX_GITHUB_PR_FILE_PAGES = 10;

async function fetchGithubPrFilesPage(credentials: ProviderCredentials, repoFullName: string, pullRequestNumber: number): Promise<ReadonlySet<string> | undefined> {
  let url = `${credentials.apiUrl}/repos/${repoFullName.split("/").map(encodeURIComponent).join("/")}/pulls/${String(pullRequestNumber)}/files?per_page=100`;
  const visited = new Set<string>();
  const files = new Set<string>();
  for (let page = 0; page < MAX_GITHUB_PR_FILE_PAGES; page += 1) {
    if (visited.has(url)) return undefined;
    visited.add(url);
    const response = await fetchVcsUrl(url, {
      headers: { Authorization: `Bearer ${credentials.token}`, Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return undefined;
    const pageFiles = extractGithubPrFilenames(await response.json() as unknown);
    if (pageFiles === undefined) return undefined;
    for (const file of pageFiles) files.add(file);
    const next = githubNextPageUrl(response.headers, credentials.apiUrl);
    if (next === undefined) return undefined;
    if (next === null) return files;
    url = next;
  }
  // A capped response is incomplete and must fail open for file triggers.
  return undefined;
}

async function githubPullRequestFiles(
  candidates: readonly DeepReadonly<typeof workspaces.$inferSelect>[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: Readonly<WebhookDetails>,
  // The cache is intentionally mutated while processing one webhook event.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  installationTokens?: Map<string, string | null>,
): Promise<ReadonlySet<string> | undefined> {
  if (candidates.length === 0) return undefined;
  if (details.pullRequestNumber === undefined) return undefined;
  if (!validRepository(details.repoFullName, "github")) return undefined;
  for (const workspace of candidates) {
    try {
      const credentials = await githubCredentials(workspace, installationTokens);
      if (credentials === undefined) continue;
      const files = await fetchGithubPrFilesPage(credentials, details.repoFullName, details.pullRequestNumber);
      if (files !== undefined) return files;
    } catch {
      // Try the next matching workspace's credentials before failing open.
    }
  }
  return undefined;
}


// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- file collection is intentionally accumulated in the caller-owned set
function extractGitlabMrFiles(body: unknown, files: Set<string>): boolean {
  if (!Array.isArray(body)) return false;
  for (const item of body) {
    const change = asRecord(item);
    if (change?.["too_large"] === true) return false;
    const oldPath = change?.["old_path"];
    const newPath = change?.["new_path"];
    const oldFile = typeof oldPath === "string" && oldPath !== "" ? oldPath : undefined;
    const newFile = typeof newPath === "string" && newPath !== "" ? newPath : undefined;
    if (oldFile === undefined && newFile === undefined) return false;
    if (oldFile !== undefined) files.add(oldFile);
    if (newFile !== undefined) files.add(newFile);
  }
  return true;
}

function gitlabNextPage(value: string | null): number | null | undefined {
  if (value === null || value.trim() === "") return null;
  if (!/^\d+$/u.test(value.trim())) return undefined;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

async function fetchGitlabMrFilesPage(credentials: ProviderCredentials, repoFullName: string, pullRequestNumber: number, page: number): Promise<{ files: Set<string>; nextPage: string | null } | undefined> {
  const response = await fetchVcsUrl(
    `${credentials.apiUrl}/projects/${encodeURIComponent(repoFullName)}/merge_requests/${String(pullRequestNumber)}/diffs?per_page=100&page=${page}`,
    {
      headers: { Authorization: `Bearer ${credentials.token}`, Accept: "application/json" },
    },
  );
  if (!response.ok) return undefined;
  const body = await response.json() as unknown;
  const files = new Set<string>();
  if (!extractGitlabMrFiles(body, files)) return undefined;
  let nextPage = response.headers.get("x-next-page");
  if (nextPage !== null && nextPage.trim() === "") nextPage = null;
  return { files, nextPage };
}

async function gitlabMergeRequestFiles(
  workspace: DeepReadonly<typeof workspaces.$inferSelect> | undefined,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: Readonly<WebhookDetails>,
): Promise<ReadonlySet<string> | undefined> {
  if (workspace === undefined) return undefined;
  if (details.pullRequestNumber === undefined) return undefined;
  if (!validRepository(details.repoFullName, "gitlab")) return undefined;
  try {
    const credentials = await oauthProviderCredentials(workspace, "gitlab");
    if (credentials === undefined) return undefined;
    const files = new Set<string>();
    const visitedPages = new Set<number>();
    const MAX_PAGES = 10;
    let page = 1;
    let nextPage: number | null | undefined = 1;
    let requests = 0;
    while (nextPage !== null && nextPage !== undefined && requests < MAX_PAGES) {
      page = nextPage;
      if (visitedPages.has(page)) return undefined;
      visitedPages.add(page);
      const pageResult = await fetchGitlabMrFilesPage(credentials, details.repoFullName, details.pullRequestNumber, page);
      if (pageResult === undefined) return undefined;
      for (const file of pageResult.files) files.add(file);
      nextPage = gitlabNextPage(pageResult.nextPage);
      requests += 1;
    }
    if (nextPage !== null) return undefined;
    return files;
  } catch {
    return undefined;
  }
}

type BitbucketCloudDiffstatResult = Readonly<{
  files: ReadonlySet<string> | undefined;
  receivedPage: boolean;
}>;


// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- file collection is intentionally accumulated in the caller-owned set
function extractBitbucketDiffstatPaths(body: unknown, files: Set<string>): boolean {
  const values = asRecord(body)?.["values"];
  if (!Array.isArray(values)) return false;
  for (const item of values) {
    const entry = asRecord(item);
    const path = asRecord(entry?.["new"])?.["path"] ?? asRecord(entry?.["old"])?.["path"];
    if (typeof path !== "string" || path === "") return false;
    files.add(path);
  }
  return true;
}

export function resolveBitbucketNextUrl(body: unknown, baseUrl: string): string | null | undefined {
  const next = asRecord(body)?.["next"];
  if (next === undefined || next === null || next === "") return null;
  if (typeof next !== "string") return undefined;
  try {
    const nextUrl = new URL(next);
    return nextUrl.origin === new URL(baseUrl).origin ? nextUrl.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function bitbucketCloudDiffstatFiles(
  initialUrl: string,
  auth: Readonly<Record<string, string>>,
): Promise<BitbucketCloudDiffstatResult> {
  const files = new Set<string>();
  let cloudUrl: string | null = initialUrl;
  let receivedPage = false;
  const MAX_PAGES = 10;
  for (let page = 1; cloudUrl !== null && page <= MAX_PAGES; page += 1) {
    const response = await fetchVcsUrl(cloudUrl, { headers: auth });
    if (!response.ok) return { files: undefined, receivedPage };
    receivedPage = true;
    const body = await response.json() as unknown;
    if (!extractBitbucketDiffstatPaths(body, files)) return { files: undefined, receivedPage };
    const next = resolveBitbucketNextUrl(body, initialUrl);
    if (next === undefined) return { files: undefined, receivedPage };
    cloudUrl = next;
    if (cloudUrl === null) return { files, receivedPage };
  }
  return { files: undefined, receivedPage };
}

async function bitbucketCommitFiles(
  workspace: DeepReadonly<typeof workspaces.$inferSelect> | undefined,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: Readonly<WebhookDetails>,
): Promise<ReadonlySet<string> | undefined> {
  if (workspace === undefined || !validRepository(details.repoFullName, "bitbucket") || !COMMIT_SHA_PATTERN.test(details.commitSha)) return undefined;
  try {
    const credentials = await oauthProviderCredentials(workspace, "bitbucket");
    if (credentials === undefined) return undefined;
    const [owner, repo] = details.repoFullName.split("/");
    const auth = { Authorization: `Bearer ${credentials.token}`, Accept: "application/json" };
    const cloudUrl = `${credentials.apiUrl}/repositories/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}/diffstat/${encodeURIComponent(details.commitSha)}?pagelen=100`;
    return (await bitbucketCloudDiffstatFiles(cloudUrl, auth)).files;
  } catch {
    return undefined;
  }
}

function bitbucketDataCenterPath(item: unknown): string | undefined {
  const path = asRecord(item)?.["path"];
  const pathRecord = asRecord(path);
  const pathValue = pathRecord === undefined ? undefined : Reflect.get(pathRecord, "toString");
  return typeof pathValue === "string"
    ? pathValue
    : typeof path === "string" ? path : undefined;
}

async function bitbucketDataCenterPullRequestFiles(
  apiUrl: string,
  owner: string | undefined,
  repo: string | undefined,
  pullRequestNumber: number,
  auth: Readonly<Record<string, string>>,
): Promise<ReadonlySet<string> | undefined> {
  const files = new Set<string>();
  const encodedOwner = encodeURIComponent(owner ?? "");
  const encodedRepo = encodeURIComponent(repo ?? "");
  const pullRequest = String(pullRequestNumber);
  let dcUrl: string | null = `${apiUrl}/rest/api/1.0/projects/${encodedOwner}/repos/${encodedRepo}/pull-requests/${pullRequest}/changes?limit=100`;
  for (let page = 1; dcUrl !== null && page <= 10; page += 1) {
    const dcResponse = await fetchVcsUrl(dcUrl, { headers: auth });
    if (!dcResponse.ok) return undefined;
    const dcBody = await dcResponse.json() as unknown;
    const dcValues = asRecord(dcBody)?.["values"];
    if (!Array.isArray(dcValues)) return undefined;
    for (const item of dcValues) {
      const pathName = bitbucketDataCenterPath(item);
      if (typeof pathName !== "string" || pathName === "") return undefined;
      files.add(pathName);
    }
    const nextStart = asRecord(dcBody)?.["nextPageStart"];
    dcUrl = typeof nextStart === "number" && Number.isFinite(nextStart)
      ? `${apiUrl}/rest/api/1.0/projects/${encodedOwner}/repos/${encodedRepo}/pull-requests/${pullRequest}/changes?limit=100&start=${nextStart}`
      : null;
  }
  // A partial Data Center response is unsafe for file triggers.
  if (dcUrl !== null) return undefined;
  return files;
}

async function bitbucketPullRequestFiles(
  workspace: DeepReadonly<typeof workspaces.$inferSelect> | undefined,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: Readonly<WebhookDetails>,
): Promise<ReadonlySet<string> | undefined> {
  if (workspace === undefined || details.pullRequestNumber === undefined || !validRepository(details.repoFullName, "bitbucket")) return undefined;
  try {
    const credentials = await oauthProviderCredentials(workspace, "bitbucket");
    if (credentials === undefined) return undefined;
    const [owner, repo] = details.repoFullName.split("/");
    const auth = { Authorization: `Bearer ${credentials.token}`, Accept: "application/json" };
    // Bitbucket Cloud diffstat: values[].new.path (new.path absent for
    // deleted files; fall back to old.path so deletions still filter).
    const cloudUrl = `${credentials.apiUrl}/repositories/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}/pullrequests/${String(details.pullRequestNumber)}/diffstat?pagelen=100`;
    const cloudResult = await bitbucketCloudDiffstatFiles(cloudUrl, auth);
    if (cloudResult.files !== undefined) return cloudResult.files;
    // A first-page Cloud failure falls through to the Data Center endpoint;
    // partial or capped Cloud results remain unknown and fail open.
    if (cloudResult.receivedPage) return undefined;

    // Bitbucket Data Center: changes endpoint with path.toString entries.
    return await bitbucketDataCenterPullRequestFiles(credentials.apiUrl, owner, repo, details.pullRequestNumber, auth);
  } catch {
    return undefined;
  }
}

async function reportUntriggeredSpeculativeStatus(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: Readonly<WebhookDetails>,
  // The cache is intentionally mutated while processing one webhook event.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  installationTokens?: Map<string, string | null>,
): Promise<void> {
  try {
    const organization = await db.query.organizations.findFirst({
      where: eq(organizations.id, workspace.orgId),
      columns: { name: true, aggregatedCommitStatusEnabled: true, sendPassingStatusesForUntriggeredSpeculativePlans: true },
    });
    if (organization?.aggregatedCommitStatusEnabled !== false || organization.sendPassingStatusesForUntriggeredSpeculativePlans !== true) return;
    if (!validRepository(details.repoFullName, "github") || !COMMIT_SHA_PATTERN.test(details.commitSha)) return;
    const credentials = await githubCredentials(workspace, installationTokens);
    if (credentials === undefined) return;
    const response = await fetchVcsUrl(
      `${credentials.apiUrl}/repos/${details.repoFullName.split("/").map(encodeURIComponent).join("/")}/statuses/${encodeURIComponent(details.commitSha)}`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: "success",
          context: `terrence/${workspace.name}`.slice(0, 100),
          description: "No Terraform changes matched this workspace",
          target_url: details.commitUrl,
        }),
        },
    );
    if (!response.ok) console.error(`[terrence] Failed to report passing GitHub status for workspace ${workspace.id}: ${String(response.status)}`);
  } catch (error) {
    console.error(`[terrence] Failed to report passing GitHub status for workspace ${workspace.id}:`, error);
  }
}

type VcsCommitState = "pending" | "success" | "failure";

type RunVcsStatusContext = Readonly<{
  runId: string;
  workspace: DeepReadonly<typeof workspaces.$inferSelect>;
  repoFullName: string;
  commitSha: string;
  provider: VcsProvider;
  credentials: ProviderCredentials;
  baseContext: string;
  organization: Readonly<{ name: string; aggregatedCommitStatusEnabled: boolean | null }> | undefined;
  targetUrl: string | undefined;
}>;

type GithubStatusDetails = Readonly<{
  state: VcsCommitState;
  context: string;
  description: string;
}>;

function vcsProviderFromSource(source: string | null): VcsProvider | undefined {
  if (source === "github" || source === "gitlab" || source === "bitbucket") return source;
  return undefined;
}

type RunVcsStatusRecords = Readonly<{
  workspace: DeepReadonly<typeof workspaces.$inferSelect> | undefined;
  configuration: DeepReadonly<typeof configurationVersions.$inferSelect> | undefined;
}>;

type RunVcsStatusTarget = Readonly<{
  workspace: DeepReadonly<typeof workspaces.$inferSelect>;
  repoFullName: string;
  commitSha: string;
  provider: VcsProvider;
}>;

async function loadRunVcsStatusRecords(runId: string): Promise<RunVcsStatusRecords | undefined> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (run?.configurationVersionId === null || run?.configurationVersionId === undefined) return undefined;
  const [workspace, configuration] = await Promise.all([
    db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) }),
    db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, run.configurationVersionId) }),
  ]);
  return { workspace, configuration };
}

function runVcsStatusTarget(records: DeepReadonly<RunVcsStatusRecords>): RunVcsStatusTarget | undefined {
  const repoFullName = records.workspace?.vcsRepo?.identifier;
  const commitSha = records.configuration?.ingressAttributes?.commitSha;
  if (records.workspace === undefined || records.configuration === undefined || typeof repoFullName !== "string" || typeof commitSha !== "string") return undefined;
  const provider = vcsProviderFromSource(records.configuration.source);
  if (provider === undefined || !validRepository(repoFullName, provider) || !COMMIT_SHA_PATTERN.test(commitSha)) return undefined;
  return { workspace: records.workspace, repoFullName, commitSha, provider };
}

async function runVcsStatusCredentials(target: RunVcsStatusTarget): Promise<ProviderCredentials | undefined> {
  return target.provider === "github"
    ? githubCredentials(target.workspace)
    : oauthProviderCredentials(target.workspace, target.provider);
}

function runVcsStatusTargetUrl(
  runId: string,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  organization: Readonly<{ name: string }> | undefined,
): string | undefined {
  const publicUrl = process.env["PUBLIC_URL"]?.replace(/\/$/, "");
  return publicUrl === undefined || organization === undefined
    ? undefined
    : `${publicUrl}/app/${encodeURIComponent(organization.name)}/workspaces/${encodeURIComponent(workspace.name)}/runs/${encodeURIComponent(runId)}`;
}

async function loadRunVcsStatusContext(runId: string): Promise<RunVcsStatusContext | undefined> {
  const records = await loadRunVcsStatusRecords(runId);
  if (records === undefined) return undefined;
  const target = runVcsStatusTarget(records);
  if (target === undefined) return undefined;
  const credentials = await runVcsStatusCredentials(target);
  if (credentials === undefined) return undefined;
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.id, target.workspace.orgId),
    columns: { name: true, aggregatedCommitStatusEnabled: true },
  });
  const baseContext = `terrence/${target.workspace.name}`.slice(0, 100);
  const targetUrl = runVcsStatusTargetUrl(runId, target.workspace, organization);
  return { runId, ...target, credentials, baseContext, organization, targetUrl };
}

async function githubRunsForCommit(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  repoFullName: string,
  commitSha: string,
): Promise<readonly DeepReadonly<typeof runs.$inferSelect>[]> {
  const relatedWorkspaces = await db.query.workspaces.findMany({
    where: and(
      eq(workspaces.orgId, workspace.orgId),
      sql`${jsonExtract(workspaces.vcsRepo, '$.identifier')} = ${repoFullName}`,
    ),
  });
  const relatedWorkspaceIds = relatedWorkspaces.map((candidate): string => candidate.id);
  if (relatedWorkspaceIds.length === 0) return [];
  const relatedRuns = await db.query.runs.findMany({ where: inArray(runs.workspaceId, relatedWorkspaceIds) });
  const configurationIds = relatedRuns
    .map((relatedRun): string | null => relatedRun.configurationVersionId)
    .filter((id): id is string => id !== null);
  if (configurationIds.length === 0) return [];
  const relatedConfigurations = await db.query.configurationVersions.findMany({ where: inArray(configurationVersions.id, configurationIds) });
  const configurationsById = new Map(relatedConfigurations.map((item): [string, typeof item] => [item.id, item]));
  return relatedRuns.filter((relatedRun): boolean => {
    const configuration = configurationsById.get(relatedRun.configurationVersionId ?? "");
    return configuration?.source === "github" && configuration.ingressAttributes?.commitSha === commitSha;
  });
}

function latestGithubRunsByWorkspace(
  relatedRuns: readonly DeepReadonly<typeof runs.$inferSelect>[],
): readonly DeepReadonly<typeof runs.$inferSelect>[] {
  const latestPerWorkspace = new Map<string, DeepReadonly<typeof runs.$inferSelect>>();
  for (const candidate of [...relatedRuns].sort((a, b): number => b.createdAt - a.createdAt)) {
    if (!latestPerWorkspace.has(candidate.workspaceId)) latestPerWorkspace.set(candidate.workspaceId, candidate);
  }
  return [...latestPerWorkspace.values()];
}

async function aggregatedGithubStatus(context: RunVcsStatusContext, initialState: VcsCommitState, runStatus: string): Promise<GithubStatusDetails> {
  const base = { state: initialState, context: context.baseContext, description: `Terraform run ${runStatus}` };
  if (context.organization?.aggregatedCommitStatusEnabled === false) return base;
  const relatedRuns = latestGithubRunsByWorkspace(await githubRunsForCommit(context.workspace, context.repoFullName, context.commitSha));
  const relatedStates = relatedRuns
    .filter((relatedRun): boolean => !(["discarded", "canceled", "force_canceled"] as readonly string[]).includes(relatedRun.status))
    .map((relatedRun): VcsCommitState | undefined => vcsStatus(relatedRun.status))
    .filter((value): value is VcsCommitState => value !== undefined);
  const aggregateState: VcsCommitState = relatedStates.some((value): boolean => value === "failure")
    ? "failure"
    : relatedStates.length > 0 && relatedStates.every((value): boolean => value === "success")
      ? "success"
      : "pending";
  return {
    state: aggregateState,
    context: "terrence",
    description: `${relatedStates.length} workspace run${relatedStates.length === 1 ? "" : "s"}: ${aggregateState}`,
  };
}

async function postGithubStatus(context: RunVcsStatusContext, status: GithubStatusDetails): Promise<Response> {
  const url = `${context.credentials.apiUrl}/repos/${context.repoFullName.split("/").map(encodeURIComponent).join("/")}/statuses/${encodeURIComponent(context.commitSha)}`;
  return fetchVcsUrl(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + context.credentials.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state: status.state, context: status.context, description: status.description, ...(context.targetUrl === undefined ? {} : { target_url: context.targetUrl }) }),
  });
}

async function postGitlabStatus(context: RunVcsStatusContext, state: VcsCommitState): Promise<Response> {
  return fetchVcsUrl(
    `${context.credentials.apiUrl}/projects/${encodeURIComponent(context.repoFullName)}/statuses/${encodeURIComponent(context.commitSha)}`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + context.credentials.token,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        state: state === "failure" ? "failed" : state,
        name: context.baseContext,
      }).toString(),
    },
  );
}

async function postBitbucketStatus(context: RunVcsStatusContext, state: VcsCommitState, runStatus: string): Promise<Response> {
  const bitbucketState = state === "pending" ? "INPROGRESS" : state === "success" ? "SUCCESSFUL" : "FAILED";
  return fetchVcsUrl(
    `${context.credentials.apiUrl}/repositories/${context.repoFullName.split("/").map(encodeURIComponent).join("/")}/commit/${encodeURIComponent(context.commitSha)}/statuses/build`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + context.credentials.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: bitbucketState,
        key: `terrence-${context.runId}`.slice(0, 40),
        name: context.baseContext,
        description: `Terraform run ${runStatus}`,
      }),
    },
  );
}

async function postVcsStatus(context: RunVcsStatusContext, status: GithubStatusDetails, runStatus: string): Promise<Response> {
  if (context.provider === "github") return postGithubStatus(context, status);
  if (context.provider === "gitlab") return postGitlabStatus(context, status.state);
  return postBitbucketStatus(context, status.state, runStatus);
}

export async function reportRunVcsStatus(runId: string, runStatus: string): Promise<void> {
  const initialState = vcsStatus(runStatus);
  if (initialState === undefined) return;
  try {
    const context = await loadRunVcsStatusContext(runId);
    if (context === undefined) return;
    const status = context.provider === "github"
      ? await aggregatedGithubStatus(context, initialState, runStatus)
      : { state: initialState, context: context.baseContext, description: `Terraform run ${runStatus}` };
    const response = await postVcsStatus(context, status, runStatus);
    if (!response.ok) {
      console.error(`[terrence] Failed to report ${context.provider} commit status for run ${runId}: ${String(response.status)}`);
    }
  } catch (error) {
    console.error(`[terrence] Failed to report VCS commit status for run ${runId}:`, error);
  }
}


function validateRefetchConfiguration(workspace: DeepReadonly<typeof workspaces.$inferSelect> | undefined, repoFullName: string | undefined, commitSha: string | undefined, provider: VcsProvider | undefined): string | undefined {
  if (workspace === undefined) return "workspace";
  if (repoFullName === undefined) return "repoFullName";
  if (commitSha === undefined) return "commitSha";
  if (provider === undefined) return "provider";
  if (!validRepository(repoFullName, provider)) return "repoFullName";
  if (!COMMIT_SHA_PATTERN.test(commitSha)) return "commitSha";
  return undefined;
}

function resolveRefetchProvider(source: string | null | undefined): VcsProvider | undefined {
  if (source === "github" || source === "gitlab" || source === "bitbucket") return source;
  return undefined;
}

export async function refetchConfigurationVersion(configurationVersionId: string): Promise<boolean> {
  const configuration = await db.query.configurationVersions.findFirst({
    where: eq(configurationVersions.id, configurationVersionId),
  });
  if (configuration === undefined) return false;
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, configuration.workspaceId),
  });
  const repoFullName = workspace?.vcsRepo?.identifier;
  const commitSha = configuration.ingressAttributes?.commitSha;
  const provider = resolveRefetchProvider(configuration.source);
  if (validateRefetchConfiguration(workspace, repoFullName, commitSha, provider) !== undefined) return false;
  if (workspace === undefined || repoFullName === undefined || commitSha === undefined || provider === undefined) return false;
  const credentials = provider === "github"
    ? await githubCredentials(workspace)
    : await oauthProviderCredentials(workspace, provider);
  if (credentials === undefined) {
    await markConfigurationVersionsErrored([configurationVersionId], `${provider} credentials are unavailable`);
    return false;
  }
  await fetchAndSaveProviderTarball([configurationVersionId], credentials, repoFullName, commitSha);
  const updated = await db.query.configurationVersions.findFirst({
    where: eq(configurationVersions.id, configurationVersionId),
    columns: { status: true },
  });
  return updated?.status === "uploaded";
}

/** Get a provider default branch from its repository response. */
function defaultBranchFromBody(provider: VcsProvider, body: Readonly<Record<string, unknown>>): string | undefined {
  if ((provider === "github" || provider === "gitlab") && typeof body["default_branch"] === "string") return body["default_branch"];
  if (provider === "bitbucket" && body["mainbranch"] !== null && typeof body["mainbranch"] === "object") {
    const mainBranch = body["mainbranch"] as Record<string, unknown>;
    if (typeof mainBranch["name"] === "string") return mainBranch["name"];
  }
  return undefined;
}

async function githubAppDefaultBranch(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  vcs: VcsRepo,
  encodedPath: string,
): Promise<string | undefined> {
  const installationRef = vcs.githubAppInstallationId;
  if (installationRef === undefined || installationRef === "") return undefined;
  const installation = await db.query.githubAppInstallations.findFirst({
    where: and(eq(githubAppInstallations.id, installationRef), eq(githubAppInstallations.orgId, workspace.orgId)),
  });
  if (installation === undefined) return undefined;
  const token = await getGitHubAppAccessToken(installation.installationId);
  if (token === null) return undefined;
  const apiUrl = githubAppApiBase(true);
  if (apiUrl === undefined) return undefined;
  const response = await fetchVcsUrl(`${apiUrl}/repos/${encodedPath}`, {
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json" },
    timeoutMs: 10_000,
  });
  if (!response.ok) return undefined;
  const body = await response.json() as Record<string, unknown>;
  return typeof body["default_branch"] === "string" ? body["default_branch"] : undefined;
}

async function oauthDefaultBranch(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  vcs: VcsRepo,
  identifier: string,
  encodedPath: string,
): Promise<string | undefined> {
  const tokenId = vcs.oauthTokenId;
  if (tokenId === undefined || tokenId === "") return undefined;
  const oauthToken = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) });
  if (oauthToken === undefined) return undefined;
  const client = await db.query.oauthClients.findFirst({
    where: and(eq(oauthClients.id, oauthToken.oauthClientId), eq(oauthClients.orgId, workspace.orgId)),
  });
  if (client === undefined) return undefined;
  const provider = providerForServiceProvider(client.serviceProvider);
  const apiUrl = providerApiUrl(client.apiUrl, provider === "github" ? "https://api.github.com" : "");
  if (apiUrl === undefined || provider === undefined) return undefined;
  const secret = await decryptSecret(oauthToken.token).catch((): undefined => undefined);
  if (secret === undefined) return undefined;
  const url = provider === "github"
    ? `${apiUrl}/repos/${encodedPath}`
    : provider === "gitlab"
      ? `${apiUrl}/projects/${encodeURIComponent(identifier)}`
      : `${apiUrl}/repositories/${encodeURIComponent(identifier)}`;
  const accept = provider === "github" ? "application/vnd.github.v3+json" : "application/json";
  const response = await fetchVcsUrl(url, {
    headers: { Authorization: "Bearer " + secret, Accept: accept },
    timeoutMs: 10_000,
  });
  if (!response.ok) return undefined;
  return defaultBranchFromBody(provider, await response.json() as Record<string, unknown>);
}

/** Get the default branch name for a VCS workspace by querying the provider API. */
async function fetchDefaultBranch(workspace: DeepReadonly<typeof workspaces.$inferSelect>): Promise<string | undefined> {
  const vcs = workspace.vcsRepo;
  if (vcs?.identifier === undefined) return undefined;
  const encodedPath = vcs.identifier.split("/").map(encodeURIComponent).join("/");
  const appBranch = await githubAppDefaultBranch(workspace, vcs, encodedPath);
  if (appBranch !== undefined) return appBranch;
  return oauthDefaultBranch(workspace, vcs, vcs.identifier, encodedPath);
}

function latestShaFromBody(provider: VcsProvider, body: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[]): string | undefined {
  if (provider === "github") {
    const commits = body as Record<string, unknown>[];
    const sha = commits[0]?.["sha"];
    return typeof sha === "string" ? sha : undefined;
  }
  if (provider === "gitlab") {
    const sha = (body as Record<string, unknown>)["id"];
    return typeof sha === "string" ? sha : undefined;
  }
  const target = (body as Record<string, unknown>)["target"] as Record<string, unknown> | undefined;
  return typeof target?.["hash"] === "string" ? target["hash"] : undefined;
}

async function githubAppLatestCommit(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  vcs: VcsRepo,
  identifier: string,
  encodedPath: string,
  branch: string,
): Promise<string | undefined> {
  const installationRef = vcs.githubAppInstallationId;
  if (installationRef === undefined || installationRef === "") return undefined;
  const installation = await db.query.githubAppInstallations.findFirst({
    where: and(eq(githubAppInstallations.id, installationRef), eq(githubAppInstallations.orgId, workspace.orgId)),
  });
  if (installation === undefined) return undefined;
  const token = await getGitHubAppAccessToken(installation.installationId);
  if (token === null) return undefined;
  const apiUrl = githubAppApiBase(true);
  if (apiUrl === undefined) return undefined;
  const url = `${apiUrl}/repos/${encodedPath}/commits?sha=${encodeURIComponent(branch)}&per_page=1`;
  const response = await fetchVcsUrl(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json" },
    timeoutMs: 10_000,
  });
  if (response.ok) {
    const body = await response.json() as Record<string, unknown>[];
    const sha = body[0]?.["sha"];
    if (typeof sha === "string") return sha;
    console.error(`[terrence] latestCommitSha: unexpected response body for ${identifier}`);
  } else {
    const errText = await response.text().catch((): string => "");
    console.error(`[terrence] latestCommitSha: GitHub API returned ${response.status} for ${url}: ${errText.slice(0, 500)}`);
  }
  return undefined;
}

async function oauthLatestCommit(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  vcs: VcsRepo,
  identifier: string,
  encodedPath: string,
  branch: string,
): Promise<string | undefined> {
  const tokenId = vcs.oauthTokenId;
  if (tokenId === undefined || tokenId === "") return undefined;
  const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) });
  if (token === undefined) return undefined;
  const client = await db.query.oauthClients.findFirst({
    where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, workspace.orgId)),
  });
  if (client === undefined) return undefined;
  const provider = providerForServiceProvider(client.serviceProvider);
  const apiUrl = providerApiUrl(client.apiUrl, provider === "github" ? "https://api.github.com" : "");
  if (apiUrl === undefined || provider === undefined) return undefined;
  const secret = await decryptSecret(token.token).catch((): undefined => undefined);
  if (secret === undefined) return undefined;
  const url = provider === "github"
    ? `${apiUrl}/repos/${encodedPath}/commits?sha=${encodeURIComponent(branch)}&per_page=1`
    : provider === "gitlab"
      ? `${apiUrl}/projects/${encodeURIComponent(identifier)}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`
      : `${apiUrl}/repositories/${encodeURIComponent(identifier)}/refs/branches/${encodeURIComponent(branch)}`;
  const accept = provider === "github" ? "application/vnd.github.v3+json" : "application/json";
  const response = await fetchVcsUrl(url, {
    headers: { Authorization: "Bearer " + secret, Accept: accept },
    timeoutMs: 10_000,
  });
  if (!response.ok) return undefined;
  const body = await response.json() as Record<string, unknown> | Record<string, unknown>[];
  return latestShaFromBody(provider, body);
}

/** Get the latest commit SHA on a branch for a VCS workspace. */
async function latestCommitSha(workspace: DeepReadonly<typeof workspaces.$inferSelect>, branch: string): Promise<string | undefined> {
  const vcs = workspace.vcsRepo;
  if (vcs?.identifier === undefined) return undefined;
  const identifier = vcs.identifier;
  const encodedPath = identifier.split("/").map(encodeURIComponent).join("/");
  const appSha = await githubAppLatestCommit(workspace, vcs, identifier, encodedPath, branch);
  if (appSha !== undefined) return appSha;
  return oauthLatestCommit(workspace, vcs, identifier, encodedPath, branch);
}

/** Create a configuration version from VCS for a manual run, fetching the latest code on the default branch. */
export async function createConfigurationVersionFromVcs(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
): Promise<string | { error: string }> {
  const vcs = workspace.vcsRepo;
  if (vcs?.identifier === undefined) return { error: "Workspace is not connected to a VCS provider" };
  const branch = vcs.branch ?? await fetchDefaultBranch(workspace) ?? "main";

  const sha = await latestCommitSha(workspace, branch);
  if (sha === undefined) return { error: "Failed to retrieve the latest commit from VCS. Check VCS credentials." };

  // Determine the VCS source
  let source = "tfe-api";
  if (vcs.githubAppInstallationId !== undefined && vcs.githubAppInstallationId !== "") {
    source = "github";
  } else if (vcs.oauthTokenId !== undefined && vcs.oauthTokenId !== "") {
    const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, vcs.oauthTokenId) });
    if (token !== undefined) {
      const client = await db.query.oauthClients.findFirst({
        where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, workspace.orgId)),
      });
      const provider = providerForServiceProvider(client?.serviceProvider ?? "");
      source = provider ?? "tfe-api";
    }
  }

  const cvId = `cv-${crypto.randomUUID().slice(0, 16).replace(/-/g, "")}`;
  await db.insert(configurationVersions).values({
    id: cvId,
    workspaceId: workspace.id,
    status: "pending",
    speculative: false,
    source,
    ingressAttributes: { commitSha: sha, branch, manualTrigger: true } as typeof configurationVersions.$inferInsert["ingressAttributes"],
    statusTimestamps: {},
  });

  if (!(await refetchConfigurationVersion(cvId))) {
    return { error: "Failed to download configuration from VCS." };
  }
  return cvId;
}

type DefaultBranchCacheEntry = Readonly<{
  value: string | undefined;
  expiresAt: number;
}>;
const DEFAULT_BRANCH_CACHE_TTL_MS = 60_000;
const DEFAULT_BRANCH_NEGATIVE_TTL_MS = 5_000;
const defaultBranchCache = new Map<string, DefaultBranchCacheEntry>();

export function clearDefaultBranchCacheForTests(): void {
  defaultBranchCache.clear();
}

async function matchesConfiguredBranch(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  configuredSource?: VcsSourceIdentity,
): Promise<boolean> {
  const vcsRepo = workspace.vcsRepo;
  if (vcsRepo === null || vcsRepo === undefined) return false;
  // Workspaces with no branch configured track the repository's default branch
  // (TFE default: "default branch" = repository default). The previous
  // `return true` made them fire on *every* branch push — that turned every
  // feat/* push into a real applyable run (run-157ebcd9cff343). Resolve the
  // default branch via the provider API and compare; fail closed if it
  // cannot be determined so we never mis-route a push.
  let expectedBranch = vcsRepo.branch;
  if (expectedBranch === undefined || expectedBranch === "") {
    const source = configuredSource ?? await configuredVcsSource(workspace);
    const connectionId = vcsRepo.githubAppInstallationId ?? vcsRepo.oauthTokenId ?? "unknown";
    const sourceKey = source === undefined
      ? "unknown"
      : `${source.provider}:${source.host}:${source.installationId ?? "oauth"}:${connectionId}`;
    const cacheKey = `${workspace.orgId}:${sourceKey}:${vcsRepo.identifier ?? ""}`;
    const now = Date.now();
    const cached = defaultBranchCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      expectedBranch = cached.value;
    } else {
      if (cached !== undefined) defaultBranchCache.delete(cacheKey);
      expectedBranch = await fetchDefaultBranch(workspace);
      defaultBranchCache.set(cacheKey, {
        value: expectedBranch,
        expiresAt: now + (expectedBranch === undefined ? DEFAULT_BRANCH_NEGATIVE_TTL_MS : DEFAULT_BRANCH_CACHE_TTL_MS),
      });
    }
    if (expectedBranch === undefined || expectedBranch === "") return false;
  }
  // PR/MR events are matched against the target (base) branch: a workspace
  // pinned to `main` must trigger on PRs/MRs from feature branches that
  // target main, not on the source branch name (kanban 1.6).
  const eventBranch = details.pullRequestNumber !== undefined && details.targetBranch !== undefined
    ? details.targetBranch
    : details.branch;
  return eventBranch !== undefined && eventBranch !== "" && expectedBranch === eventBranch;
}

async function matchesVcsTrigger(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  configuredSource?: VcsSourceIdentity,
): Promise<boolean> {
  const vcsRepo = workspace.vcsRepo;
  if (vcsRepo === null || vcsRepo === undefined) return false;
  // TFE tag-triggered workspaces are tag-only: once tags-regex is configured,
  // ordinary branch pushes and pull requests must not queue a second run.
  if (typeof vcsRepo.tagsRegex === "string" && vcsRepo.tagsRegex !== "") {
    return details.tag !== undefined && matchesTag(vcsRepo, details.tag);
  }
  return details.tag === undefined && await matchesConfiguredBranch(workspace, details, configuredSource);
}

async function providerChangedFiles(
  provider: OAuthProvider,
  kind: "push" | "pull_request",
  candidates: readonly DeepReadonly<typeof workspaces.$inferSelect>[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: Readonly<WebhookDetails>,
): Promise<ReadonlySet<string> | undefined> {
  const needsLookup = kind === "pull_request" || (provider === "bitbucket" && details.tag === undefined);
  if (!needsLookup) return undefined;
  for (const workspace of candidates) {
    const files = kind === "pull_request"
      ? provider === "gitlab"
        ? await gitlabMergeRequestFiles(workspace, details)
        : await bitbucketPullRequestFiles(workspace, details)
      : await bitbucketCommitFiles(workspace, details);
    // A workspace with no usable credential must not prevent another matching
    // workspace from supplying the repository-wide file list.
    if (files !== undefined) return files;
  }
  return undefined;
}

type GithubInstallationPredicate = (
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  installationId: number,
) => Promise<boolean>;

async function matchingWebhookWorkspaces(
  provider: VcsProvider,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  githubInstallationPredicate?: GithubInstallationPredicate,
): Promise<readonly DeepReadonly<typeof workspaces.$inferSelect>[]> {
  const candidates = await db.query.workspaces.findMany({
    where: sql`${jsonExtract(workspaces.vcsRepo, '$.identifier')} = ${details.repoFullName}`,
  });
  const branchMatchedWorkspaces: DeepReadonly<typeof workspaces.$inferSelect>[] = [];
  for (const workspace of candidates) {
    if (workspace.vcsRepo?.identifier !== details.repoFullName) continue;
    const configuredSource = await configuredVcsSource(workspace);
    if (configuredSource === undefined || configuredSource.provider !== provider || !vcsSourceMatchesConnection(configuredSource, details.sourceIdentity)) continue;
    if (details.githubInstallationId !== undefined && githubInstallationPredicate !== undefined && !await githubInstallationPredicate(workspace, details.githubInstallationId)) continue;
    if (await matchesVcsTrigger(workspace, details, configuredSource)) branchMatchedWorkspaces.push(workspace);
  }
  return branchMatchedWorkspaces;
}

type OAuthWebhookRun = Readonly<{
  configurationVersionId: string;
  credentials: ProviderCredentials | undefined;
}>;

function webhookProviderId(provider: VcsProvider, credentials: ProviderCredentials | undefined): string {
  if (credentials?.oauthClientId !== undefined) return `vcs:${credentials.oauthClientId}`;
  return provider === "github" ? "github-app" : "vcs";
}

function webhookIngressAttributes(
  provider: VcsProvider,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  credentials: ProviderCredentials | undefined,
): Record<string, unknown> {
  return {
    commitSha: details.commitSha,
    commitUrl: details.commitUrl,
    commitMessage: details.commitMessage,
    ...(details.branch === undefined ? {} : { branch: details.branch }),
    ...(details.tag === undefined ? {} : { tag: details.tag }),
    senderUsername: details.senderUsername,
    ...(details.senderAvatarUrl === undefined ? {} : {
      senderAvatarUrl: details.senderAvatarUrl,
      senderProviderId: webhookProviderId(provider, credentials),
    }),
    cloneUrl: details.cloneUrl,
    ...(details.pullRequestNumber === undefined ? {} : { pullRequestNumber: details.pullRequestNumber }),
  };
}

function webhookAuditAttributes(
  provider: VcsProvider,
  kind: "push" | "pull_request",
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  credentials: ProviderCredentials | undefined,
): Record<string, unknown> {
  return {
    workspaceId: workspace.id,
    status: "pending",
    source: provider,
    triggerReason: kind,
    actorUsername: details.senderUsername,
    ...(details.senderAvatarUrl === undefined ? {} : {
      actorAvatarUrl: details.senderAvatarUrl,
      actorProviderId: webhookProviderId(provider, credentials),
    }),
  };
}

async function persistWebhookRun(
  provider: VcsProvider,
  kind: "push" | "pull_request",
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  credentials: ProviderCredentials | undefined,
  configurationVersionId: string,
  runId: string,
  isSpeculative: boolean,
): Promise<void> {
  await db.insert(configurationVersions).values({
    id: configurationVersionId,
    workspaceId: workspace.id,
    status: "pending",
    speculative: isSpeculative,
    source: provider,
    ingressAttributes: webhookIngressAttributes(provider, details, credentials),
    statusTimestamps: {},
  });
  await db.insert(runs).values({
    id: runId,
    workspaceId: workspace.id,
    configurationVersionId,
    message: commitSubject(details.commitMessage),
    status: "pending",
    isDestroy: false,
    autoApply: workspace.autoApply === true && !isSpeculative,
    planOnly: isSpeculative,
    statusTimestamps: { "pending-at": new Date().toISOString() },
    logToken: crypto.randomUUID(),
    createdAt: Date.now(),
  });
  await auditLog("create", "runs", runId, null, workspace.orgId, webhookAuditAttributes(provider, kind, details, workspace, credentials));
}

async function createWebhookRun(
  provider: VcsProvider,
  kind: "push" | "pull_request",
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  resolveCredentials: () => Promise<ProviderCredentials | undefined>,
): Promise<OAuthWebhookRun | undefined> {
  const isSpeculative = kind === "pull_request";
  if (isSpeculative && workspace.speculativeEnabled === false) return undefined;
  if (!isSpeculative && workspace.autoApplyRunTrigger !== true && workspace.queueAllRuns !== true) return undefined;
  const credentials = await resolveCredentials();
  const configurationVersionId = `cv-${crypto.randomUUID().slice(0, 16).replace(/-/g, "")}`;
  const runId = newRunId();
  await persistWebhookRun(provider, kind, details, workspace, credentials, configurationVersionId, runId, isSpeculative);
  if (credentials !== undefined) void reportRunVcsStatus(runId, "pending");
  return { configurationVersionId, credentials };
}

async function createOAuthWebhookRun(
  provider: OAuthProvider,
  kind: "push" | "pull_request",
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
): Promise<OAuthWebhookRun | undefined> {
  return createWebhookRun(provider, kind, details, workspace, async (): Promise<ProviderCredentials | undefined> => oauthProviderCredentials(workspace, provider));
}

type OAuthWebhookDownloads = Map<string, { credentials: ProviderCredentials; configurationVersionIds: string[] }>;

function addOAuthWebhookDownload(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- downloads are grouped into this mutable per-webhook cache
  downloads: OAuthWebhookDownloads,
  credentials: ProviderCredentials,
  configurationVersionId: string,
): void {
  const downloadKey = `${credentials.apiUrl}\u0000${credentials.token}`;
  const group = downloads.get(downloadKey);
  if (group === undefined) {
    downloads.set(downloadKey, { credentials, configurationVersionIds: [configurationVersionId] });
  } else {
    group.configurationVersionIds.push(configurationVersionId);
  }
}

async function handleOAuthProviderWebhook(
  provider: OAuthProvider,
  kind: "push" | "pull_request",
  // ReadonlySet is intentionally preserved by DeepReadonly.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
): Promise<boolean> {
  const branchMatchedWorkspaces = await matchingWebhookWorkspaces(provider, details);
  // PR/MR payloads carry no changed-file list (kanban 1.6). Bitbucket push
  // payloads do not carry one either, so both paths fetch a complete list.
  // Failures fall back to the empty set (trigger-all) so a VCS API outage can
  // never silently drop a run.
  let triggerDetails = details;
  const filesChanged = await providerChangedFiles(provider, kind, branchMatchedWorkspaces, details);
  if (filesChanged !== undefined) triggerDetails = { ...details, filesChanged };
  const matchedWorkspaces = branchMatchedWorkspaces.filter((workspace: DeepReadonly<typeof workspaces.$inferSelect>): boolean =>
    details.tag !== undefined || matchesFileTriggers(workspace, triggerDetails.filesChanged));

  const downloads: OAuthWebhookDownloads = new Map();
  const missingCredentialConfigurationVersionIds: string[] = [];
  for (const workspace of matchedWorkspaces) {
    const created = await createOAuthWebhookRun(provider, kind, details, workspace);
    if (created === undefined) continue;
    if (created.credentials === undefined) {
      missingCredentialConfigurationVersionIds.push(created.configurationVersionId);
      continue;
    }
    addOAuthWebhookDownload(downloads, created.credentials, created.configurationVersionId);
  }
  if (missingCredentialConfigurationVersionIds.length > 0) {
    await markConfigurationVersionsErrored(
      missingCredentialConfigurationVersionIds,
      `${provider} credentials are unavailable`,
    );
  }
  await Promise.all([
    Promise.all([...downloads.values()].map(async ({ credentials, configurationVersionIds }): Promise<void> => {
      await fetchAndSaveProviderTarball(configurationVersionIds, credentials, details.repoFullName, details.commitSha);
    })),
    synchronizeVcsPolicySets(provider, kind, details),
  ]);
  return true;
}

export async function handleGitlabWebhook(eventName: string, payload: WebhookPayload): Promise<boolean> {
  const parsed = gitlabWebhook(eventName, payload);
  return parsed === undefined ? false : handleOAuthProviderWebhook("gitlab", parsed.kind, parsed.details);
}

export async function handleBitbucketWebhook(eventName: string, payload: WebhookPayload): Promise<boolean> {
  const parsed = bitbucketWebhook(eventName, payload);
  if (parsed === undefined) return false;
  await Promise.all(parsed.map(async (event): Promise<void> => {
    await handleOAuthProviderWebhook("bitbucket", event.kind, event.details);
  }));
  return parsed.length > 0;
}

/**
 * Resync every VCS registry module that points at the given repository when
 * a tag is pushed. Tag prefix filtering mirrors the registry's tag-prefix
 * setting; synchronizeRegistryModule imports any new matching tags and
 * records per-module errors on the module row, so callers can run this
 * fire-and-forget. The source identity is required so a repository with the
 * same owner/name on another provider host cannot trigger this module.
 */
export async function syncRegistryModulesForTag(
  repoFullName: string,
  tag: string,
  sourceIdentity: VcsSourceIdentity,
): Promise<void> {
  const modules = await db.query.registryModules.findMany({
    where: and(
      eq(registryModules.publishingMechanism, "vcs"),
      eq(registryModules.publishingWorkflow, "tag"),
      eq(registryModules.repositoryIdentifier, repoFullName),
    ),
  });
  for (const mod of modules) {
    if (mod.tagPrefix !== "" && !tag.startsWith(mod.tagPrefix)) continue;
    const moduleSource = await sourceIdentityForConnection(mod.orgId, mod.vcsConnectionType, mod.vcsConnectionId);
    if (moduleSource === undefined || !vcsSourceMatchesConnection(moduleSource, sourceIdentity)) continue;
    try {
      await synchronizeRegistryModule(mod);
    } catch (error: unknown) {
      // The module row records the failure; keep syncing the rest.
      console.error(`[terrence] Registry module sync failed for ${mod.id}:`, error instanceof Error ? error.message : error);
    }
  }
}

type GithubTriggerSelection = Readonly<{
  triggerDetails: DeepReadonly<WebhookDetails>;
  matchedWorkspaces: readonly DeepReadonly<typeof workspaces.$inferSelect>[];
}>;

async function githubTriggerSelection(
  eventName: string,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  branchMatchedWorkspaces: readonly DeepReadonly<typeof workspaces.$inferSelect>[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- installation credentials are cached during one webhook
  installationTokens: Map<string, string | null>,
): Promise<GithubTriggerSelection> {
  let triggerDetails = details;
  if (eventName === "pull_request") {
    const filesChanged = await githubPullRequestFiles(branchMatchedWorkspaces, details, installationTokens);
    if (filesChanged !== undefined) triggerDetails = { ...details, filesChanged };
  }
  const matchedWorkspaces = branchMatchedWorkspaces.filter((workspace): boolean =>
    details.tag !== undefined || matchesFileTriggers(workspace, triggerDetails.filesChanged));
  if (eventName === "pull_request") {
    await Promise.all(branchMatchedWorkspaces
      .filter((workspace): boolean => !matchesFileTriggers(workspace, triggerDetails.filesChanged))
      .map(async (workspace): Promise<void> => {
        await reportUntriggeredSpeculativeStatus(workspace, triggerDetails, installationTokens);
      }));
  }
  return { triggerDetails, matchedWorkspaces };
}

async function createGithubWebhookRun(
  eventName: string,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- installation credentials are cached during one webhook
  installationTokens: Map<string, string | null>,
): Promise<OAuthWebhookRun | undefined> {
  const kind = eventName === "pull_request" ? "pull_request" : "push";
  return createWebhookRun("github", kind, details, workspace, async (): Promise<ProviderCredentials | undefined> => githubCredentials(workspace, installationTokens));
}

export async function handleGithubWebhook(eventName: string, payload: WebhookPayload): Promise<void> {
  const details = parseWebhook(eventName, payload);
  if (details === undefined) return;

  // Tag pushes also feed the private module registry: VCS modules on the
  // repository are resynced so new tags become registry versions without
  // any outbound call (the GitHub App webhook is the transport, matching
  // the reference format's tag workflow). Isolated: a failing module must not affect the
  // workspace run path below.
  if (details.tag !== undefined) {
    void syncRegistryModulesForTag(details.repoFullName, details.tag, details.sourceIdentity).catch((error: unknown): void => {
      console.error("[terrence] Registry module tag sync failed:", error);
    });
  }

  const branchMatchedWorkspaces = await matchingWebhookWorkspaces("github", details, matchesGithubAppInstallation);
  const installationTokens = new Map<string, string | null>();
  const { matchedWorkspaces } = await githubTriggerSelection(eventName, details, branchMatchedWorkspaces, installationTokens);

  const missingCredentialConfigurationVersionIds: string[] = [];
  const downloads: OAuthWebhookDownloads = new Map();
  for (const workspace of matchedWorkspaces) {
    const created = await createGithubWebhookRun(eventName, details, workspace, installationTokens);
    if (created === undefined) continue;
    if (created.credentials === undefined) {
      missingCredentialConfigurationVersionIds.push(created.configurationVersionId);
      continue;
    }
    addOAuthWebhookDownload(downloads, created.credentials, created.configurationVersionId);
  }

  if (missingCredentialConfigurationVersionIds.length > 0) {
    console.error(`[terrence] Could not obtain GitHub credentials for ${details.repoFullName}`);
    await markConfigurationVersionsErrored(
      missingCredentialConfigurationVersionIds,
      "GitHub credentials are unavailable",
    );
  }
  await Promise.all([
    Promise.all([...downloads.values()].map(async ({ credentials, configurationVersionIds }): Promise<void> => {
      await fetchAndSaveTarball(configurationVersionIds, credentials, details.repoFullName, details.commitSha);
    })),
    synchronizeVcsPolicySets("github", eventName === "pull_request" ? "pull_request" : "push", details),
  ]);
}

async function fetchAndSaveTarball(
  configurationVersionIds: readonly string[],
  credentials: ProviderCredentials,
  repoFullName: string,
  commitSha: string,
): Promise<void> {
  const repositoryParts = repoFullName.split("/");
  const owner = repositoryParts[0] ?? "";
  const repository = repositoryParts[1] ?? "";
  if (
    credentials.provider !== "github"
    || repositoryParts.length !== 2
    || !OWNER_PATTERN.test(owner)
    || !REPOSITORY_PATTERN.test(repository)
    || !COMMIT_SHA_PATTERN.test(commitSha)
  ) {
    await markConfigurationVersionsErrored(configurationVersionIds, "Invalid repository or commit SHA");
    return;
  }

  const url = `${credentials.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tarball/${encodeURIComponent(commitSha)}`;
  await downloadAndSaveTarball(
    configurationVersionIds,
    "github",
    url,
    { Authorization: `Bearer ${credentials.token}`, Accept: "application/vnd.github.v3+json" },
  );
}

async function fetchAndSaveProviderTarball(
  configurationVersionIds: readonly string[],
  credentials: ProviderCredentials,
  repoFullName: string,
  commitSha: string,
): Promise<void> {
  const request = providerTarballRequest(credentials, repoFullName, commitSha);
  if (request === undefined) {
    await markConfigurationVersionsErrored(configurationVersionIds, "Invalid repository or commit SHA");
    return;
  }
  await downloadAndSaveTarball(
    configurationVersionIds,
    credentials.provider,
    request.url,
    request.headers,
  );
}

function providerTarballRequest(
  credentials: ProviderCredentials,
  repoFullName: string,
  commitSha: string,
): Readonly<{ headers: Readonly<Record<string, string>>; url: string }> | undefined {
  const repositoryParts = repoFullName.split("/");
  if (
    repositoryParts.length < 2
    || repositoryParts.some((part: string): boolean => !REPOSITORY_PATTERN.test(part))
    || !COMMIT_SHA_PATTERN.test(commitSha)
    || (credentials.provider !== "gitlab" && repositoryParts.length !== 2)
  ) return undefined;
  const url = credentials.provider === "github"
    ? `${credentials.apiUrl}/repos/${repositoryParts.map(encodeURIComponent).join("/")}/tarball/${encodeURIComponent(commitSha)}`
    : credentials.provider === "gitlab"
      ? `${credentials.apiUrl}/projects/${encodeURIComponent(repoFullName)}/repository/archive.tar.gz?sha=${encodeURIComponent(commitSha)}`
      : `${credentials.apiUrl}/repositories/${repositoryParts.map(encodeURIComponent).join("/")}/src/${encodeURIComponent(commitSha)}.tar.gz`;
  return {
    url,
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      Accept: credentials.provider === "github" ? "application/vnd.github.v3+json" : "application/octet-stream",
    },
  };
}

async function fetchProviderPolicyArchive(
  credentials: ProviderCredentials,
  repoFullName: string,
  commitSha: string,
): Promise<Uint8Array> {
  const request = providerTarballRequest(credentials, repoFullName, commitSha);
  if (request === undefined) throw new Error("Invalid repository or commit SHA");
  const response = await fetchVcsUrlStream(request.url, {
    headers: request.headers,
    maxResponseBytes: MAX_TARBALL_BYTES,
    timeoutMs: ARCHIVE_DOWNLOAD_TIMEOUT_MS,
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download ${credentials.provider} policy archive`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TARBALL_BYTES) {
    throw new Error(`${credentials.provider} policy archive exceeds the maximum download size`);
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let downloadedBytes = 0;
  let finished = false;
  while (!finished) {
    const chunk = await reader.read();
    if (chunk.done) {
      finished = true;
    } else {
      downloadedBytes += chunk.value.byteLength;
      if (downloadedBytes > MAX_TARBALL_BYTES) {
        await reader.cancel();
        throw new Error(`${credentials.provider} policy archive exceeds the maximum download size`);
      }
      chunks.push(chunk.value);
    }
  }
  const archive = new Uint8Array(downloadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

async function synchronizeVcsPolicySets(
  provider: VcsProvider,
  kind: "push" | "pull_request",
  // ReadonlySet is intentionally preserved by DeepReadonly.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
): Promise<void> {
  if (kind !== "push") return;
  const candidates = await db.query.policySets.findMany({
    where: sql`${jsonExtract(policySets.vcsRepo, '$.identifier')} = ${details.repoFullName}`,
  });
  const matched: DeepReadonly<typeof policySets.$inferSelect>[] = [];
  for (const policySet of candidates) {
    const vcsRepo = policySet.vcsRepo;
    const connectionType = vcsRepo?.githubAppInstallationId !== undefined && vcsRepo.githubAppInstallationId !== ""
      ? "github-app"
      : vcsRepo?.oauthTokenId !== undefined && vcsRepo.oauthTokenId !== ""
        ? "oauth-token"
        : undefined;
    const connectionId = connectionType === "github-app" ? vcsRepo?.githubAppInstallationId : vcsRepo?.oauthTokenId;
    const configuredSource = await sourceIdentityForConnection(policySet.orgId, connectionType, connectionId);
    if (configuredSource !== undefined && vcsSourceMatchesConnection(configuredSource, details.sourceIdentity) && matchesPolicySetWebhook(policySet, details)) {
      matched.push(policySet);
    }
  }
  await Promise.all(matched.map(async (policySet: DeepReadonly<typeof policySets.$inferSelect>): Promise<void> =>
    synchronizeVcsPolicySet(policySet, provider, details, async (): Promise<Uint8Array> => {
      const credentials = provider === "github"
        ? await githubCredentials(policySet)
        : await oauthProviderCredentials(policySet, provider);
      if (credentials === undefined) throw new Error(`${provider} credentials are unavailable for this policy set`);
      return fetchProviderPolicyArchive(credentials, details.repoFullName, details.commitSha);
    })));
}

async function downloadAndSaveTarball(
  configurationVersionIds: readonly string[],
  provider: "github" | OAuthProvider,
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const storageDirectory = resolve(process.env["STORAGE_DIR"] ?? join(process.cwd(), "storage"), "configuration_versions");
  const temporaryPath = join(storageDirectory, `.${provider}-${crypto.randomUUID()}.tar.gz`);
  try {
    await mkdir(storageDirectory, { recursive: true });
    const response = await fetchVcsUrlStream(url, {
      headers,
      maxResponseBytes: MAX_TARBALL_BYTES,
      timeoutMs: ARCHIVE_DOWNLOAD_TIMEOUT_MS,
    });
    if (!response.ok || response.body === null) throw new Error(`Failed to download ${provider} tarball`);

    const file = await open(temporaryPath, "wx");
    let downloadedBytes = 0;
    try {
      const reader = response.body.getReader();
      let finished = false;
      while (!finished) {
        const chunk = await reader.read();
        if (chunk.done) {
          finished = true;
        } else {
          downloadedBytes += chunk.value.byteLength;
          if (downloadedBytes > MAX_TARBALL_BYTES) {
            await reader.cancel();
            throw new Error(`${provider} tarball exceeds the maximum download size`);
          }
          await file.write(chunk.value);
        }
      }
    } finally {
      await file.close();
    }

    for (const configurationVersionId of configurationVersionIds) {
      const archivePath = join(storageDirectory, `${configurationVersionId}.tar.gz`);
      await copyFile(temporaryPath, archivePath);
      await db.update(configurationVersions).set({
        status: "uploaded",
        archivePath,
        statusTimestamps: { uploadedAt: new Date().toISOString() },
      }).where(eq(configurationVersions.id, configurationVersionId));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : `Failed to download ${provider} tarball`;
    await markConfigurationVersionsErrored(configurationVersionIds, message);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function markConfigurationVersionsErrored(configurationVersionIds: readonly string[], error: string): Promise<void> {
  if (configurationVersionIds.length === 0) return;
  await db.update(configurationVersions)
    .set({ status: "errored", error })
    .where(inArray(configurationVersions.id, [...configurationVersionIds]));
  const affectedRuns = await db.query.runs.findMany({
    where: inArray(runs.configurationVersionId, [...configurationVersionIds]),
    columns: { id: true },
  });
  const erroredAt = new Date().toISOString();
  if (affectedRuns.length > 0) {
    await db.update(runs)
      .set({
        status: "errored",
        statusTimestamps: jsonSet(runs.statusTimestamps, 'errored-at', sql`${erroredAt}`),
      })
      .where(inArray(runs.id, affectedRuns.map((run): string => run.id)));
    for (const run of affectedRuns) {
      void reportRunVcsStatus(run.id, "errored");
    }
  }
}
