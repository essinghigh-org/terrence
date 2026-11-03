import { createHash } from "node:crypto";
import { azureDevOpsFilesToTarGz, type AzureDevOpsArchiveLimits } from "./ado-archive";
import { MAX_ARCHIVE_MEMBERS, MAX_EXPANDED_ARCHIVE_BYTES, tarMemberPathUnsafe } from "./archive";
import { readBytesWithLimit } from "./body-limit";
import {
  azureDevOpsRepositoryApiUrl,
  azureDevOpsRepositoryHttpUrl,
  parseAzureDevOpsRepository,
  fetchAzureDevOpsUrl,
  type AzureDevOpsCredentials,
} from "./azure-devops";

const SHA = /^[0-9a-f]{40}$/u;
const MAX_REQUESTS = 20_000;
const MAX_DEPTH = 8;
type File = Readonly<{ name: string; data: Uint8Array; executable: boolean }>;
type Entry = Readonly<{ path: string; mode: string; sha: string }>;
type Budget = { remainingBytes: number };

function fail(reason: string): never {
  throw new Error(`Azure DevOps submodule ingestion: ${reason}`);
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value) || /^0+$/.test(value)) fail("invalid immutable object ID");
  return value;
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid API response");
  return value as Record<string, unknown>;
}
function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    tarMemberPathUnsafe(value) ||
    /[\\\u0000-\u001f\u007f]/u.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part): boolean => part === "" || part === "." || part.toLowerCase() === ".git")
  )
    fail("unsafe repository path");
  return value;
}

function submoduleRepository(raw: string, parent: string, organization: string): string {
  const base = azureDevOpsRepositoryHttpUrl(parent, organization);
  if (base === undefined) fail("invalid parent repository");
  let url: URL;
  try {
    url = new URL(raw, `${base}/`);
  } catch {
    return fail("invalid submodule URL");
  }
  if (
    (!raw.startsWith("../") && !raw.startsWith("./") && !raw.startsWith("https://")) ||
    url.origin !== "https://dev.azure.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    fail("submodule must use same-organization Azure DevOps HTTPS");
  let identifier: string;
  try {
    identifier = url.pathname.slice(1).split("/").map(decodeURIComponent).join("/");
  } catch {
    return fail("invalid encoded submodule URL");
  }
  if (parseAzureDevOpsRepository(identifier, organization) === undefined)
    fail("submodule must use same-organization Azure DevOps HTTPS");
  return identifier;
}

function configPair(line: string): readonly [string, string] {
  const pair = /^(path|url|branch|update|ignore|shallow|fetchRecurseSubmodules)\s*=\s*(.+)$/u.exec(line);
  if (pair === null || pair[1] === undefined || pair[2] === undefined) fail("unsupported .gitmodules syntax");
  const key = pair[1];
  let value = pair[2];
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value.includes('"') || value.includes("\\")) fail("ambiguous .gitmodules value");
  return [key, value];
}

/** Accept Git's usual simple generated config; unsupported syntax fails rather than being reinterpreted. */
function submoduleUrls(content: string, parent: string, organization: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const sections = new Set<string>();
  let section: string | undefined;
  let values = new Map<string, string>();
  function finish(): void {
    if (section === undefined) return;
    const path = safePath(values.get("path"));
    const raw = values.get("url");
    if (raw === undefined || result.has(path) || raw.includes("\\") || /[\u0000-\u0020\u007f]/u.test(raw))
      fail("invalid submodule URL or duplicate path");
    result.set(path, submoduleRepository(raw, parent, organization));
  }
  for (const source of content.split(/\r?\n/u)) {
    const line = source.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[submodule "([^"\\]+)"\]$/u.exec(line);
    if (header !== null) {
      finish();
      section = header[1];
      if (section === undefined || sections.has(section)) fail("duplicate submodule section");
      sections.add(section);
      values = new Map();
      continue;
    }
    if (section === undefined) fail("unsupported .gitmodules syntax");
    const [key, value] = configPair(line);
    if (values.has(key)) fail("ambiguous .gitmodules value");
    // Branch/update are metadata only: gitlinks always pin the checkout, and no commands are executed.
    values.set(key, value);
  }
  finish();
  return result;
}

function regularEntryMode(mode: unknown, type: unknown): mode is string {
  return (mode === "160000" && type === "commit") || ((mode === "100644" || mode === "100755") && type === "blob");
}

