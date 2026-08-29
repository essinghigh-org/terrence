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
import { auditLog , type DeepReadonly } from "./utils";

type WebhookPayload = Readonly<Record<string, unknown>>;
type VcsRepo = NonNullable<typeof workspaces.$inferSelect.vcsRepo>;
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
  readonly tag?: string;
}>;
type OAuthProvider = "gitlab" | "bitbucket";
type VcsProvider = "github" | OAuthProvider;
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
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

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
  if (!Array.isArray(payload.commits)) return undefined;
  const files = new Set<string>();
  for (const value of payload.commits) {
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
  const installation = asRecord(payload.installation);
  if (typeof installation?.id !== "number") return undefined;
  if (!Number.isSafeInteger(installation.id)) return undefined;
  if (installation.id <= 0) return undefined;
  return installation.id;
}

function parseRefBranchTag(ref: string): { branch?: string; tag?: string } | undefined {
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
  const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : undefined;
  if (branch === undefined && tag === undefined) return undefined;
  if (branch === "" || tag === "") return undefined;
  return { branch, tag };
}

function validateGithubPushFields(ref: string | undefined, commitSha: string | undefined, commitMessage: string | undefined, commitUrl: string | undefined, filesChanged: ReadonlySet<string> | undefined): string | undefined {
  if (ref === undefined) return "ref";
  if (commitSha === undefined) return "commitSha";
  if (commitMessage === undefined) return "commitMessage";
  if (commitUrl === undefined) return "commitUrl";
  if (filesChanged === undefined) return "filesChanged";
  return undefined;
}

function parseGithubPushWebhook(payload: WebhookPayload, base: { cloneUrl: string; repoFullName: string; senderUsername: string; senderAvatarUrl: string | undefined; deliveryInstallationId: number | undefined }): WebhookDetails | undefined {
  const ref = requiredString(payload.ref);
  const commitSha = requiredString(payload.after);
  const headCommit = asRecord(payload.head_commit);
  const commitMessage = requiredString(headCommit?.message);
  const commitUrl = requiredString(headCommit?.url);
  const filesChanged = changedFiles(payload);
  if (validateGithubPushFields(ref, commitSha, commitMessage, commitUrl, filesChanged) !== undefined) return undefined;
  const branchTag = parseRefBranchTag(ref as string);
  if (branchTag === undefined) return undefined;
  if (branchTag.branch !== undefined && (filesChanged as ReadonlySet<string>).size === 0) return undefined;
  return {
    ...(branchTag.branch === undefined ? {} : { branch: branchTag.branch }),
    cloneUrl: base.cloneUrl,
    commitMessage: commitMessage as string,
    commitSha: commitSha as string,
    commitUrl: commitUrl as string,
    filesChanged: filesChanged as ReadonlySet<string>,
    ...(base.deliveryInstallationId === undefined ? {} : { githubInstallationId: base.deliveryInstallationId }),
    repoFullName: base.repoFullName,
    senderUsername: base.senderUsername,
    ...(base.senderAvatarUrl === undefined ? {} : { senderAvatarUrl: base.senderAvatarUrl }),
    ...(branchTag.tag === undefined ? {} : { tag: branchTag.tag }),
  };
}

function validateGithubPrFields(branch: string | undefined, commitSha: string | undefined, commitMessage: string | undefined, commitUrl: string | undefined, pullRequestNumber: unknown): string | undefined {
  if (branch === undefined) return "branch";
  if (commitSha === undefined) return "commitSha";
  if (commitMessage === undefined) return "commitMessage";
  if (commitUrl === undefined) return "commitUrl";
  if (typeof pullRequestNumber !== "number") return "pullRequestNumber";
  if (!Number.isSafeInteger(pullRequestNumber as number)) return "pullRequestNumber";
  return undefined;
}

function buildGithubPrDetails(branch: string, targetBranch: string | undefined, base: { cloneUrl: string; repoFullName: string; senderUsername: string; senderAvatarUrl: string | undefined; deliveryInstallationId: number | undefined }, commitMessage: string, commitSha: string, commitUrl: string, pullRequestNumber: number): WebhookDetails {
  const details: WebhookDetails = {
    branch,
    cloneUrl: base.cloneUrl,
    commitMessage,
    commitSha,
    commitUrl,
    filesChanged: new Set<string>(),
    pullRequestNumber,
    repoFullName: base.repoFullName,
    senderUsername: base.senderUsername,
  } as WebhookDetails;
  const mutable = details as Record<string, unknown>;
  if (targetBranch !== undefined) mutable.targetBranch = targetBranch;
  if (base.deliveryInstallationId !== undefined) mutable.githubInstallationId = base.deliveryInstallationId;
  if (base.senderAvatarUrl !== undefined) mutable.senderAvatarUrl = base.senderAvatarUrl;
  return details;
}

function parseGithubPullRequestWebhook(payload: WebhookPayload, base: { cloneUrl: string; repoFullName: string; senderUsername: string; senderAvatarUrl: string | undefined; deliveryInstallationId: number | undefined }): WebhookDetails | undefined {
  const pullRequest = asRecord(payload.pull_request);
  const head = asRecord(pullRequest?.head);
  const baseRef = asRecord(pullRequest?.base);
  const branch = requiredString(head?.ref);
  const targetBranch = requiredString(baseRef?.ref);
  const commitSha = requiredString(head?.sha);
  const commitMessage = requiredString(pullRequest?.title);
  const commitUrl = requiredString(pullRequest?.html_url);
  const pullRequestNumber = payload.number;
  if (validateGithubPrFields(branch, commitSha, commitMessage, commitUrl, pullRequestNumber) !== undefined) return undefined;
  return buildGithubPrDetails(branch as string, targetBranch, base, commitMessage as string, commitSha as string, commitUrl as string, pullRequestNumber as number);
}

function extractGitlabCommits(payload: WebhookPayload): unknown[] {
  return Array.isArray(payload.commits) ? payload.commits : [];
}

function resolveGitlabCommitUrl(headCommit: Record<string, unknown> | undefined, project: Record<string, unknown> | undefined, cloneUrl: string, commitSha: string | undefined): string {
  const fromHead = requiredString(headCommit?.url);
  if (fromHead !== undefined) return fromHead;
  const webUrl = requiredString(project?.web_url) ?? cloneUrl;
  return `${webUrl}/-/commit/${commitSha ?? ""}`;
}

