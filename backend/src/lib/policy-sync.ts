import { mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { policies, policySetVersions } from "../db/schema";
import type { policySets } from "../db/schema";
import type { DeepReadonly } from "./utils";
import { assertArchiveExpandedSize, assertArchiveLogicalSize, assertArchiveMemberCount } from "./archive";


export type PolicyVcsProvider = "github" | "gitlab" | "bitbucket";
export type PolicyWebhookDetails = {
  readonly branch?: string;
  readonly tag?: string;
  readonly commitSha: string;
  readonly filesChanged: ReadonlySet<string>;
  readonly repoFullName: string;
};
type VcsPolicySet = DeepReadonly<typeof policySets.$inferSelect>;

type ParsedPolicy = Readonly<{
  description: string | null;
  enforcementLevel: string;
  name: string;
  query: string;
  source: string;
  sourcePath: string | null;
}>;

const MAX_POLICY_BYTES = 20 * 1024 * 1024;
const POLICY_ARCHIVE_DIR = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "policy-set-versions");

function within(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

function normalizedRepositoryPath(value: string | null): string {
  return (value ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

export function matchesPolicySetWebhook(
  policySet: DeepReadonly<typeof policySets.$inferSelect>,
  // ReadonlySet is intentionally preserved by DeepReadonly.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<PolicyWebhookDetails>,
): boolean {
  if (details.tag !== undefined || details.branch === undefined) return false;
  const vcsRepo = policySet.vcsRepo;
  if (vcsRepo?.identifier !== details.repoFullName) return false;
  if (typeof vcsRepo.branch === "string" && vcsRepo.branch !== "" && vcsRepo.branch !== details.branch) return false;
  if (details.filesChanged.size === 0) return true;

  const patterns = Array.isArray(policySet.policyUpdatePatterns) ? policySet.policyUpdatePatterns : [];
  if (patterns.length > 0) {
    return patterns.some((pattern: string): boolean => {
      try {
        const glob = new Bun.Glob(pattern);
        return [...details.filesChanged].some((file: string): boolean => glob.match(file.replace(/^\/+/, "")));
      } catch {
        return false;
      }
    });
  }

  const policiesPath = normalizedRepositoryPath(policySet.policiesPath);
  return policiesPath === "" || [...details.filesChanged].some((file: string): boolean => {
    const normalized = file.replaceAll("\\", "/").replace(/^\/+/, "");
    return normalized === policiesPath || normalized.startsWith(`${policiesPath}/`);
  });
}

// Streams are consumed but the subprocess handle itself is not mutated.
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
async function processOutput(process: Readonly<{
  exited: Promise<number>;
  stderr: Readonly<ReadableStream<Uint8Array>>;
  stdout: Readonly<ReadableStream<Uint8Array>>;
}>): Promise<Readonly<{ code: number; stderr: string; stdout: string }>> {
  const [code, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  return { code, stderr, stdout };
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  await assertArchiveExpandedSize(archivePath);
  const verbose = await processOutput(Bun.spawn(
    ["tar", "-tvzf", archivePath],
    { stdout: "pipe", stderr: "pipe" },
  ));
  const verboseError = verbose.stderr.trim();
  if (verbose.code !== 0) throw new Error(`Policy archive is invalid: ${verboseError === "" ? "tar listing failed" : verboseError}`);
  const verboseLines = verbose.stdout.split("\n").map((entry): string => entry.trim()).filter(Boolean);
  assertArchiveMemberCount(verboseLines);
  for (const line of verboseLines) {
    if (["l", "h", "c", "b", "p", "s"].includes(line.charAt(0)) || line.includes(" -> ") || line.includes(" link to ")) {
      throw new Error("Policy archive contains a link or special file");
    }
  }

  const listing = await processOutput(Bun.spawn(
    ["tar", "-tzf", archivePath],
    { stdout: "pipe", stderr: "pipe" },
  ));
  const listingError = listing.stderr.trim();
  if (listing.code !== 0) throw new Error(`Policy archive is invalid: ${listingError === "" ? "tar listing failed" : listingError}`);
  const members = listing.stdout.split("\n").map((entry): string => entry.trim()).filter(Boolean);
  assertArchiveMemberCount(members);
  for (const member of members) {
    const normalized = member.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
      throw new Error("Policy archive contains an unsafe path");
    }
  }
  await assertArchiveLogicalSize(archivePath);

  const extraction = await processOutput(Bun.spawn(
    ["tar", "-x", "-o", "-z", "-f", archivePath, "-C", destination],
    { stdout: "pipe", stderr: "pipe" },
  ));
  const extractionError = extraction.stderr.trim();
  if (extraction.code !== 0) throw new Error(`Policy archive extraction failed: ${extractionError === "" ? "tar failed" : extractionError}`);
}

async function repositoryRoot(extracted: string): Promise<string> {
  const entries = await readdir(extracted, { withFileTypes: true });
  return entries.length === 1 && entries[0]?.isDirectory() === true
    ? join(extracted, entries[0].name)
    : extracted;
}

async function readPolicyFile(path: string): Promise<string> {
  // Open once and stat the SAME handle: a separate stat(path)+readFile(path)
  // pair lets the file be swapped between the regular-file/size check and
  // the read (CodeQL js/file-system-race).
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Policy source must be a regular file");
    if (info.size > MAX_POLICY_BYTES) throw new Error("Policy source exceeds the maximum size");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function consumeQuotedChar(input: string, index: number, output: string): { nextIndex: number; output: string; quoted: boolean } {
  const char = input[index] ?? "";
  if (char === "\\") return { nextIndex: index + 1, output: output + char + (input[index + 1] ?? ""), quoted: true };
  if (char === "\"") return { nextIndex: index, output: output + char, quoted: false };
  return { nextIndex: index, output: output + char, quoted: true };
}

function consumeUnquotedQuote(output: string, char: string): string {
  return output + char;
}

function consumeLineComment(input: string, index: number, output: string, char: string): { nextIndex: number; output: string } {
  let nextOutput = output;
  let nextIndex = index;
  if (char === "/") {
    nextOutput += "  ";
    nextIndex += 1;
  } else {
    nextOutput += " ";
  }
  while (nextIndex + 1 < input.length && input[nextIndex + 1] !== "\n") {
    nextIndex += 1;
    nextOutput += " ";
  }
  return { nextIndex, output: nextOutput };
}

function consumeBlockComment(input: string, index: number, output: string): { nextIndex: number; output: string } {
  let nextOutput = output + "  ";
  let nextIndex = index + 1;
  while (nextIndex + 1 < input.length && !(input[nextIndex] === "*" && input[nextIndex + 1] === "/")) {
    nextIndex += 1;
    nextOutput += input[nextIndex] === "\n" ? "\n" : " ";
  }
  if (nextIndex + 1 < input.length) {
    nextOutput += " ";
    nextIndex += 1;
  }
  return { nextIndex, output: nextOutput };
}

function withoutHclComments(input: string): string {
  let output = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const next = input[index + 1] ?? "";
    if (quoted) {
      const res = consumeQuotedChar(input, index, output);
      output = res.output;
      quoted = res.quoted;
      index = res.nextIndex;
      continue;
    }
    if (char === "\"") {
      quoted = true;
      output = consumeUnquotedQuote(output, char);
      continue;
    }
    if (char === "#" || (char === "/" && next === "/")) {
      const res = consumeLineComment(input, index, output, char);
      output = res.output;
      index = res.nextIndex;
      continue;
    }
    if (char === "/" && next === "*") {
      const res = consumeBlockComment(input, index, output);
      output = res.output;
      index = res.nextIndex;
      continue;
    }
    output += char;
  }
  return output;
}

function closingBrace(input: string, opening: number): number {
  let depth = 1;
  let quoted = false;
  for (let index = opening + 1; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function hclPolicyBlocks(input: string): readonly Readonly<{ attributes: Readonly<Record<string, string>>; name: string }>[] {
  const clean = withoutHclComments(input);
  const header = /\bpolicy\s+("(?:\\.|[^"\\])*")\s*\{/g;
  const blocks: { attributes: Record<string, string>; name: string }[] = [];
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = header.exec(clean)) !== null) {
    const encodedName = match[1];
    if (encodedName === undefined) continue;
    const name = JSON.parse(encodedName) as string;
    const opening = header.lastIndex - 1;
    const closing = closingBrace(clean, opening);
    if (closing < 0) throw new Error(`Policy "${name}" has an unterminated block`);
    const body = clean.slice(opening + 1, closing);
    const attributes: Record<string, string> = {};
    const assignment = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("(?:\\.|[^"\\])*")/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = assignment.exec(body)) !== null) {
      const key = attribute[1];
      const value = attribute[2];
      if (key !== undefined && value !== undefined) attributes[key] = JSON.parse(value) as string;
    }
    if (name === "" || names.has(name)) throw new Error(`Policy name "${name}" is empty or duplicated`);
    names.add(name);
    blocks.push({ attributes, name });
    header.lastIndex = closing + 1;
  }
  if (blocks.length === 0) throw new Error("Policy manifest must contain at least one policy block");
  return blocks;
}

