import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  githubAppInstallations,
  oauthClients,
  oauthTokens,
  registryModules,
  registryModuleVersions,
} from "../db/schema";
import { decryptSecret } from "./secrets";
import { getGitHubAppAccessToken } from "./webhooks";
import { githubAppApiBase, normalizeGithubApiBase } from "./github-api";
import { ingestModuleArchive, MAX_MODULE_ARCHIVE_BYTES } from "./registry-module-archive";
import { inspectRegistryModule, type RegistryModuleMetadata } from "./registry-module-metadata";
import { isModuleVersion, sortModuleVersionsDescending } from "./registry-version";
import {
  currentModuleVersions,
  RegistrySyncLease,
} from "./registry-sync-lease";

const API_TIMEOUT_MS = 15_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODULE_STORAGE_DIR = join(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "modules");

type RegistryModule = Readonly<typeof registryModules.$inferSelect>;
type Credentials = Readonly<{ apiUrl: string; token: string }>;
export type RegistryModuleCandidate = Readonly<{ version: string; ref: string; sha: string; branch: string | null }>;
export const REGISTRY_VERSION_IMPORT_BATCH_SIZE = 100;


async function credentialsFor(mod: RegistryModule): Promise<Credentials> {
  if (mod.vcsConnectionType === "github-app" && mod.vcsConnectionId !== null) {
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.id, mod.vcsConnectionId),
        eq(githubAppInstallations.orgId, mod.orgId),
      ),
    });
    if (installation === undefined) throw new Error("The selected VCS connection is unavailable");
    const token = await getGitHubAppAccessToken(installation.installationId);
    if (token === null) throw new Error("The selected VCS connection could not authenticate");
    const apiUrl = githubAppApiBase(true);
    if (apiUrl === undefined) throw new Error("The VCS connection API URL is invalid");
    return { apiUrl, token };
  }
  if (mod.vcsConnectionType === "oauth-token" && mod.vcsConnectionId !== null) {
    const tokenRow = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, mod.vcsConnectionId) });
    if (tokenRow === undefined) throw new Error("The selected VCS connection is unavailable");
    const client = await db.query.oauthClients.findFirst({
      where: and(eq(oauthClients.id, tokenRow.oauthClientId), eq(oauthClients.orgId, mod.orgId)),
    });
    if (client === undefined || !["github", "github_enterprise"].includes(client.serviceProvider)) {
      throw new Error("This VCS provider is not yet supported for registry module ingestion");
    }
    const apiUrl = normalizeGithubApiBase(
      client.apiUrl?.trim() === "" || client.apiUrl === null || client.apiUrl === undefined
        ? "https://api.github.com"
        : client.apiUrl,
    );
    if (apiUrl === undefined) throw new Error("The VCS connection API URL is invalid");
    return { apiUrl, token: await decryptSecret(tokenRow.token) };
  }
  throw new Error("The registry module has no valid VCS connection");
}