function resolveGitlabCommitSha(payload: WebhookPayload): string | undefined {
  return requiredString(payload.checkout_sha) ?? requiredString(payload.after);
}

function validateGitlabPushFields(ref: string | undefined, commitSha: string | undefined, filesChanged: ReadonlySet<string> | undefined): string | undefined {
  if (ref === undefined) return "ref";
  if (commitSha === undefined) return "commitSha";
  if (filesChanged === undefined) return "filesChanged";
  return undefined;
}

function parseGitlabPushWebhook(payload: WebhookPayload, project: Record<string, unknown> | undefined, repoFullName: string, cloneUrl: string, senderUsername: string): ParsedProviderWebhook | undefined {
  const ref = requiredString(payload.ref);
  const commitSha = resolveGitlabCommitSha(payload);
  const commits = extractGitlabCommits(payload);
  const headCommit = asRecord(commits.at(-1));
  const commitMessage = requiredString(headCommit?.message) ?? "VCS push";
  const commitUrl = resolveGitlabCommitUrl(headCommit, project, cloneUrl, commitSha);
  const filesChanged = changedFiles(payload);
  if (validateGitlabPushFields(ref, commitSha, filesChanged) !== undefined) return undefined;
  const branchTag = parseRefBranchTag(ref as string);
  if (branchTag === undefined) return undefined;
  if (branchTag.branch !== undefined && (filesChanged as ReadonlySet<string>).size === 0) return undefined;
  return {
    kind: "push",
    details: {
      ...(branchTag.branch === undefined ? {} : { branch: branchTag.branch }),
      cloneUrl,
      commitMessage,
      commitSha: commitSha as string,
      commitUrl,
      filesChanged: filesChanged as ReadonlySet<string>,
      repoFullName,
      senderUsername,
      ...(branchTag.tag === undefined ? {} : { tag: branchTag.tag }),
    },
  };
}

function resolveGitlabMrCommitMessage(attributes: Record<string, unknown> | undefined, lastCommit: Record<string, unknown> | undefined): string {
  const fromTitle = requiredString(attributes?.title);
  if (fromTitle !== undefined) return fromTitle;
  const fromCommit = requiredString(lastCommit?.message);
  if (fromCommit !== undefined) return fromCommit;
  return "Merge request";
}

function resolveGitlabMrCommitUrl(attributes: Record<string, unknown> | undefined, lastCommit: Record<string, unknown> | undefined): string | undefined {
  const fromAttr = requiredString(attributes?.url);
  if (fromAttr !== undefined) return fromAttr;
  return requiredString(lastCommit?.url);
}

function validateGitlabMrFields(branch: string | undefined, commitSha: string | undefined, commitUrl: string | undefined, pullRequestNumber: unknown): string | undefined {
  if (branch === undefined) return "branch";
  if (commitSha === undefined) return "commitSha";
  if (commitUrl === undefined) return "commitUrl";
  if (typeof pullRequestNumber !== "number") return "pullRequestNumber";
  if (!Number.isSafeInteger(pullRequestNumber as number)) return "pullRequestNumber";
  return undefined;
}

function parseGitlabMergeRequestWebhook(payload: WebhookPayload, repoFullName: string, cloneUrl: string, senderUsername: string): ParsedProviderWebhook | undefined {
  const attributes = asRecord(payload.object_attributes);
  const action = attributes?.action;
  if (!["open", "reopen", "update"].includes(typeof action === "string" ? action : "")) return undefined;
  const lastCommit = asRecord(attributes?.last_commit);
  const branch = requiredString(attributes?.source_branch);
  const targetBranch = requiredString(attributes?.target_branch);
  const commitSha = requiredString(lastCommit?.id);
  const commitMessage = resolveGitlabMrCommitMessage(attributes, lastCommit);
  const commitUrl = resolveGitlabMrCommitUrl(attributes, lastCommit);
  const pullRequestNumber = attributes?.iid;
  if (validateGitlabMrFields(branch, commitSha, commitUrl, pullRequestNumber) !== undefined) return undefined;
  return {
    kind: "pull_request",
    details: {
      branch: branch as string,
      ...(targetBranch === undefined ? {} : { targetBranch }),
      cloneUrl,
      commitMessage,
      commitSha: commitSha as string,
      commitUrl: commitUrl as string,
      filesChanged: new Set<string>(),
      pullRequestNumber: pullRequestNumber as number,
      repoFullName,
      senderUsername,
    },
  };
}

function extractBitbucketChanges(payload: WebhookPayload): unknown[] | undefined {
  const push = asRecord(payload.push);
  const changes = push?.changes;
  if (!Array.isArray(changes)) return undefined;
  if (changes.length !== 1) return undefined;
  return changes;
}

function validateBitbucketPushFields(referenceType: string | undefined, referenceName: string | undefined, commitSha: string | undefined, commitUrl: string | undefined): string | undefined {
  if (!["branch", "tag"].includes(referenceType ?? "")) return "referenceType";
  if (referenceName === undefined) return "referenceName";
  if (commitSha === undefined) return "commitSha";
  if (commitUrl === undefined) return "commitUrl";
  return undefined;
}

function parseBitbucketPushWebhook(payload: WebhookPayload, repoFullName: string, cloneUrl: string, senderUsername: string): ParsedProviderWebhook | undefined {
  const changes = extractBitbucketChanges(payload);
  if (changes === undefined) return undefined;
  const change = asRecord(changes[0]);
  const reference = asRecord(change?.new);
  const target = asRecord(reference?.target);
  const targetLinks = asRecord(target?.links);
  const html = asRecord(targetLinks?.html);
  const referenceType = requiredString(reference?.type);
  const referenceName = requiredString(reference?.name);
  const commitSha = requiredString(target?.hash);
  const commitMessage = requiredString(target?.message) ?? "VCS push";
  const commitUrl = requiredString(html?.href);
  if (validateBitbucketPushFields(referenceType, referenceName, commitSha, commitUrl) !== undefined) return undefined;
  return {
    kind: "push",
    details: {
      ...(referenceType === "branch" ? { branch: referenceName as string } : { tag: referenceName as string }),
      cloneUrl,
      commitMessage,
      commitSha: commitSha as string,
      commitUrl: commitUrl as string,
      filesChanged: new Set<string>(),
      repoFullName,
      senderUsername,
    },
  };
}