async function regoFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".rego")) files.push(path);
    }
  };
  await walk(directory);
  return files.sort();
}

async function parseManifest(policySet: VcsPolicySet, root: string): Promise<Readonly<{ manifest: string; policies: readonly ParsedPolicy[] }>> {
  const configuredPath = normalizedRepositoryPath(policySet.policiesPath);
  const policyDirectory = resolve(root, configuredPath);
  if (!within(root, policyDirectory)) throw new Error("policies-path escapes the repository");
  const directoryInfo = await stat(policyDirectory);
  if (!directoryInfo.isDirectory()) throw new Error("policies-path does not identify a directory");

  if (policySet.kind === "sentinel") {
    const manifestPath = join(policyDirectory, "sentinel.hcl");
    const blocks = hclPolicyBlocks(await readPolicyFile(manifestPath));
    const parsed = await Promise.all(blocks.map(async ({ attributes, name }): Promise<ParsedPolicy> => {
      const sourcePath = attributes.source;
      const enforcementLevel = attributes.enforcement_level;
      if (sourcePath === undefined || sourcePath === "") throw new Error(`Sentinel policy "${name}" is missing source`);
      if (!["hard-mandatory", "soft-mandatory", "advisory"].includes(enforcementLevel ?? "")) {
        throw new Error(`Sentinel policy "${name}" has an invalid enforcement level`);
      }
      if (/^https?:\/\//i.test(sourcePath)) throw new Error("Remote Sentinel policy sources are not supported");
      const sourceFile = resolve(policyDirectory, sourcePath);
      if (!within(root, sourceFile) || !sourceFile.endsWith(".sentinel")) {
        throw new Error(`Sentinel policy "${name}" has an unsafe source path`);
      }
      const source = await readPolicyFile(sourceFile);
      return {
        description: attributes.description ?? null,
        enforcementLevel: enforcementLevel ?? "advisory",
        name,
        query: source,
        source,
        sourcePath: relative(root, sourceFile).split(sep).join("/"),
      };
    }));
    return { manifest: relative(root, manifestPath).split(sep).join("/"), policies: parsed };
  }

  if (policySet.kind !== "opa") throw new Error(`Unsupported policy set kind "${policySet.kind}"`);
  const manifestPath = join(policyDirectory, "policies.hcl");
  const blocks = hclPolicyBlocks(await readPolicyFile(manifestPath));
  const files = await regoFiles(policyDirectory);
  if (files.length === 0) throw new Error("OPA policy set must contain at least one .rego file");
  let sourceBytes = 0;
  const sources: string[] = [];
  for (const file of files) {
    const source = await readPolicyFile(file);
    sourceBytes += Buffer.byteLength(source);
    if (sourceBytes > MAX_POLICY_BYTES) throw new Error("OPA policy sources exceed the maximum size");
    sources.push(`# ${relative(root, file).split(sep).join("/")}\n${source}`);
  }
  const source = sources.join("\n\n");
  const parsed = blocks.map(({ attributes, name }): ParsedPolicy => {
    const query = attributes.query;
    const rawEnforcement = attributes.enforcement_level ?? "advisory";
    if (query === undefined || query === "") throw new Error(`OPA policy "${name}" is missing query`);
    if (!["mandatory", "advisory", "hard-mandatory", "soft-mandatory"].includes(rawEnforcement)) {
      throw new Error(`OPA policy "${name}" has an invalid enforcement level`);
    }
    return {
      description: attributes.description ?? null,
      enforcementLevel: rawEnforcement === "mandatory" ? "hard-mandatory" : rawEnforcement,
      name,
      query,
      source,
      sourcePath: null,
    };
  });
  return { manifest: relative(root, manifestPath).split(sep).join("/"), policies: parsed };
}

export async function synchronizeVcsPolicySet(
  policySet: DeepReadonly<typeof policySets.$inferSelect>,
  provider: PolicyVcsProvider,
  // ReadonlySet is intentionally preserved by DeepReadonly.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  details: DeepReadonly<PolicyWebhookDetails>,
  fetchArchive: () => Promise<Uint8Array>,
): Promise<void> {
  const now = Date.now();
  const versionId = `polsetver-${crypto.randomUUID()}`;
  const baseIngress = {
    provider,
    repository: details.repoFullName,
    commitSha: details.commitSha,
    ...(details.branch === undefined ? {} : { branch: details.branch }),
    ...(details.tag === undefined ? {} : { tag: details.tag }),
  };
  await db.insert(policySetVersions).values({
    id: versionId,
    policySetId: policySet.id,
    source: provider,
    status: "pending",
    statusTimestamps: {},
    ingressAttributes: baseIngress,
    createdAt: now,
    updatedAt: now,
  });

  const stagingDirectory = await mkdtemp(join(tmpdir(), "terrence-policy-sync-"));
  const extractionDirectory = join(stagingDirectory, "repository");
  const archivePath = join(POLICY_ARCHIVE_DIR, `${versionId}.tar.gz`);
  let uploadedAt: string | undefined;
  try {
    const archive = await fetchArchive();
    if (archive.byteLength < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
      throw new Error("VCS provider returned a non-gzip policy archive");
    }
    await Promise.all([
      mkdir(POLICY_ARCHIVE_DIR, { recursive: true, mode: 0o700 }),
      mkdir(extractionDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const temporaryPath = `${archivePath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, archive, { mode: 0o600 });
      await rename(temporaryPath, archivePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    uploadedAt = new Date().toISOString();
    await db.update(policySetVersions).set({
      archivePath,
      statusTimestamps: { uploadedAt },
      updatedAt: Date.now(),
    }).where(eq(policySetVersions.id, versionId));

    await extractArchive(archivePath, extractionDirectory);
    const root = await repositoryRoot(extractionDirectory);
    const parsed = await parseManifest(policySet, root);
    const readyAt = new Date().toISOString();
    await db.transaction(async (tx): Promise<void> => {
      await tx.delete(policies).where(eq(policies.policySetId, policySet.id));
      await tx.insert(policies).values(parsed.policies.map((policy): typeof policies.$inferInsert => ({
        id: `pol-${crypto.randomUUID()}`,
        policySetId: policySet.id,
        policySetVersionId: versionId,
        name: policy.name,
        description: policy.description,
        kind: policySet.kind,
        enforcementLevel: policy.enforcementLevel,
        query: policy.query,
        source: policy.source,
        sourcePath: policy.sourcePath,
        createdAt: Date.now(),
      })));
      await tx.update(policySetVersions).set({
        status: "ready",
        statusTimestamps: { ...(uploadedAt === undefined ? {} : { uploadedAt }), readyAt },
        ingressAttributes: { ...baseIngress, manifest: parsed.manifest, policyCount: parsed.policies.length },
        error: null,
        updatedAt: Date.now(),
      }).where(eq(policySetVersions.id, versionId));
    });
  } catch (error) {
    const erroredAt = new Date().toISOString();
    const message = (error instanceof Error ? error.message : "Policy synchronization failed").slice(0, 2_000);
    await rm(archivePath, { force: true });
    await db.update(policySetVersions).set({
      status: "errored",
      statusTimestamps: { ...(uploadedAt === undefined ? {} : { uploadedAt }), erroredAt },
      error: message,
      archivePath: null,
      updatedAt: Date.now(),
    }).where(eq(policySetVersions.id, versionId));
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