async function githubJson<T>(credentials: Credentials, path: string): Promise<T> {
  const response = await fetch(`${credentials.apiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Terrence",
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The VCS request failed with HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function tagVersion(tag: string, prefix: string): string | undefined {
  if (!tag.startsWith(prefix)) return undefined;
  const candidate = tag.slice(prefix.length).replace(/^v/, "");
  return isModuleVersion(candidate) ? candidate : undefined;
}

export function discoverModuleVersions(
  tags: readonly Readonly<{ name: string; sha: string }>[],
  prefix: string,
): RegistryModuleCandidate[] {
  const candidates = new Map<string, RegistryModuleCandidate>();
  for (const tag of tags) {
    const version = tagVersion(tag.name, prefix);
    if (version === undefined) continue;
    const candidate = { version, ref: tag.name, sha: tag.sha, branch: null } as const;
    const existing = candidates.get(version);
    // A repository should not publish the same version twice. If it does,
    // choose a stable ref/SHA instead of depending on API response order.
    if (
      existing === undefined
      || candidate.ref.localeCompare(existing.ref) < 0
      || (candidate.ref === existing.ref && candidate.sha.localeCompare(existing.sha) < 0)
    ) {
      candidates.set(version, candidate);
    }
  }
  return sortModuleVersionsDescending([...candidates.values()]);
}

/** Select the next deterministic import batch after excluding persisted versions. */
export function selectRegistryModuleVersionBatch(
  candidates: readonly RegistryModuleCandidate[],
  existingVersions: Readonly<ReadonlySet<string>>,
  batchSize = REGISTRY_VERSION_IMPORT_BATCH_SIZE,
): RegistryModuleCandidate[] {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) return [];
  return sortModuleVersionsDescending(candidates)
    .filter((candidate): boolean => !existingVersions.has(candidate.version))
    .slice(0, batchSize);
}

async function branchCandidateFor(
  mod: RegistryModule,
  credentials: Credentials,
  encodedRepository: string,
  branchVersion: string | undefined,
): Promise<RegistryModuleCandidate[]> {
  if (mod.branch === null || mod.branch === "") throw new Error("Branch-based publication requires a branch");
  if (branchVersion === undefined || !isModuleVersion(branchVersion)) {
    throw new Error("Branch-based publication requires a semantic module version");
  }
  const branch = await githubJson<{ commit?: { sha?: unknown } }>(
    credentials,
    `/repos/${encodedRepository}/branches/${encodeURIComponent(mod.branch)}`,
  );
  if (typeof branch.commit?.sha !== "string" || branch.commit.sha === "") throw new Error("The selected branch has no resolvable commit");
  return [{ version: branchVersion, ref: mod.branch, sha: branch.commit.sha, branch: mod.branch }];
}

async function candidatesFor(
  mod: RegistryModule,
  credentials: Credentials,
  branchVersion?: string,
): Promise<RegistryModuleCandidate[]> {
  const repository = mod.repositoryIdentifier ?? "";
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("Repository identifier must use owner/repository format");
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  if (mod.publishingWorkflow === "branch") return branchCandidateFor(mod, credentials, encodedRepository, branchVersion);
  const tags: { name: string; sha: string }[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubJson<readonly Readonly<{ name?: unknown; commit?: { sha?: unknown } }>[]>(
      credentials,
      `/repos/${encodedRepository}/tags?per_page=100&page=${page}`,
    );
    for (const tag of response) {
      if (typeof tag.name === "string" && typeof tag.commit?.sha === "string") tags.push({ name: tag.name, sha: tag.commit.sha });
    }
    if (response.length < 100) break;
  }
  return discoverModuleVersions(tags, mod.tagPrefix);
}

async function withDownloadedArchive<T>(
  mod: RegistryModule,
  credentials: Credentials,
  sha: string,
  use: (path: string) => Promise<T>,
): Promise<T> {
  const repository = mod.repositoryIdentifier ?? "";
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${credentials.apiUrl}/repos/${encodedRepository}/tarball/${encodeURIComponent(sha)}`, {
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Terrence",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) throw new Error(`The module source download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MODULE_ARCHIVE_BYTES) throw new Error("The module source download is too large");

  const staging = await mkdtemp(join(tmpdir(), "terrence-registry-download-"));
  const path = join(staging, "source.tar.gz");
  const file = await open(path, "wx", 0o600);
  const reader = response.body.getReader();
  let total = 0;
  let fileClosed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_MODULE_ARCHIVE_BYTES) throw new Error("The module source download is too large");
      await file.write(value);
    }
    await file.close();
    fileClosed = true;
    return await use(path);
  } finally {
    // Bun may detach releaseLock/close from the reader/handle once the
    // stream or file completes; guard both so a cleanup path can never
    // mask the real result with "undefined is not a function".
    if (typeof reader.releaseLock === "function") {
      try {
        reader.releaseLock();
      } catch {
        // Cleanup best effort: never mask the original outcome.
      }
    }
    if (!fileClosed) {
      // Bun's FileHandle.close() returns undefined once the handle is
      // already closed, so never assume the result is a thenable here.
      const closeResult: unknown = file.close();
      if (closeResult !== undefined && typeof (closeResult as { catch?: unknown }).catch === "function") {
        await (closeResult as Promise<void>).catch((): void => { return; });
      }
    }
    await rm(staging, { recursive: true, force: true });
  }
}

type SyncResult = Readonly<{ imported: number; versions: readonly string[]; pendingRemaining: number }>;
const syncInFlight = new Map<string, Promise<SyncResult>>();

