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
import { ingestModuleArchive, MAX_MODULE_ARCHIVE_BYTES } from "./registry-module-archive";
import { inspectRegistryModule, type RegistryModuleMetadata } from "./registry-module-metadata";

const API_TIMEOUT_MS = 15_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MODULE_STORAGE_DIR = join(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "modules");

type RegistryModule = Readonly<typeof registryModules.$inferSelect>;
type Credentials = Readonly<{ apiUrl: string; token: string }>;
type Candidate = Readonly<{ version: string; ref: string; sha: string; branch: string | null }>;

function githubApiUrl(value: string | null | undefined): string {
  const raw = value === undefined || value === null || value === "" ? "https://api.github.com" : value;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The VCS connection API URL is invalid");
  return url.toString().replace(/\/$/, "");
}

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
    return { apiUrl: githubApiUrl(process.env.GITHUB_API_URL), token };
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
    return { apiUrl: githubApiUrl(client.apiUrl), token: await decryptSecret(tokenRow.token) };
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
  return SEMVER_PATTERN.test(candidate) ? candidate : undefined;
}

export function discoverModuleVersions(
  tags: readonly Readonly<{ name: string; sha: string }>[],
  prefix: string,
): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (const tag of tags) {
    const version = tagVersion(tag.name, prefix);
    if (version !== undefined && !candidates.has(version)) {
      candidates.set(version, { version, ref: tag.name, sha: tag.sha, branch: null });
    }
  }
  return [...candidates.values()].slice(0, 100);
}

async function candidatesFor(
  mod: RegistryModule,
  credentials: Credentials,
  branchVersion?: string,
): Promise<Candidate[]> {
  const repository = mod.repositoryIdentifier ?? "";
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("Repository identifier must use owner/repository format");
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  if (mod.publishingWorkflow === "branch") {
    if (mod.branch === null || mod.branch === "") throw new Error("Branch-based publication requires a branch");
    if (branchVersion === undefined || !SEMVER_PATTERN.test(branchVersion)) {
      throw new Error("Branch-based publication requires a semantic module version");
    }
    const branch = await githubJson<{ commit?: { sha?: unknown } }>(
      credentials,
      `/repos/${encodedRepository}/branches/${encodeURIComponent(mod.branch)}`,
    );
    if (typeof branch.commit?.sha !== "string" || branch.commit.sha === "") throw new Error("The selected branch has no resolvable commit");
    return [{ version: branchVersion, ref: mod.branch, sha: branch.commit.sha, branch: mod.branch }];
  }
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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_MODULE_ARCHIVE_BYTES) throw new Error("The module source download is too large");
      await file.write(value);
    }
    await file.close();
    return await use(path);
  } finally {
    reader.releaseLock();
    await file.close().catch((): void => { return; });
    await rm(staging, { recursive: true, force: true });
  }
}

type SyncResult = Readonly<{ imported: number; versions: readonly string[] }>;
const syncInFlight = new Map<string, Promise<SyncResult>>();

async function synchronizeRegistryModuleOnce(
  mod: RegistryModule,
  branchVersion?: string,
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
    const pending = candidates.filter((candidate): boolean => !existingVersions.has(candidate.version));
    const prepared: (typeof registryModuleVersions.$inferInsert)[] = [];
    for (const candidate of pending) {
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
    return { imported: prepared.length, versions: prepared.map((version): string => version.version) };
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

export async function synchronizeRegistryModule(
  mod: RegistryModule,
  branchVersion?: string,
): Promise<SyncResult> {
  const key = `${mod.id}:${branchVersion ?? "tags"}`;
  const existing = syncInFlight.get(key);
  if (existing !== undefined) return existing;
  // ponytail: this coalesces one app process; use a database lease if registry
  // webhook ingestion must run concurrently across multiple replicas.
  const operation = synchronizeRegistryModuleOnce(mod, branchVersion)
    .finally((): void => { syncInFlight.delete(key); });
  syncInFlight.set(key, operation);
  return operation;
}