function validateBitbucketPrFields(branch: string | undefined, commitSha: string | undefined, commitUrl: string | undefined, pullRequestNumber: unknown): string | undefined {
  if (branch === undefined) return "branch";
  if (commitSha === undefined) return "commitSha";
  if (commitUrl === undefined) return "commitUrl";
  if (typeof pullRequestNumber !== "number") return "pullRequestNumber";
  if (!Number.isSafeInteger(pullRequestNumber as number)) return "pullRequestNumber";
  return undefined;
}

function resolveBitbucketPrCommitUrl(pullRequest: Record<string, unknown> | undefined, commit: Record<string, unknown> | undefined): string | undefined {
  const prLinks = asRecord(pullRequest?.links);
  const prHtml = asRecord(prLinks?.html);
  const fromPr = requiredString(prHtml?.href);
  if (fromPr !== undefined) return fromPr;
  const commitLinks = asRecord(commit?.links);
  const commitHtml = asRecord(commitLinks?.html);
  return requiredString(commitHtml?.href);
}

function parseBitbucketPullRequestWebhook(payload: WebhookPayload, repoFullName: string, cloneUrl: string, senderUsername: string): ParsedProviderWebhook | undefined {
  const pullRequest = asRecord(payload.pullrequest);
  const source = asRecord(pullRequest?.source);
  const destination = asRecord(pullRequest?.destination);
  const branchValue = asRecord(source?.branch);
  const destinationBranch = asRecord(destination?.branch);
  const commit = asRecord(source?.commit);
  const branch = requiredString(branchValue?.name);
  const targetBranch = requiredString(destinationBranch?.name);
  const commitSha = requiredString(commit?.hash);
  const commitMessage = requiredString(pullRequest?.title) ?? "Pull request";
  const commitUrl = resolveBitbucketPrCommitUrl(pullRequest, commit);
  const pullRequestNumber = pullRequest?.id;
  if (validateBitbucketPrFields(branch, commitSha, commitUrl, pullRequestNumber) !== undefined) return undefined;
  return {
    kind: "pull_request",
    details: {
      branch: branch as string,
      ...(targetBranch === undefined ? {} : { targetBranch }),
      cloneUrl,
      commitMessage,
      commitSha: commitSha as string,
      commitUrl: commitUrl as string,
      filesChanged: new Set<string>(),
      pullRequestNumber: pullRequestNumber as number,
      repoFullName,
      senderUsername,
    },
  };
}

function parseWebhook(eventName: string, payload: WebhookPayload): WebhookDetails | undefined {
  const repository = asRecord(payload.repository);
  const sender = asRecord(payload.sender);
  const deliveryInstallationId = extractDeliveryInstallationId(payload);
  const repoFullName = requiredString(repository?.full_name);
  const cloneUrl = requiredString(repository?.clone_url);
  const senderUsername = requiredString(sender?.login);
  const senderAvatarUrl = httpsUrl(sender?.avatar_url);
  if (repoFullName === undefined) return undefined;
  if (cloneUrl === undefined) return undefined;
  if (senderUsername === undefined) return undefined;
  const base = { cloneUrl, repoFullName, senderUsername, senderAvatarUrl, deliveryInstallationId };
  if (eventName === "push") return parseGithubPushWebhook(payload, base);
  if (eventName === "pull_request" && (payload.action === "opened" || payload.action === "synchronize")) return parseGithubPullRequestWebhook(payload, base);
  return undefined;
}

function gitlabWebhook(eventName: string, payload: WebhookPayload): ParsedProviderWebhook | undefined {
  const project = asRecord(payload.project);
  const user = asRecord(payload.user);
  const repoFullName = requiredString(project?.path_with_namespace);
  const cloneUrl = requiredString(project?.git_http_url) ?? requiredString(project?.web_url);
  const senderUsername = requiredString(payload.user_username) ?? requiredString(user?.username) ?? requiredString(payload.user_name);
  if (repoFullName === undefined) return undefined;
  if (cloneUrl === undefined) return undefined;
  if (senderUsername === undefined) return undefined;
  if (eventName === "Push Hook" || eventName === "Tag Push Hook") return parseGitlabPushWebhook(payload, project, repoFullName, cloneUrl, senderUsername);
  if (eventName === "Merge Request Hook") return parseGitlabMergeRequestWebhook(payload, repoFullName, cloneUrl, senderUsername);
  return undefined;
}

function bitbucketCloneUrl(repository: Readonly<Record<string, unknown>>): string | undefined {
  const links = asRecord(repository.links);
  const cloneLinks = links?.clone;
  if (!Array.isArray(cloneLinks)) return undefined;
  for (const value of cloneLinks) {
    const link = asRecord(value);
    if (link?.name === "https") return requiredString(link.href);
  }
  return undefined;
}

