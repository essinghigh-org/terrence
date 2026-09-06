import { stat } from "node:fs/promises";
import { runBoundedProcess } from "./bounded-process";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  MAX_ARCHIVE_MEMBERS,
  MAX_EXPANDED_ARCHIVE_BYTES,
  assertSafeTarArchive,
  extractSafeTarArchive,
} from "./archive";

export const MAX_MODULE_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_MODULE_FILE_BYTES = 16 * 1024 * 1024;

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
  const { stdout } = await runBoundedProcess(["tar", ...args]);
  return stdout;
}

export async function validateModuleArchive(path: string): Promise<void> {
  await assertSafeTarArchive(path, {
    maxCompressedBytes: MAX_MODULE_ARCHIVE_BYTES,
    maxFileBytes: MAX_MODULE_FILE_BYTES,
  });
}

export async function extractValidatedModuleArchive(path: string, destination: string, signal?: Readonly<AbortSignal>): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await extractSafeTarArchive(path, destination, {
    maxCompressedBytes: MAX_MODULE_ARCHIVE_BYTES,
    maxFileBytes: MAX_MODULE_FILE_BYTES,
    ...(signal === undefined ? {} : { signal }),
  });
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
    await tarOutput(["-czf", temporaryArchive, "-C", moduleRoot, "."]);
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

/** @public Intentional surface: benchmark/test hook or cross-module API. */
export const moduleArchiveLimits = {
  compressedBytes: MAX_MODULE_ARCHIVE_BYTES,
  expandedBytes: MAX_EXPANDED_ARCHIVE_BYTES,
  entries: MAX_ARCHIVE_MEMBERS,
  fileBytes: MAX_MODULE_FILE_BYTES,
} as const;
