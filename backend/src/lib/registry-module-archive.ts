import { stat } from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  MAX_ARCHIVE_MEMBERS,
  MAX_EXPANDED_ARCHIVE_BYTES,
  assertArchiveExpandedSize,
  assertArchiveLogicalSize,
  assertArchiveMemberCount,
} from "./archive";

export const MAX_MODULE_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_MODULE_FILE_BYTES = 16 * 1024 * 1024;
const ARCHIVE_TIMEOUT_MS = 30_000;

function safeRelativePath(value: string): boolean {
  if (value === "" || value.includes("\\") || value.includes("\0")) return false;
  if (value === "." || value === "./") return true;
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized !== ""
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split("/").includes("..");
}

async function tarOutput(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["tar", ...args], {
    env: { ...process.env, LANG: "C" },
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || "Archive is not a valid gzip-compressed tar file");
  return stdout;
}

export async function validateModuleArchive(path: string): Promise<void> {
  const compressed = await stat(path);
  if (!compressed.isFile() || compressed.size === 0) throw new Error("Module archive is empty");
  if (compressed.size > MAX_MODULE_ARCHIVE_BYTES) {
    throw new Error(`Module archive exceeds the ${MAX_MODULE_ARCHIVE_BYTES} byte upload limit`);
  }
  await Promise.all([
    assertArchiveExpandedSize(path),
    assertArchiveLogicalSize(path),
  ]);

  const names = (await tarOutput(["-tzf", path]))
    .split("\n")
    .filter((name): boolean => name !== "");
  assertArchiveMemberCount(names);
  if (names.length === 0) throw new Error("Module archive contains no files");
  if (names.some((name): boolean => !safeRelativePath(name))) {
    throw new Error("Module archive contains an unsafe path");
  }

  const details = (await tarOutput(["--numeric-owner", "-tvzf", path]))
    .split("\n")
    .filter((line): boolean => line !== "");
  if (details.length !== names.length) throw new Error("Module archive contains an unsupported file name");
  for (const line of details) {
    if (!line.startsWith("-") && !line.startsWith("d")) {
      throw new Error("Module archive may contain only regular files and directories");
    }
    // GNU tar lists the owner as 0/0 (--numeric-owner); BusyBox tar lists
    // names (root/root). Accept both.
    const match = /^\S+\s+\S+\/\S+\s+(\d+)\s+\S+\s+\S+\s/.exec(line);
    if (match === null) throw new Error("Module archive listing could not be validated");
    if (Number(match[1]) > MAX_MODULE_FILE_BYTES) {
      throw new Error(`Module archive contains a file larger than ${MAX_MODULE_FILE_BYTES} bytes`);
    }
  }
}

export async function extractValidatedModuleArchive(path: string, destination: string): Promise<void> {
  await validateModuleArchive(path);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await tarOutput([
    "-x",
    "-o",
    "-z",
    "-f",
    path,
    "-C",
    destination,
  ]);
}

async function containsTerraform(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.some((entry): boolean => entry.isFile() && (entry.name.endsWith(".tf") || entry.name.endsWith(".tf.json")));
}

async function repositoryRoot(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const directories = entries.filter((entry): boolean => entry.isDirectory());
  const files = entries.filter((entry): boolean => entry.isFile());
  return directories.length === 1 && files.length === 0 && directories[0] !== undefined
    ? join(directory, directories[0].name)
    : directory;
}

export async function moduleRootPath(directory: string, sourceDirectory = ""): Promise<string> {
  const root = await repositoryRoot(directory);
  const source = sourceDirectory.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (source !== "" && !safeRelativePath(source)) throw new Error("Source directory must be a safe relative path");
  const selected = resolve(root, source);
  if (selected !== root && !selected.startsWith(`${root}${sep}`)) throw new Error("Source directory escapes the repository");
  let selectedStat;
  try {
    selectedStat = await stat(selected);
  } catch {
    throw new Error("Source directory does not exist in the selected revision");
  }
  if (!selectedStat.isDirectory() || !(await containsTerraform(selected))) {
    throw new Error("Selected source directory does not contain a Terraform module");
  }
  return selected;
}

export async function ingestModuleArchive<T>(
  inputPath: string,
  destinationPath: string,
  sourceDirectory: string,
  inspect: (moduleRoot: string) => Promise<T>,
): Promise<T> {
  const staging = await mkdtemp(join(tmpdir(), "terrence-registry-module-"));
  const temporaryArchive = `${destinationPath}.${crypto.randomUUID()}.tmp`;
  try {
    const extracted = join(staging, "source");
    await extractValidatedModuleArchive(inputPath, extracted);
    const moduleRoot = await moduleRootPath(extracted, sourceDirectory);
    const metadata = await inspect(moduleRoot);
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    const child = Bun.spawn(["tar", "-czf", temporaryArchive, "-C", moduleRoot, "."], {
      env: { ...process.env, LANG: "C" },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr.trim() || "Module archive could not be prepared");
    await validateModuleArchive(temporaryArchive);
    await rename(temporaryArchive, destinationPath);
    return metadata;
  } finally {
    await Promise.allSettled([
      rm(staging, { recursive: true, force: true }),
      rm(temporaryArchive, { force: true }),
    ]);
  }
}

export const moduleArchiveLimits = {
  compressedBytes: MAX_MODULE_ARCHIVE_BYTES,
  expandedBytes: MAX_EXPANDED_ARCHIVE_BYTES,
  entries: MAX_ARCHIVE_MEMBERS,
  fileBytes: MAX_MODULE_FILE_BYTES,
} as const;