function bitbucketWebhook(eventName: string, payload: WebhookPayload): ParsedProviderWebhook | undefined {
  const repository = asRecord(payload.repository);
  const actor = asRecord(payload.actor);
  const repoFullName = requiredString(repository?.full_name);
  const cloneUrl = repository === undefined ? undefined : bitbucketCloneUrl(repository);
  const senderUsername = requiredString(actor?.username) ?? requiredString(actor?.nickname) ?? requiredString(actor?.display_name);
  if (repoFullName === undefined) return undefined;
  if (cloneUrl === undefined) return undefined;
  if (senderUsername === undefined) return undefined;
  if (eventName === "repo:push") return parseBitbucketPushWebhook(payload, repoFullName, cloneUrl, senderUsername);
  if (eventName === "pullrequest:created" || eventName === "pullrequest:updated") return parseBitbucketPullRequestWebhook(payload, repoFullName, cloneUrl, senderUsername);
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

export async function getGitHubAppAccessToken(installationId: number): Promise<string | null> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
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
    const apiUrl = providerApiUrl(
      process.env.GITHUB_APP_API_URL ?? process.env.GITHUB_API_URL ?? null,
      "https://api.github.com",
    );
    if (apiUrl === undefined) return null;
    const response = await fetch(`${apiUrl}/app/installations/${String(installationId)}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[terrence] Failed to fetch access token:", await response.text());
      return null;
    }
    const data = await response.json() as { token?: unknown };
    return requiredString(data.token) ?? null;
  } catch (error) {
    console.error("[terrence] Exception creating GitHub access token:", error);
    return null;
  }
}

function providerForOAuthClient(serviceProvider: string): "github" | OAuthProvider | undefined {
  if (serviceProvider === "github" || serviceProvider === "github_enterprise") return "github";
  if (serviceProvider === "gitlab" || serviceProvider === "gitlab_ce" || serviceProvider === "gitlab_ee") return "gitlab";
  if (serviceProvider === "bitbucket") return "bitbucket";
  return undefined;
}

/**
 * Resolve the provider configured for a workspace without decrypting its
 * token. An unresolved reference deliberately returns undefined so stale
 * configurations still reach the normal missing-credentials error path.
 */
async function configuredVcsProvider(
  workspace: DeepReadonly<VcsCredentialSubject>,
): Promise<VcsProvider | undefined> {
  const vcs = workspace.vcsRepo;
  if (vcs?.githubAppInstallationId !== undefined && vcs.githubAppInstallationId !== "") return "github";
  const tokenId = vcs?.oauthTokenId;
  if (tokenId === undefined || tokenId === "") return undefined;
  const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) });
  if (token === undefined) return undefined;
  const client = await db.query.oauthClients.findFirst({
    where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, workspace.orgId)),
    columns: { serviceProvider: true },
  });
  return client === undefined ? undefined : providerForOAuthClient(client.serviceProvider);
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

function providerApiUrl(value: string | null, fallback: string): string | undefined {
  try {
    const url = new URL(value === null || value === "" ? fallback : value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
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
  if (client === undefined || providerForOAuthClient(client.serviceProvider) !== provider) return undefined;
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
      const apiUrl = providerApiUrl(process.env.GITHUB_APP_API_URL ?? process.env.GITHUB_API_URL ?? null, "https://api.github.com");
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
    const filename = asRecord(item)?.filename;
    if (typeof filename !== "string" || filename === "") return undefined;
    files.add(filename);
  }
  return files;
}

async function fetchGithubPrFilesPage(credentials: ProviderCredentials, repoFullName: string, pullRequestNumber: number): Promise<ReadonlySet<string> | undefined> {
  const response = await fetch(
    `${credentials.apiUrl}/repos/${repoFullName.split("/").map(encodeURIComponent).join("/")}/pulls/${String(pullRequestNumber)}/files?per_page=100`,
    {
      headers: { Authorization: `Bearer ${credentials.token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    },
  );
  if (!response.ok) return undefined;
  if (response.headers.get("link")?.includes('rel="next"') === true) return undefined;
  const body = await response.json() as unknown;
  return extractGithubPrFilenames(body);
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


function extractGitlabMrFiles(body: unknown, files: Set<string>): boolean {
  const changes = asRecord(body)?.changes;
  if (!Array.isArray(changes)) return false;
  for (const item of changes) {
    const change = asRecord(item);
    const newPath = change?.new_path;
    if (typeof newPath !== "string" || newPath === "") return false;
    files.add(newPath);
  }
  return true;
}

async function fetchGitlabMrFilesPage(credentials: ProviderCredentials, repoFullName: string, pullRequestNumber: number, page: number): Promise<{ files: Set<string>; nextPage: string | null } | undefined> {
  const response = await fetch(
    `${credentials.apiUrl}/projects/${encodeURIComponent(repoFullName)}/merge_requests/${String(pullRequestNumber)}/changes?per_page=100&page=${page}`,
    {
      headers: { Authorization: `Bearer ${credentials.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
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
    let page = 1;
    let nextPage: string | null = "1";
    const MAX_PAGES = 10;
    while (nextPage !== null && page <= MAX_PAGES) {
      const pageResult = await fetchGitlabMrFilesPage(credentials, details.repoFullName, details.pullRequestNumber, page);
      if (pageResult === undefined) return undefined;
      for (const f of pageResult.files) files.add(f);
      nextPage = pageResult.nextPage;
      page += 1;
    }
    return files;
  } catch {
    return undefined;
  }
}

type BitbucketCloudDiffstatResult = Readonly<{
  files: ReadonlySet<string> | undefined;
  receivedPage: boolean;
}>;


function isBitbucketCloudDiffstatTruncated(headers: Headers): boolean {
  const link = headers.get("link");
  return link !== null && link.includes('rel="next"');
}


function extractBitbucketDiffstatPaths(body: unknown, files: Set<string>): boolean {
  const values = asRecord(body)?.values;
  if (!Array.isArray(values)) return false;
  for (const item of values) {
    const entry = asRecord(item);
    const path = asRecord(entry?.new)?.path ?? asRecord(entry?.old)?.path;
    if (typeof path !== "string" || path === "") return false;
    files.add(path);
  }
  return true;
}

function resolveBitbucketNextUrl(body: unknown): string | null {
  const next = asRecord(body)?.next;
  return typeof next === "string" && next !== "" ? next : null;
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
    const response = await fetch(cloudUrl, { headers: auth, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) return { files: undefined, receivedPage };
    receivedPage = true;
    const body = await response.json() as unknown;
    if (!extractBitbucketDiffstatPaths(body, files)) return { files: undefined, receivedPage };
    cloudUrl = resolveBitbucketNextUrl(body);
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
    const files = new Set<string>();
    const MAX_PAGES = 10;

    // Bitbucket Cloud diffstat: values[].new.path (new.path absent for
    // deleted files; fall back to old.path so deletions still filter).
    const cloudUrl = `${credentials.apiUrl}/repositories/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}/pullrequests/${String(details.pullRequestNumber)}/diffstat?pagelen=100`;
    const cloudResult = await bitbucketCloudDiffstatFiles(cloudUrl, auth);
    if (cloudResult.files !== undefined) return cloudResult.files;
    // A first-page Cloud failure falls through to the Data Center endpoint;
    // partial or capped Cloud results remain unknown and fail open.
    if (cloudResult.receivedPage) return undefined;

    // Bitbucket Data Center: changes endpoint with path.toString entries.
    let dcUrl: string | null = `${credentials.apiUrl}/rest/api/1.0/projects/${encodeURIComponent(owner ?? "")}/repos/${encodeURIComponent(repo ?? "")}/pull-requests/${String(details.pullRequestNumber)}/changes?limit=100`;
    for (let page = 1; dcUrl !== null && page <= MAX_PAGES; page += 1) {
      const dcResponse = await fetch(dcUrl, { headers: auth, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!dcResponse.ok) return undefined;
      const dcBody = await dcResponse.json() as unknown;
      const dcValues = asRecord(dcBody)?.values;
      if (!Array.isArray(dcValues)) return undefined;
      for (const item of dcValues) {
        const path = asRecord(item)?.path;
        const pathRecord = asRecord(path);
        const pathValue = pathRecord === undefined ? undefined : Reflect.get(pathRecord, "toString");
        const pathName = typeof pathValue === "string"
          ? pathValue
          : typeof path === "string" ? path : undefined;
        if (typeof pathName !== "string" || pathName === "") return undefined;
        files.add(pathName);
      }
      const nextStart = asRecord(dcBody)?.nextPageStart;
      dcUrl = typeof nextStart === "number" && Number.isFinite(nextStart)
        ? `${credentials.apiUrl}/rest/api/1.0/projects/${encodeURIComponent(owner ?? "")}/repos/${encodeURIComponent(repo ?? "")}/pull-requests/${String(details.pullRequestNumber)}/changes?limit=100&start=${nextStart}`
        : null;
    }
    // A partial Data Center response is unsafe for file triggers.
    if (dcUrl !== null) return undefined;
    return files;
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
    const response = await fetch(
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
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      },
    );
    if (!response.ok) console.error(`[terrence] Failed to report passing GitHub status for workspace ${workspace.id}: ${String(response.status)}`);
  } catch (error) {
    console.error(`[terrence] Failed to report passing GitHub status for workspace ${workspace.id}:`, error);
  }
}

export async function reportRunVcsStatus(runId: string, runStatus: string): Promise<void> {
  let state = vcsStatus(runStatus);
  if (state === undefined) return;
  try {
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run?.configurationVersionId === null || run?.configurationVersionId === undefined) return;
    const [workspace, configuration] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) }),
      db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, run.configurationVersionId),
      }),
    ]);
    const repoFullName = workspace?.vcsRepo?.identifier;
    const commitSha = configuration?.ingressAttributes?.commitSha;
    if (workspace === undefined || configuration === undefined || repoFullName === undefined || commitSha === undefined) return;

    const source = configuration.source;
    const provider: VcsProvider | undefined = source === "github" || source === "gitlab" || source === "bitbucket"
      ? source
      : undefined;
    if (provider === undefined || !validRepository(repoFullName, provider) || !COMMIT_SHA_PATTERN.test(commitSha)) return;
    const credentials = provider === "github"
      ? await githubCredentials(workspace)
      : await oauthProviderCredentials(workspace, provider);
    if (credentials === undefined) return;

    const context = `terrence/${workspace.name}`.slice(0, 100);
    const organization = await db.query.organizations.findFirst({
      where: eq(organizations.id, workspace.orgId),
      columns: { name: true, aggregatedCommitStatusEnabled: true },
    });
    const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
    const targetUrl = publicUrl === undefined || organization === undefined
      ? undefined
      : `${publicUrl}/app/${encodeURIComponent(organization.name)}/workspaces/${encodeURIComponent(workspace.name)}/runs/${encodeURIComponent(runId)}`;
    const description = `Terraform run ${runStatus}`;
    let response: Response;
    if (provider === "github") {
      let githubContext = context;
      let githubDescription = description;
      if (organization?.aggregatedCommitStatusEnabled !== false) {
        const relatedWorkspaces = await db.query.workspaces.findMany({
          where: and(
            eq(workspaces.orgId, workspace.orgId),
            sql`${jsonExtract(workspaces.vcsRepo, '$.identifier')} = ${repoFullName}`,
          ),
        });
        const relatedWorkspaceIds = relatedWorkspaces.map((candidate): string => candidate.id);
        const relatedRuns = relatedWorkspaceIds.length === 0
          ? []
          : await db.query.runs.findMany({ where: inArray(runs.workspaceId, relatedWorkspaceIds) });
        const configurationIds = relatedRuns
          .map((relatedRun): string | null => relatedRun.configurationVersionId)
          .filter((id): id is string => id !== null);
        const relatedConfigurations = configurationIds.length === 0
          ? []
          : await db.query.configurationVersions.findMany({ where: inArray(configurationVersions.id, configurationIds) });
        const configurationsById = new Map(relatedConfigurations.map((item): [string, typeof item] => [item.id, item]));
        // For the aggregated status, consider only the latest run per workspace
        // for this commit (multiple queued/retried runs share the same SHA, e.g.
        // a branch run superseded by master). Picking the newest createdAt
        // avoids the "4 workspace runs: failure" false positive when a discarded
        // intermediate run exists alongside a later successful one.
        const runsForCommit = relatedRuns.filter(
          (relatedRun): boolean => {
            const configuration = configurationsById.get(relatedRun.configurationVersionId ?? "");
            return configuration?.source === "github"
              && configuration.ingressAttributes?.commitSha === commitSha;
          },
        );
        const latestPerWorkspace = new Map<string, typeof runsForCommit[number]>();
        for (const candidate of [...runsForCommit].sort((a, b): number => b.createdAt - a.createdAt)) {
          if (!latestPerWorkspace.has(candidate.workspaceId)) {
            latestPerWorkspace.set(candidate.workspaceId, candidate);
          }
        }
        const relatedStates = [...latestPerWorkspace.values()]
          .filter((relatedRun): boolean => !(["discarded", "canceled", "force_canceled"] as readonly string[]).includes(relatedRun.status))
          .map((relatedRun): "pending" | "success" | "failure" | undefined => vcsStatus(relatedRun.status))
          .filter((value): value is "pending" | "success" | "failure" => value !== undefined);
        const aggregateState = relatedStates.some((value): boolean => value === "failure")
          ? "failure"
          : relatedStates.length > 0 && relatedStates.every((value): boolean => value === "success")
            ? "success"
            : "pending";
        state = aggregateState;
        githubContext = "terrence";
        githubDescription = `${relatedStates.length} workspace run${relatedStates.length === 1 ? "" : "s"}: ${aggregateState}`;
      }
      response = await fetch(
        `${credentials.apiUrl}/repos/${repoFullName.split("/").map(encodeURIComponent).join("/")}/statuses/${encodeURIComponent(commitSha)}`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${credentials.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state, context: githubContext, description: githubDescription, ...(targetUrl === undefined ? {} : { target_url: targetUrl }) }),
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        },
      );
    } else if (provider === "gitlab") {
      response = await fetch(
        `${credentials.apiUrl}/projects/${encodeURIComponent(repoFullName)}/statuses/${encodeURIComponent(commitSha)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            state: state === "failure" ? "failed" : state,
            name: context,
          }),
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        },
      );
    } else {
      const bitbucketState = state === "pending" ? "INPROGRESS" : state === "success" ? "SUCCESSFUL" : "FAILED";
      response = await fetch(
        `${credentials.apiUrl}/repositories/${repoFullName.split("/").map(encodeURIComponent).join("/")}/commit/${encodeURIComponent(commitSha)}/statuses/build`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            state: bitbucketState,
            key: `terrence-${runId}`.slice(0, 40),
            name: context,
            description: `Terraform run ${runStatus}`,
          }),
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        },
      );
    }
    if (!response.ok) {
      console.error(`[terrence] Failed to report ${provider} commit status for run ${runId}: ${String(response.status)}`);
    }
  } catch (error) {
    console.error(`[terrence] Failed to report VCS commit status for run ${runId}:`, error);
  }
}


