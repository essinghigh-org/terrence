import { copyFile, mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import jwt from "jsonwebtoken";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { configurationVersions, githubAppInstallations, runs, workspaces } from "../db/schema";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
  ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T;
type WebhookPayload = Readonly<Record<string, unknown>>;
type VcsRepo = NonNullable<typeof workspaces.$inferSelect.vcsRepo>;
type WebhookDetails = Readonly<{
  readonly branch: string;
  readonly cloneUrl: string;
  readonly commitMessage: string;
  readonly commitSha: string;
  readonly commitUrl: string;
  readonly filesChanged: ReadonlySet<string>;
  readonly pullRequestNumber?: number;
  readonly repoFullName: string;
  readonly senderUsername: string;
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

function parseWebhook(eventName: string, payload: WebhookPayload): WebhookDetails | undefined {
  const repository = asRecord(payload["repository"]);
  const sender = asRecord(payload["sender"]);
  const repoFullName = requiredString(repository?.["full_name"]);
  const cloneUrl = requiredString(repository?.["clone_url"]);
  const senderUsername = requiredString(sender?.["login"]);
  if (repoFullName === undefined || cloneUrl === undefined || senderUsername === undefined) return undefined;

  if (eventName === "push") {
    const ref = requiredString(payload["ref"]);
    const commitSha = requiredString(payload["after"]);
    const headCommit = asRecord(payload["head_commit"]);
    const commitMessage = requiredString(headCommit?.["message"]);
    const commitUrl = requiredString(headCommit?.["url"]);
    const filesChanged = changedFiles(payload);
    if (ref === undefined || !ref.startsWith("refs/heads/") || commitSha === undefined || commitMessage === undefined || commitUrl === undefined || filesChanged === undefined) return undefined;
    const branch = ref.slice("refs/heads/".length);
    if (branch === "") return undefined;
    return { branch, cloneUrl, commitMessage, commitSha, commitUrl, filesChanged, repoFullName, senderUsername };
  }

  if (eventName === "pull_request" && (payload["action"] === "opened" || payload["action"] === "synchronize")) {
    const pullRequest = asRecord(payload["pull_request"]);
    const head = asRecord(pullRequest?.["head"]);
    const branch = requiredString(head?.["ref"]);
    const commitSha = requiredString(head?.["sha"]);
    const commitMessage = requiredString(pullRequest?.["title"]);
    const commitUrl = requiredString(pullRequest?.["html_url"]);
    const pullRequestNumber = payload["number"];
    if (branch === undefined || commitSha === undefined || commitMessage === undefined || commitUrl === undefined || typeof pullRequestNumber !== "number" || !Number.isSafeInteger(pullRequestNumber)) return undefined;
    return { branch, cloneUrl, commitMessage, commitSha, commitUrl, filesChanged: new Set<string>(), pullRequestNumber, repoFullName, senderUsername };
  }

  return undefined;
}

function matchesFileTriggers(workspace: DeepReadonly<typeof workspaces.$inferSelect>, files: Readonly<ReadonlySet<string>>): boolean {
  if (workspace.fileTriggersEnabled !== true || files.size === 0) return true;
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

async function getGitHubAppAccessToken(installationId: number): Promise<string | null> {
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
    const response = await fetch(`https://api.github.com/app/installations/${String(installationId)}/access_tokens`, {
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

export async function handleGithubWebhook(eventName: string, payload: WebhookPayload): Promise<void> {
  const details = parseWebhook(eventName, payload);
  if (details === undefined) return;

  const candidates = await db.query.workspaces.findMany({
    where: sql`json_extract(${workspaces.vcsRepo}, '$.identifier') = ${details.repoFullName}`,
  });
  const matchedWorkspaces = candidates.filter((workspace: DeepReadonly<typeof workspaces.$inferSelect>): boolean => {
    const vcsRepo = workspace.vcsRepo;
    if (vcsRepo?.identifier !== details.repoFullName) return false;
    if (vcsRepo.branch !== undefined && vcsRepo.branch !== "" && vcsRepo.branch !== details.branch) return false;
    return matchesFileTriggers(workspace, details.filesChanged);
  });

  const configurationVersionIds: string[] = [];
  const downloadableConfigurationVersionIds: string[] = [];
  let token: string | null = null;
  const installationTokens = new Map<string, string | null>();
  for (const workspace of matchedWorkspaces) {
    const isSpeculative = eventName === "pull_request";
    if (isSpeculative && workspace.speculativeEnabled === false) continue;
    if (!isSpeculative && workspace.autoApplyRunTrigger !== true && workspace.queueAllRuns !== true) continue;

    if (workspace.vcsRepo === null) continue;
    const vcsRepo: VcsRepo = workspace.vcsRepo;
    const installationReference = vcsRepo.githubAppInstallationId;
    let workspaceToken: string | null = null;
    if (installationReference !== undefined && installationReference !== "") {
      const installationKey = `${workspace.orgId}:${installationReference}`;
      const cachedToken = installationTokens.get(installationKey);
      if (cachedToken !== undefined) {
        workspaceToken = cachedToken;
      } else {
        const installation = await db.query.githubAppInstallations.findFirst({
          where: and(eq(githubAppInstallations.id, installationReference), eq(githubAppInstallations.orgId, workspace.orgId)),
        });
        workspaceToken = installation === undefined ? null : await getGitHubAppAccessToken(installation.installationId);
        installationTokens.set(installationKey, workspaceToken);
      }
    }
    token ??= workspaceToken;

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
        branch: details.branch,
        senderUsername: details.senderUsername,
        cloneUrl: details.cloneUrl,
        ...(details.pullRequestNumber === undefined ? {} : { pullRequestNumber: details.pullRequestNumber }),
      },
      statusTimestamps: {},
    });
    await db.insert(runs).values({
      id: runId,
      workspaceId: workspace.id,
      configurationVersionId,
      message: `Triggered by ${eventName === "push" ? "push" : "pull request"} to ${details.repoFullName}`,
      status: "pending",
      isDestroy: false,
      autoApply: workspace.autoApply === true && !isSpeculative,
      planOnly: isSpeculative,
      statusTimestamps: { "pending-at": new Date().toISOString() },
      logToken: crypto.randomUUID(),
      createdAt: Date.now(),
    });
    configurationVersionIds.push(configurationVersionId);
    if (workspaceToken !== null) downloadableConfigurationVersionIds.push(configurationVersionId);
  }

  if (configurationVersionIds.length === 0) return;
  const missingTokenConfigurationVersionIds = configurationVersionIds.filter((id: string): boolean => !downloadableConfigurationVersionIds.includes(id));
  if (missingTokenConfigurationVersionIds.length > 0) {
    console.error(`[terrence] Could not obtain a GitHub token for ${details.repoFullName}`);
    await db.update(configurationVersions)
      .set({ status: "errored", error: "GitHub App access token is unavailable" })
      .where(inArray(configurationVersions.id, missingTokenConfigurationVersionIds));
  }
  if (token !== null && downloadableConfigurationVersionIds.length > 0) {
    await fetchAndSaveTarball(downloadableConfigurationVersionIds, token, details.repoFullName, details.commitSha);
  }
}

export async function fetchAndSaveTarball(configurationVersionIds: readonly string[], token: string, repoFullName: string, commitSha: string): Promise<void> {
  const repositoryParts = repoFullName.split("/");
  const owner = repositoryParts[0] ?? "";
  const repository = repositoryParts[1] ?? "";
  if (repositoryParts.length !== 2 || !OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(repository) || !COMMIT_SHA_PATTERN.test(commitSha)) {
    await markConfigurationVersionsErrored(configurationVersionIds, "Invalid repository or commit SHA");
    return;
  }

  const storageDirectory = resolve(process.env["STORAGE_DIR"] ?? join(process.cwd(), "storage"), "configuration_versions");
  const temporaryPath = join(storageDirectory, `.github-${crypto.randomUUID()}.tar.gz`);
  try {
    await mkdir(storageDirectory, { recursive: true });
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tarball/${encodeURIComponent(commitSha)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || response.body === null) throw new Error("Failed to download tarball");

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
            throw new Error("GitHub tarball exceeds the maximum download size");
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
    const message = error instanceof Error ? error.message : "Failed to download tarball";
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
}