async function synchronizeRegistryModuleOnce(
  mod: RegistryModule,
  branchVersion?: string,
  shouldContinue: () => boolean = (): boolean => true,
): Promise<SyncResult> {
  const attemptedAt = Date.now();
  await db.update(registryModules).set({ lastSyncAttemptAt: attemptedAt, updatedAt: attemptedAt }).where(eq(registryModules.id, mod.id));
  const createdArchives: string[] = [];
  try {
    const credentials = await credentialsFor(mod);
    const candidates = await candidatesFor(mod, credentials, branchVersion);
    if (mod.publishingWorkflow === "tag" && candidates.length === 0) {
      throw new Error("The repository has no matching semantic version tags");
    }
    const existing = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, mod.id) });
    const existingVersions = new Set(existing.map((version): string => version.version));
    const outstanding = selectRegistryModuleVersionBatch(candidates, existingVersions, Number.MAX_SAFE_INTEGER);
    const pending = outstanding.slice(0, REGISTRY_VERSION_IMPORT_BATCH_SIZE);
    const pendingRemaining = outstanding.length - pending.length;
    const prepared: (typeof registryModuleVersions.$inferInsert)[] = [];
    for (const candidate of pending) {
      // Abort as soon as the cross-replica lease is lost: another replica
      // took over this module mid-sync, so keep writing would work on a lock
      // this instance no longer owns.
      if (!shouldContinue()) throw new Error("Registry module sync lease lost; another replica took over ingestion");
      const id = `modver-${crypto.randomUUID()}`;
      const archivePath = join(MODULE_STORAGE_DIR, `${id}.tar.gz`);
      const metadata = await withDownloadedArchive(mod, credentials, candidate.sha, async (downloaded): Promise<RegistryModuleMetadata> =>
        ingestModuleArchive(downloaded, archivePath, mod.sourceDirectory, inspectRegistryModule));
      createdArchives.push(archivePath);
      prepared.push({
        id,
        moduleId: mod.id,
        version: candidate.version,
        status: "ok",
        archivePath,
        source: mod.repositoryUrl,
        commitSha: candidate.sha,
        vcsTag: candidate.branch === null ? candidate.ref : null,
        vcsBranch: candidate.branch,
        sourceDirectory: mod.sourceDirectory,
        metadata,
        publishedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    const completedAt = Date.now();
    await db.transaction(async (tx): Promise<void> => {
      if (prepared.length > 0) await tx.insert(registryModuleVersions).values(prepared);
      const description = prepared.at(-1)?.metadata;
      await tx.update(registryModules).set({
        status: "setup_complete",
        description: typeof description?.description === "string" ? description.description : mod.description,
        lastSuccessfulSyncAt: completedAt,
        lastSyncAttemptAt: attemptedAt,
        lastSyncError: null,
        updatedAt: completedAt,
      }).where(eq(registryModules.id, mod.id));
    });
    return { imported: prepared.length, versions: prepared.map((version): string => version.version), pendingRemaining };
  } catch (error: unknown) {
    await Promise.allSettled(createdArchives.map(async (path): Promise<void> => { await rm(path, { force: true }); }));
    const message = error instanceof Error ? error.message : "Registry module synchronization failed";
    await db.update(registryModules).set({
      status: "errored",
      lastSyncAttemptAt: attemptedAt,
      lastSyncError: message.slice(0, 2_000),
      updatedAt: Date.now(),
    }).where(eq(registryModules.id, mod.id));
    throw new Error(message);
  }
}

function scheduleRemainingRegistryModuleSync(mod: RegistryModule): void {
  setTimeout((): void => {
    void synchronizeRegistryModule(mod).catch((error: unknown): void => {
      console.error(`[terrence] Registry module continuation failed for ${mod.id}:`, error instanceof Error ? error.message : error);
    });
  }, 0);
}

export async function synchronizeRegistryModule(
  mod: RegistryModule,
  branchVersion?: string,
): Promise<SyncResult> {
  const key = `${mod.id}:${branchVersion ?? "tags"}`;
  // In-process coalescing is preserved: concurrent callers in this replica
  // share one in-flight Promise, so the lease is claimed at most once per
  // process per key and the caller gets the real SyncResult.
  const existing = syncInFlight.get(key);
  if (existing !== undefined) return existing;
  let completedResult: SyncResult | undefined;
  const operation = (async (): Promise<SyncResult> => {
    // Cross-replica mutex: only the replica that claims the lease runs the
    // sync. A non-owner returns the module's current versions without
    // double-running the (possibly in-flight) ingestion on another replica.
    const lease = await RegistrySyncLease.acquire(key);
    if (lease === null) return { imported: 0, versions: await currentModuleVersions(mod.id), pendingRemaining: 0 };
    // The lease renews itself on an interval; shouldContinue aborts the
    // download loop as soon as the lease is lost (renewal failed or another
    // replica reclaimed it), so ingestion never finishes writing under a
    // lock this instance no longer owns.
    const result = await (async (): Promise<SyncResult> => {
      try {
        return await synchronizeRegistryModuleOnce(mod, branchVersion, (): boolean => lease.isAlive());
      } finally {
        await lease.release();
      }
    })();
    completedResult = result;
    return result;
  })().finally((): void => {
    // Remove the coalescing entry before starting another bounded batch.
    syncInFlight.delete(key);
    if (completedResult?.pendingRemaining !== undefined && completedResult.pendingRemaining > 0) {
      scheduleRemainingRegistryModuleSync(mod);
    }
  });
  syncInFlight.set(key, operation);
  return operation;
}