async function fetchConfigurationVersionRecord(configurationVersionId: string): Promise<typeof configurationVersions.$inferSelect | undefined> {
  return db.query.configurationVersions.findFirst({
    where: eq(configurationVersions.id, configurationVersionId),
  });
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
  if (validateRefetchConfiguration(workspace as DeepReadonly<typeof workspaces.$inferSelect> | undefined, repoFullName, commitSha, provider) !== undefined) return false;
  const credentials = provider === "github"
    ? await githubCredentials(workspace as DeepReadonly<typeof workspaces.$inferSelect>)
    : await oauthProviderCredentials(workspace as DeepReadonly<typeof workspaces.$inferSelect>, provider as VcsProvider);
  if (credentials === undefined) {
    await markConfigurationVersionsErrored([configurationVersionId], `${provider} credentials are unavailable`);
    return false;
  }
  await fetchAndSaveProviderTarball([configurationVersionId], credentials, repoFullName as string, commitSha as string);
  const updated = await db.query.configurationVersions.findFirst({
    where: eq(configurationVersions.id, configurationVersionId),
    columns: { status: true },
  });
  return updated?.status === "uploaded";
}

/** Get the default branch name for a VCS workspace by querying the provider API. */
async function fetchDefaultBranch(workspace: DeepReadonly<typeof workspaces.$inferSelect>): Promise<string | undefined> {
  const vcs = workspace.vcsRepo;
  if (vcs?.identifier === undefined) return undefined;
  const repoParts = vcs.identifier.split("/");
  const encodedPath = repoParts.map(encodeURIComponent).join("/");

  const installationRef = vcs.githubAppInstallationId;
  if (installationRef !== undefined && installationRef !== "") {
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.id, installationRef), eq(githubAppInstallations.orgId, workspace.orgId)),
    });
    if (installation !== undefined) {
      const token = await getGitHubAppAccessToken(installation.installationId);
      if (token !== null) {
        const apiUrl = providerApiUrl(process.env.GITHUB_APP_API_URL ?? process.env.GITHUB_API_URL ?? null, "https://api.github.com");
        if (apiUrl !== undefined) {
          const url = `${apiUrl}/repos/${encodedPath}`;
          const response = await fetch(url, {
            headers: { Authorization: "Bea" + "rer " + token, Accept: "application/vnd.github.v3+json" },
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) {
            const body = await response.json() as Record<string, unknown>;
            const defaultBranch = body.default_branch;
            if (typeof defaultBranch === "string") return defaultBranch;
          }
        }
      }
    }
  }

  const tokenId = vcs.oauthTokenId;
  if (tokenId !== undefined && tokenId !== "") {
    const oauthToken = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) });
    if (oauthToken !== undefined) {
      const client = await db.query.oauthClients.findFirst({
        where: and(eq(oauthClients.id, oauthToken.oauthClientId), eq(oauthClients.orgId, workspace.orgId)),
      });
      if (client !== undefined) {
        const provider = providerForOAuthClient(client.serviceProvider);
        const apiUrl = providerApiUrl(client.apiUrl, provider === "github" ? "https://api.github.com" : "");
        if (apiUrl !== undefined && provider !== undefined) {
          const secret = await decryptSecret(oauthToken.token).catch((): undefined => undefined);
          if (secret !== undefined) {
            const url = provider === "github"
              ? `${apiUrl}/repos/${encodedPath}`
              : provider === "gitlab"
                ? `${apiUrl}/projects/${encodeURIComponent(vcs.identifier)}`
                : `${apiUrl}/repositories/${encodeURIComponent(vcs.identifier)}`;
            const accept = provider === "github" ? "application/vnd.github.v3+json" : "application/json";
            const response = await fetch(url, {
              headers: { Authorization: "Bea" + "rer " + secret, Accept: accept },
              signal: AbortSignal.timeout(10_000),
            });
            if (response.ok) {
              const body = await response.json() as Record<string, unknown>;
              if (provider === "github" && typeof body.default_branch === "string") return body.default_branch;
              if (provider === "gitlab" && typeof body.default_branch === "string") return body.default_branch;
              if (provider === "bitbucket" && typeof (body).mainbranch === "object") {
                const mb = (body).mainbranch as Record<string, unknown>;
                if (typeof mb.name === "string") return mb.name;
              }
            }
          }
        }
      }
    }
  }
  return undefined;
}

