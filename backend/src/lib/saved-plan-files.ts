import { constants } from "node:fs";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function executionComponents(root: string, executionDirectory: string): readonly string[] {
  const path = relative(resolve(root), resolve(executionDirectory));
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("Saved-plan execution directory is outside the run work directory");
  }
  return path === "" ? [] : path.split(sep);
}

function descriptorPath(fd: number, name: string): string {
  return `/proc/self/fd/${String(fd)}/${name}`;
}

async function openDirectory(path: string, create: boolean): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (!create || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
    return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }
}

/** Pin each directory before traversing the next component. Unlike a
 * realpath/lstat check followed by a pathname operation, these handles keep
 * subsequent opens confined when an execution directory is renamed. */
async function withExecutionDirectory<T>(
  root: string,
  executionDirectory: string,
  create: boolean,
  operation: (fd: number) => Promise<T>,
): Promise<T> {
  const components = executionComponents(root, executionDirectory);
  if (process.platform !== "linux") throw new Error("Saved-plan file confinement requires Linux /proc/self/fd");
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const handles: FileHandle[] = [];
  try {
    let directory = await openDirectory(root, false);
    handles.push(directory);
    for (const component of components) {
      directory = await openDirectory(descriptorPath(directory.fd, component), create);
      handles.push(directory);
    }
    return await operation(directory.fd);
  } finally {
    await Promise.all(handles.map(async (handle): Promise<void> => handle.close()));
  }
}

/** Read the plan through a no-follow descriptor, never through an IaC-owned
 * symlink. A multiply linked inode is not a private run artifact. */
export async function readConfinedSavedPlan(root: string, executionDirectory: string): Promise<Buffer> {
  return withExecutionDirectory(root, executionDirectory, false, async (fd): Promise<Buffer> => {
    const file = await open(
      descriptorPath(fd, "tfplan"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Saved plan must be a private regular file");
      return await file.readFile();
    } finally {
      await file.close();
    }
  });
}

/** Publish a restored plan by replacing its directory entry. No write ever
 * opens an existing IaC-owned destination, including a substituted link. */
export async function writeConfinedSavedPlan(
  root: string,
  executionDirectory: string,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Node filesystem APIs require typed arrays; the bytes are never modified.
  bytes: Readonly<Uint8Array>,
): Promise<void> {
  await withExecutionDirectory(root, executionDirectory, true, async (fd): Promise<void> => {
    const temporary = descriptorPath(fd, `.tfplan-${crypto.randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
      await rename(temporary, descriptorPath(fd, "tfplan"));
    } finally {
      await rm(temporary, { force: true });
    }
  });
}
