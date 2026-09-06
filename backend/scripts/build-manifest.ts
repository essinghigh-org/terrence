import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export type BuildManifest = Readonly<{
  schema: 1;
  version: string;
  commit: string;
  image: Readonly<{ reference: string; digest: string }>;
  migrations: Readonly<{ sqliteSha256: string; postgresSha256: string }>;
  compatibility: Readonly<{
    matrixSha256: string;
    evidence: readonly Readonly<{ file: string; sha256: string }>[];
  }>;
}>;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  }));
  return files.flat().sort();
}

async function digestDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await filesUnder(directory)) {
    hash.update(relative(directory, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function digestFile(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function buildManifest(input: Readonly<{
  version: string;
  commit: string;
  imageReference: string;
  imageDigest: string;
  sqliteMigrations: string;
  postgresMigrations: string;
  compatibilityMatrix: string;
  evidenceDirectory?: string;
}>): Promise<BuildManifest> {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.version)) throw new Error("Invalid release version");
  if (!/^[0-9a-f]{40,64}$/.test(input.commit)) throw new Error("Invalid source commit");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) throw new Error("Invalid image digest");
  const evidenceDirectory = input.evidenceDirectory;
  const evidence = evidenceDirectory === undefined
    ? []
    : await Promise.all((await filesUnder(evidenceDirectory)).map(async (file) => ({
      file: relative(evidenceDirectory, file),
      sha256: await digestFile(file),
    })));
  return {
    schema: 1,
    version: input.version,
    commit: input.commit,
    image: { reference: input.imageReference, digest: input.imageDigest },
    migrations: {
      sqliteSha256: await digestDirectory(input.sqliteMigrations),
      postgresSha256: await digestDirectory(input.postgresMigrations),
    },
    compatibility: {
      matrixSha256: await digestFile(input.compatibilityMatrix),
      evidence: evidence.sort((left, right) => left.file.localeCompare(right.file)),
    },
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const output = argument("output");
  const version = argument("version");
  const commit = argument("commit");
  const imageReference = argument("image");
  const imageDigest = argument("digest");
  const evidencePath = argument("evidence-dir");
  if (output === undefined || version === undefined || commit === undefined || imageReference === undefined || imageDigest === undefined) {
    throw new Error("Usage: build-manifest.ts --output FILE --version VERSION --commit SHA --image REF --digest sha256:DIGEST [--evidence-dir DIR]");
  }
  const root = resolve(import.meta.dir, "../..");
  const manifest = await buildManifest({
    version, commit, imageReference, imageDigest,
    sqliteMigrations: join(root, "backend/drizzle"),
    postgresMigrations: join(root, "backend/drizzle/pg"),
    compatibilityMatrix: join(root, "backend/tests/e2e/cli_matrix.json"),
    ...(evidencePath === undefined ? {} : { evidenceDirectory: resolve(evidencePath) }),
  });
  await Bun.write(output, `${JSON.stringify(manifest, null, 2)}\n`);
}