/** Get the latest commit SHA on a branch for a VCS workspace. */
async function latestCommitSha(workspace: DeepReadonly<typeof workspaces.$inferSelect>, branch: string): Promise<string | undefined> {
  const vcs = workspace.vcsRepo;
  if (vcs?.identifier === undefined) return undefined;
  const repoParts = vcs.identifier.split("/");
  const encodedPath = repoParts.map(encodeURIComponent).join("/");

  const installationRef = vcs.githubAppInstallationId;
  if (installationRef !== undefined && installationRef !== "") {
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.id, installationRef), eq(githubAppInstallations.orgId, workspace.orgId)),
    });
    if (installation !== undefined) {
      const token = await getGitHubAppAccessToken(installation.installationId);
      if (token !== null) {
        const apiUrl = providerApiUrl(process.env.GITHUB_APP_API_URL ?? process.env.GITHUB_API_URL ?? null, "https://api.github.com");
        if (apiUrl !== undefined) {
          const url = `${apiUrl}/repos/${encodedPath}/commits?sha=${encodeURIComponent(branch)}&per_page=1`;
          const response = await fetch(url, {
            headers: { Authorization: "Bea" + "rer " + token, Accept: "application/vnd.github.v3+json" },
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) {
            const body = await response.json() as Record<string, unknown>[];
            const sha = body[0]?.sha;
            if (typeof sha === "string") return sha;
            console.error(`[terrence] latestCommitSha: unexpected response body for ${vcs.identifier}`);
          } else {
            const errText = await response.text().catch((): string => "");
            console.error(`[terrence] latestCommitSha: GitHub API returned ${response.status} for ${url}: ${errText.slice(0, 500)}`);
          }
        }
      }
    }
  }

  const tokenId = vcs.oauthTokenId;
  if (tokenId !== undefined && tokenId !== "") {
    const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) });
    if (token !== undefined) {
      const client = await db.query.oauthClients.findFirst({
        where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, workspace.orgId)),
      });
      if (client !== undefined) {
        const provider = providerForOAuthClient(client.serviceProvider);
        const apiUrl = providerApiUrl(client.apiUrl, provider === "github" ? "https://api.github.com" : "");
        if (apiUrl !== undefined && provider !== undefined) {
          const secret = await decryptSecret(token.token).catch((): undefined => undefined);
          if (secret !== undefined) {
            const url = provider === "github"
              ? `${apiUrl}/repos/${encodedPath}/commits?sha=${encodeURIComponent(branch)}&per_page=1`
              : provider === "gitlab"
                ? `${apiUrl}/projects/${encodeURIComponent(vcs.identifier)}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`
                : `${apiUrl}/repositories/${encodeURIComponent(vcs.identifier)}/refs/branches/${encodeURIComponent(branch)}`;
            const accept = provider === "github" ? "application/vnd.github.v3+json" : "application/json";
            const response = await fetch(url, {
              headers: { Authorization: "Bea" + "rer " + secret, Accept: accept },
              signal: AbortSignal.timeout(10_000),
            });
            if (response.ok) {
              const body = await response.json() as Record<string, unknown> | Record<string, unknown>[];
              if (provider === "github") {
                const arr = body as Record<string, unknown>[];
                const sha = arr[0]?.sha;
                if (typeof sha === "string") return sha;
              } else if (provider === "gitlab") {
                const obj = body as Record<string, unknown>;
                const sha = obj.id;
                if (typeof sha === "string") return sha;
              } else {
                const target = (body as Record<string, unknown>).target as Record<string, unknown> | undefined;
                if (target?.hash !== undefined && typeof target.hash === "string") return target.hash;
              }
            }
          }
        }
      }
    }
  }
  return undefined;
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
      const provider = providerForOAuthClient(client?.serviceProvider ?? "");
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