/** Immutable, bounded REST traversal; credentials are never passed to Git or supplied URLs. */
export async function fetchAzureDevOpsSubmoduleArchive(
  credentials: AzureDevOpsCredentials,
  identifier: string,
  commit: string,
  limits: AzureDevOpsArchiveLimits = {},
  signal?: Readonly<AbortSignal>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Shared delivery network budget.
  downloadBudget?: Budget,
): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(10 * 60_000);
  const deadline = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail("invalid resource limit");
  }
  const budget = downloadBudget ?? { remainingBytes: limits.maxCompressedBytes ?? 100 * 1024 * 1024 };
  const files: File[] = [];
  const paths = new Set<string>();
  let requests = 0;
  let members = 0;
  let expanded = 1024;
  const maxMembers = Math.min(limits.maxMembers ?? MAX_ARCHIVE_MEMBERS, MAX_ARCHIVE_MEMBERS);
  const maxExpanded = Math.min(limits.maxExpandedBytes ?? MAX_EXPANDED_ARCHIVE_BYTES, MAX_EXPANDED_ARCHIVE_BYTES);
  async function request(repo: string, suffix: string, max: number, accept: string): Promise<Uint8Array> {
    deadline.throwIfAborted();
    const base = azureDevOpsRepositoryApiUrl(repo, credentials.organization);
    if (base === undefined || ++requests > MAX_REQUESTS) fail("repository or request limit exceeded");
    const size = Math.min(max, budget.remainingBytes);
    if (!Number.isSafeInteger(size) || size < 1) fail("download byte budget exhausted");
    budget.remainingBytes -= size;
    const response = await fetchAzureDevOpsUrl(credentials, `${base}/${suffix}`, {
      accept,
      maxResponseBytes: size,
      signal: deadline,
    });
    if (!response.ok || response.headers.has("x-ms-continuationtoken")) {
      await response.body?.cancel();
      fail("incomplete or unsuccessful object response");
    }
    const bytes = await readBytesWithLimit(response, size);
    budget.remainingBytes += size - bytes.length;
    return bytes;
  }
  async function json(repo: string, suffix: string): Promise<Readonly<Record<string, unknown>>> {
    return record(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await request(repo, suffix, 4 * 1024 * 1024, "application/json"),
        ),
      ),
    );
  }
  async function blob(repo: string, object: string, maximum = maxExpanded): Promise<Uint8Array> {
    const bytes = await request(
      repo,
      `blobs/${object}?api-version=7.1`,
      Math.min(limits.maxFileBytes ?? maxExpanded, maxExpanded, maximum),
      "application/octet-stream",
    );
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== object) fail("blob object hash mismatch");
    return bytes;
  }
  async function tree(repo: string, object: string, prefix: string, depth: number): Promise<readonly Entry[]> {
    if (depth > 64) fail("tree depth exceeded");
    const body = await json(repo, `trees/${object}?recursive=false&api-version=7.1`);
    if (body["objectId"] !== object || !Array.isArray(body["treeEntries"])) fail("invalid or incomplete tree");
    const entries: Entry[] = [];
    const siblings = new Set<string>();
    for (const raw of body["treeEntries"]) {
      const item = record(raw);
      const name = safePath(item["relativePath"]);
      if (name.includes("/") || siblings.has(name) || ++members > maxMembers)
        fail("invalid tree member or member limit exceeded");
      siblings.add(name);
      const path = safePath(`${prefix}${name}`);
      const objectId = sha(item["objectId"]);
      const mode = item["mode"];
      if (mode === "40000" || mode === "040000") {
        if (item["gitObjectType"] !== "tree") fail("tree mode mismatch");
        entries.push(...(await tree(repo, objectId, `${path}/`, depth + 1)));
      } else {
        if (regularEntryMode(mode, item["gitObjectType"])) entries.push({ path, sha: objectId, mode });
        else fail("unsupported Git mode or special file");
      }
    }
    return entries;
  }
  async function manifest(
    repo: string,
    entries: readonly Entry[],
  ): Promise<
    Readonly<{
      config: Entry | undefined;
      configBytes: Uint8Array | undefined;
      urls: ReadonlyMap<string, string>;
    }>
  > {
    const config = entries.find((entry): boolean => entry.path === ".gitmodules");
    if (config !== undefined && config.mode === "160000") fail(".gitmodules must be a file");
    const configBytes = config === undefined ? undefined : await blob(repo, config.sha, 64 * 1024);
    const urls = submoduleUrls(
      configBytes === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(configBytes),
      repo,
      credentials.organization,
    );
    const links = entries.filter((entry): boolean => entry.mode === "160000");
    if (links.length !== urls.size || links.some((entry): boolean => !urls.has(entry.path)))
      fail(".gitmodules and gitlinks do not match");
    return { config, configBytes, urls };
  }
  async function repository(
    repo: string,
    revision: string,
    prefix: string,
    ancestry: readonly string[],
  ): Promise<void> {
    const key = `${repo.toLowerCase()}@${sha(revision)}`;
    if (ancestry.length > MAX_DEPTH || ancestry.includes(key)) fail("submodule depth or cycle limit exceeded");
    const metadata = await json(repo, `commits/${revision}?api-version=7.1`);
    if (metadata["commitId"] !== revision) fail("commit identity mismatch");
    const entries = await tree(repo, sha(metadata["treeId"]), "", 0);
    const { config, configBytes, urls } = await manifest(repo, entries);
    for (const entry of entries) {
      const path = safePath(`${prefix}${entry.path}`);
      if (entry.mode === "160000") {
        const target = urls.get(entry.path);
        if (target === undefined) fail("missing submodule URL");
        await repository(target, entry.sha, `${path}/`, [...ancestry, key]);
      } else {
        if (paths.has(path)) fail("duplicate output path");
        paths.add(path);
        const data = entry === config && configBytes !== undefined ? configBytes : await blob(repo, entry.sha);
        expanded += 512 + Math.ceil(data.length / 512) * 512;
        if (expanded > maxExpanded) fail("expanded byte limit exceeded");
        files.push({ name: path, data, executable: entry.mode === "100755" });
      }
    }
  }
  await repository(identifier, commit, "", []);
  return azureDevOpsFilesToTarGz(files, limits);
}