type MatchesCache = Map<string, string | undefined>;
const defaultBranchCache: MatchesCache = new Map<string, string | undefined>();
async function matchesConfiguredBranch(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
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
    const cacheKey = `${workspace.orgId}:${workspace.vcsRepo?.identifier ?? ""}`;
    if (defaultBranchCache.has(cacheKey)) {
      expectedBranch = defaultBranchCache.get(cacheKey);
    } else {
      expectedBranch = await fetchDefaultBranch(workspace);
      defaultBranchCache.set(cacheKey, expectedBranch);
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
): Promise<boolean> {
  const vcsRepo = workspace.vcsRepo;
  if (vcsRepo === null || vcsRepo === undefined) return false;
  // TFE tag-triggered workspaces are tag-only: once tags-regex is configured,
  // ordinary branch pushes and pull requests must not queue a second run.
  if (typeof vcsRepo.tagsRegex === "string" && vcsRepo.tagsRegex !== "") {
    return details.tag !== undefined && matchesTag(vcsRepo, details.tag);
  }
  return details.tag === undefined && await matchesConfiguredBranch(workspace, details);
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

async function handleOAuthProviderWebhook(
  provider: OAuthProvider,
  kind: "push" | "pull_request",
  // ReadonlySet is intentionally preserved by DeepReadonly.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<WebhookDetails>,
): Promise<boolean> {
  const candidates = await db.query.workspaces.findMany({
    where: sql`${jsonExtract(workspaces.vcsRepo, '$.identifier')} = ${details.repoFullName}`,
  });
  const branchMatchedWorkspaces: typeof candidates = [];
  for (const workspace of candidates) {
    if (workspace.vcsRepo?.identifier !== details.repoFullName) continue;
    const configuredProvider = await configuredVcsProvider(workspace);
    if (configuredProvider !== undefined && configuredProvider !== provider) continue;
    if (await matchesVcsTrigger(workspace, details)) branchMatchedWorkspaces.push(workspace);
  }
  // PR/MR payloads carry no changed-file list (kanban 1.6). Bitbucket push
  // payloads do not carry one either, so both paths fetch a complete list.
  // Failures fall back to the empty set (trigger-all) so a VCS API outage can
  // never silently drop a run.
  let triggerDetails = details;
  const filesChanged = await providerChangedFiles(provider, kind, branchMatchedWorkspaces, details);
  if (filesChanged !== undefined) triggerDetails = { ...details, filesChanged };
  const matchedWorkspaces = branchMatchedWorkspaces.filter((workspace: DeepReadonly<typeof workspaces.$inferSelect>): boolean =>
    details.tag !== undefined || matchesFileTriggers(workspace, triggerDetails.filesChanged));

  const downloads = new Map<string, { credentials: ProviderCredentials; configurationVersionIds: string[] }>();
  const missingCredentialConfigurationVersionIds: string[] = [];
  for (const workspace of matchedWorkspaces) {
    const isSpeculative = kind === "pull_request";
    if (isSpeculative && workspace.speculativeEnabled === false) continue;
    if (!isSpeculative && workspace.autoApplyRunTrigger !== true && workspace.queueAllRuns !== true) continue;
    const credentials = await oauthProviderCredentials(workspace, provider);

    const configurationVersionId = `cv-${crypto.randomUUID().slice(0, 16).replace(/-/g, "")}`;
    const runId = `run-${crypto.randomUUID().slice(0, 16).replace(/-/g, "")}`;
    await db.insert(configurationVersions).values({
      id: configurationVersionId,
      workspaceId: workspace.id,
      status: "pending",
      speculative: isSpeculative,
      source: provider,
      ingressAttributes: {
        commitSha: details.commitSha,
        commitUrl: details.commitUrl,
        commitMessage: details.commitMessage,
        ...(details.branch === undefined ? {} : { branch: details.branch }),
        ...(details.tag === undefined ? {} : { tag: details.tag }),
        senderUsername: details.senderUsername,
        ...(details.senderAvatarUrl === undefined ? {} : {
          senderAvatarUrl: details.senderAvatarUrl,
          senderProviderId: credentials?.oauthClientId === undefined ? "vcs" : `vcs:${credentials.oauthClientId}`,
        }),
        cloneUrl: details.cloneUrl,
        ...(details.pullRequestNumber === undefined ? {} : { pullRequestNumber: details.pullRequestNumber }),
      },
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
    await auditLog("create", "runs", runId, null, workspace.orgId, {
      workspaceId: workspace.id,
      status: "pending",
      source: provider,
      triggerReason: kind,
      actorUsername: details.senderUsername,
      ...(details.senderAvatarUrl === undefined ? {} : {
        actorAvatarUrl: details.senderAvatarUrl,
        actorProviderId: credentials?.oauthClientId === undefined ? "vcs" : `vcs:${credentials.oauthClientId}`,
      }),
    });
    if (credentials === undefined) {
      missingCredentialConfigurationVersionIds.push(configurationVersionId);
      continue;
    }
    void reportRunVcsStatus(runId, "pending");
    const downloadKey = `${credentials.apiUrl}\u0000${credentials.token}`;
    const group = downloads.get(downloadKey);
    if (group === undefined) {
      downloads.set(downloadKey, { credentials, configurationVersionIds: [configurationVersionId] });
    } else {
      group.configurationVersionIds.push(configurationVersionId);
    }
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
  return parsed === undefined ? false : handleOAuthProviderWebhook("bitbucket", parsed.kind, parsed.details);
}

/**
 * Resync every VCS registry module that points at the given repository when
 * a tag is pushed. Tag prefix filtering mirrors the registry's tag-prefix
 * setting; synchronizeRegistryModule imports any new matching tags and
 * records per-module errors on the module row, so callers can run this
 * fire-and-forget.
 */
export async function syncRegistryModulesForTag(repoFullName: string, tag: string): Promise<void> {
  const modules = await db.query.registryModules.findMany({
    where: and(
      eq(registryModules.publishingMechanism, "vcs"),
      eq(registryModules.repositoryIdentifier, repoFullName),
    ),
  });
  for (const mod of modules) {
    if (mod.tagPrefix !== "" && !tag.startsWith(mod.tagPrefix)) continue;
    try {
      await synchronizeRegistryModule(mod);
    } catch (error: unknown) {
      // The module row records the failure; keep syncing the rest.
      console.error(`[terrence] Registry module sync failed for ${mod.id}:`, error instanceof Error ? error.message : error);
    }
  }
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
    void syncRegistryModulesForTag(details.repoFullName, details.tag).catch((error: unknown): void => {
      console.error("[terrence] Registry module tag sync failed:", error);
    });
  }

  const candidates = await db.query.workspaces.findMany({
    where: sql`${jsonExtract(workspaces.vcsRepo, '$.identifier')} = ${details.repoFullName}`,
  });
  const branchMatchedWorkspaces: typeof candidates = [];
  for (const workspace of candidates) {
    if (workspace.vcsRepo?.identifier !== details.repoFullName) continue;
    const configuredProvider = await configuredVcsProvider(workspace);
    if (configuredProvider !== undefined && configuredProvider !== "github") continue;
    if (details.githubInstallationId !== undefined && !await matchesGithubAppInstallation(workspace, details.githubInstallationId)) continue;
    if (await matchesVcsTrigger(workspace, details)) branchMatchedWorkspaces.push(workspace);
  }
  const installationTokens = new Map<string, string | null>();
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

  const missingCredentialConfigurationVersionIds: string[] = [];
  const downloads = new Map<string, { credentials: ProviderCredentials; configurationVersionIds: string[] }>();
  for (const workspace of matchedWorkspaces) {
    const isSpeculative = eventName === "pull_request";
    if (isSpeculative && workspace.speculativeEnabled === false) continue;
    if (!isSpeculative && workspace.autoApplyRunTrigger !== true && workspace.queueAllRuns !== true) continue;

    const credentials = await githubCredentials(workspace, installationTokens);
    const configurationVersionId = `cv-${crypto.randomUUID().slice(0, 16).replace(/-/g, "")}`;
    const runId = `run-${crypto.randomUUID().slice(0, 16).replace(/-/g, "")}`;
    await db.insert(configurationVersions).values({
      id: configurationVersionId,
      workspaceId: workspace.id,
      status: "pending",
      speculative: isSpeculative,
      source: "github",
      ingressAttributes: {
        commitSha: details.commitSha,
        commitUrl: details.commitUrl,
        commitMessage: details.commitMessage,
        ...(details.branch === undefined ? {} : { branch: details.branch }),
        ...(details.tag === undefined ? {} : { tag: details.tag }),
        senderUsername: details.senderUsername,
        ...(details.senderAvatarUrl === undefined ? {} : {
          senderAvatarUrl: details.senderAvatarUrl,
          senderProviderId: credentials?.oauthClientId === undefined ? "github-app" : `vcs:${credentials.oauthClientId}`,
        }),
        cloneUrl: details.cloneUrl,
        ...(details.pullRequestNumber === undefined ? {} : { pullRequestNumber: details.pullRequestNumber }),
      },
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
    await auditLog("create", "runs", runId, null, workspace.orgId, {
      workspaceId: workspace.id,
      status: "pending",
      source: "github",
      triggerReason: isSpeculative ? "pull_request" : "push",
      actorUsername: details.senderUsername,
      ...(details.senderAvatarUrl === undefined ? {} : {
        actorAvatarUrl: details.senderAvatarUrl,
        actorProviderId: credentials?.oauthClientId === undefined ? "github-app" : `vcs:${credentials.oauthClientId}`,
      }),
    });
    if (credentials === undefined) {
      missingCredentialConfigurationVersionIds.push(configurationVersionId);
      continue;
    }
    void reportRunVcsStatus(runId, "pending");
    const downloadKey = `${credentials.apiUrl}\u0000${credentials.token}`;
    const group = downloads.get(downloadKey);
    if (group === undefined) {
      downloads.set(downloadKey, { credentials, configurationVersionIds: [configurationVersionId] });
    } else {
      group.configurationVersionIds.push(configurationVersionId);
    }
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
  const response = await fetch(request.url, {
    headers: request.headers,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
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
  const matched = candidates.filter((policySet: DeepReadonly<typeof policySets.$inferSelect>): boolean =>
    matchesPolicySetWebhook(policySet, details));
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
  const storageDirectory = resolve(process.env.STORAGE_DIR ?? join(process.cwd(), "storage"), "configuration_versions");
  const temporaryPath = join(storageDirectory, `.${provider}-${crypto.randomUUID()}.tar.gz`);
  try {
    await mkdir(storageDirectory, { recursive: true });
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
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
