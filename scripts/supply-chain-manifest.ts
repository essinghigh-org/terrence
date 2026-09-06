import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

type PackageJson = JsonRecord & {
  name?: unknown;
  version?: unknown;
  packageManager?: unknown;
  engines?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  overrides?: unknown;
};

type BunLock = {
  lockfileVersion?: unknown;
  configVersion?: unknown;
  workspaces?: unknown;
  overrides?: unknown;
  packages?: unknown;
};

export type Dependency = Readonly<{
  name: string;
  range: string;
  section: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
}>;

export type WorkspaceManifest = Readonly<{
  name: string;
  path: string;
  version: string | null;
  dependencies: readonly Dependency[];
}>;

export type LockedPackage = Readonly<{
  locator: string;
  name: string;
  version: string;
  integrity: string;
  dependencies: readonly Readonly<{ name: string; range: string }>[];
}>;

export type DependencyManifest = Readonly<{
  schema: 1;
  packageManager: string;
  lockfile: Readonly<{
    path: "bun.lock";
    sha256: string;
    lockfileVersion: number;
    configVersion: number;
  }>;
  workspaces: readonly WorkspaceManifest[];
  packages: readonly LockedPackage[];
  overrides: Readonly<Record<string, string>>;
}>;

export type DependencyChange = Readonly<{
  name: string;
  from: readonly string[];
  to: readonly string[];
}>;

export type DependencyChangeSummary = Readonly<{
  schema: 1;
  baseRef: string | null;
  currentPackageCount: number;
  currentLockSha256: string;
  changes: readonly DependencyChange[];
}>;

type WorkspaceInput = Readonly<{ path: string; packageJson: Readonly<PackageJson> }>;

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]): number => left.localeCompare(right)),
  );
}

/** Bun lockfiles are JSON with trailing commas. Remove only commas outside
 * strings immediately before a closing object/array delimiter. */
export function parseBunLock(raw: string): BunLock {
  let inString = false;
  let escaped = false;
  let stripped = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === undefined) continue;
    if (inString) {
      stripped += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      stripped += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < raw.length && /\s/.test(raw[next] ?? "")) next += 1;
      if (raw[next] === "}" || raw[next] === "]") continue;
    }
    stripped += character;
  }
  const parsed: unknown = JSON.parse(stripped);
  if (!isRecord(parsed)) throw new Error("bun.lock must contain an object");
  return parsed;
}

function packageCoordinate(coordinate: string): Readonly<{ name: string; version: string }> {
  const resolved = coordinate.includes("@npm:")
    ? coordinate.slice(coordinate.indexOf("@npm:") + "@npm:".length)
    : coordinate;
  const separator = resolved.lastIndexOf("@");
  if (separator <= 0 || separator === resolved.length - 1) {
    throw new Error(`Invalid Bun package coordinate: ${coordinate}`);
  }
  return { name: resolved.slice(0, separator), version: resolved.slice(separator + 1) };
}

function packageDependencies(metadata: Readonly<JsonRecord> | undefined): readonly Readonly<{ name: string; range: string }>[] {
  return Object.entries(stringRecord(metadata?.["dependencies"]))
    .map(([name, range]): Readonly<{ name: string; range: string }> => ({ name, range }))
    .sort((left, right): number => left.name.localeCompare(right.name));
}

function lockedPackages(lock: Readonly<BunLock>): readonly LockedPackage[] {
  if (!isRecord(lock.packages)) throw new Error("bun.lock packages are missing");
  return Object.entries(lock.packages)
    .map(([locator, value]): LockedPackage | null => {
      if (!Array.isArray(value) || typeof value[0] !== "string") throw new Error(`Invalid Bun package entry: ${locator}`);
      const coordinate = packageCoordinate(value[0]);
      const integrity = typeof value[3] === "string" ? value[3] : "";
      if (integrity === "" && !value[0].includes("@workspace:")) {
        throw new Error(`Missing integrity for locked package ${locator}`);
      }
      return value[0].includes("@workspace:")
        ? null
        : {
          locator,
          name: coordinate.name,
          version: coordinate.version,
          integrity,
          dependencies: packageDependencies(isRecord(value[2]) ? value[2] : undefined),
        };
    })
    .filter((entry): entry is LockedPackage => entry !== null)
    .sort((left, right): number => left.locator.localeCompare(right.locator));
}

function workspaceDependencies(packageJson: Readonly<PackageJson>): readonly Dependency[] {
  return DEPENDENCY_SECTIONS.flatMap((section): Dependency[] => Object.entries(stringRecord(packageJson[section]))
    .map(([name, range]): Dependency => ({ name, range, section })))
    .sort((left, right): number => left.section.localeCompare(right.section) === 0
      ? left.name.localeCompare(right.name)
      : left.section.localeCompare(right.section));
}

export function createDependencyManifest(
  rootPackageJson: Readonly<PackageJson>,
  workspaces: readonly WorkspaceInput[],
  lock: Readonly<BunLock>,
  lockSha256: string,
): DependencyManifest {
  const packageManager = stringValue(rootPackageJson.packageManager);
  const lockfileVersion = typeof lock.lockfileVersion === "number" ? lock.lockfileVersion : 0;
  const configVersion = typeof lock.configVersion === "number" ? lock.configVersion : 0;
  if (packageManager === "") throw new Error("package.json must pin packageManager");
  if (lockfileVersion === 0 || configVersion === 0) throw new Error("bun.lock must declare lockfile and config versions");
  return {
    schema: 1,
    packageManager,
    lockfile: { path: "bun.lock", sha256: lockSha256, lockfileVersion, configVersion },
    workspaces: workspaces.map(({ path, packageJson }): WorkspaceManifest => ({
      name: stringValue(packageJson.name, path === "." ? "root" : path),
      path,
      version: typeof packageJson.version === "string" ? packageJson.version : null,
      dependencies: workspaceDependencies(packageJson),
    })),
    packages: lockedPackages(lock),
    overrides: stringRecord(rootPackageJson.overrides),
  };
}

function packageSet(manifest: DependencyManifest): Map<string, Set<string>> {
  const packages = new Map<string, Set<string>>();
  for (const entry of manifest.packages) {
    const versions = packages.get(entry.name) ?? new Set<string>();
    versions.add(entry.version);
    packages.set(entry.name, versions);
  }
  return packages;
}

export function summarizeDependencyChanges(
  current: DependencyManifest,
  baseline: DependencyManifest | null,
  baseRef: string | null,
): DependencyChangeSummary {
  const currentPackages = packageSet(current);
  const baselinePackages = baseline === null ? new Map<string, Set<string>>() : packageSet(baseline);
  const names = new Set([...currentPackages.keys(), ...baselinePackages.keys()]);
  const changes = [...names]
    .sort((left, right): number => left.localeCompare(right))
    .map((name): DependencyChange | null => {
      const from = [...(baselinePackages.get(name) ?? new Set<string>())].sort();
      const to = [...(currentPackages.get(name) ?? new Set<string>())].sort();
      if (from.join("\0") === to.join("\0")) return null;
      return { name, from, to };
    })
    .filter((change): change is DependencyChange => change !== null);
  return {
    schema: 1,
    baseRef,
    currentPackageCount: current.packages.length,
    currentLockSha256: current.lockfile.sha256,
    changes,
  };
}

function integrityToHex(integrity: string): string | null {
  if (!integrity.startsWith("sha512-")) return null;
  try {
    const bytes = Buffer.from(integrity.slice("sha512-".length), "base64");
    return bytes.length === 64 ? bytes.toString("hex") : null;
  } catch {
    return null;
  }
}

function spdxPackageId(entry: LockedPackage): string {
  return `SPDXRef-Package-${createHash("sha256").update(entry.locator).digest("hex")}`;
}

function npmPurl(name: string, version: string): string {
  return `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`;
}

function spdxId(entry: Readonly<JsonRecord>): string {
  const id = entry["SPDXID"];
  if (typeof id !== "string") throw new Error("Generated SPDX package is missing SPDXID");
  return id;
}

export function createSpdxSbom(manifest: DependencyManifest): JsonRecord {
  const packages = manifest.packages.map((entry): JsonRecord => {
    // Lockfile-sourced names flow into the purl, the tarball URL and the
    // SPDX record: allowlist the npm package-name grammar up front so no
    // downstream interpolation can carry path traversal or URL metacharacters.
    if (!/^(?:@[a-z0-9~][a-z0-9~._-]*\/)?[a-z0-9~][a-z0-9~._-]*$/.test(entry.name)) {
      throw new Error(`Refusing to emit SBOM entry for invalid npm package name: ${entry.name}`);
    }
    const checksum = integrityToHex(entry.integrity);
    return {
      SPDXID: spdxPackageId(entry),
      name: entry.name,
      versionInfo: entry.version,
      downloadLocation: `https://registry.npmjs.org/${entry.name}/-/${entry.name.slice(entry.name.lastIndexOf("/") + 1)}-${entry.version}.tgz`,
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      ...(checksum === null ? {} : { checksums: [{ algorithm: "SHA512", checksum }] }),
      externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: npmPurl(entry.name, entry.version) }],
      comment: `Bun lock locator: ${entry.locator}`,
    };
  });
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "terrence-dependencies",
    documentNamespace: `https://github.com/essinghigh-org/terrence/sbom/${manifest.lockfile.sha256}`,
    creationInfo: {
      created: "1970-01-01T00:00:00Z",
      creators: ["Tool: terrence dependency manifest"],
    },
    packages,
    relationships: packages.map((entry): JsonRecord => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: spdxId(entry),
    })),
  };
}

function markdownSummary(summary: DependencyChangeSummary): string {
  const lines = [
    "# Dependency change summary",
    "",
    `- Baseline: ${summary.baseRef === null ? "not supplied" : `\`${summary.baseRef}\``}`,
    `- Current locked packages: ${summary.currentPackageCount}`,
    `- Current lock SHA-256: \`${summary.currentLockSha256}\``,
    "",
  ];
  if (summary.baseRef === null) {
    lines.push("No baseline was supplied; this release records the complete locked dependency manifest.", "");
  } else if (summary.changes.length === 0) {
    lines.push("No locked package version changes.", "");
  } else {
    lines.push("| Package | Previous versions | Current versions |", "| --- | --- | --- |", ...summary.changes.map((change): string =>
      `| \`${change.name}\` | ${change.from.length === 0 ? "(new)" : change.from.join(", ")} | ${change.to.length === 0 ? "(removed)" : change.to.join(", ")} |`), "");
  }
  return `${lines.join("\n")}\n`;
}

async function gitFile(ref: string, path: string): Promise<string> {
  const process = Bun.spawn(["git", "show", `${ref}:${path}`], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Could not read ${path} at ${ref}: ${stderr.trim()}`);
  return stdout;
}

async function readPackageJson(path: string): Promise<PackageJson> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

async function buildFromFiles(root: string): Promise<DependencyManifest> {
  const rootPackageJson = await readPackageJson(resolve(root, "package.json"));
  const workspacePaths = [".", "backend", "frontend"];
  const workspaces = await Promise.all(workspacePaths.map(async (path): Promise<WorkspaceInput> => ({
    path,
    packageJson: await readPackageJson(resolve(root, path, "package.json")),
  })));
  const lockPath = resolve(root, "bun.lock");
  const lockText = await readFile(lockPath, "utf8");
  return createDependencyManifest(rootPackageJson, workspaces, parseBunLock(lockText), createHash("sha256").update(lockText).digest("hex"));
}

async function buildBaseline(ref: string): Promise<DependencyManifest> {
  const rootPackageJson = JSON.parse(await gitFile(ref, "package.json")) as PackageJson;
  const workspacePaths = [".", "backend", "frontend"];
  const workspaces = await Promise.all(workspacePaths.map(async (path): Promise<WorkspaceInput> => ({
    path,
    packageJson: JSON.parse(await gitFile(ref, path === "." ? "package.json" : `${path}/package.json`)) as PackageJson,
  })));
  const lockText = await gitFile(ref, "bun.lock");
  return createDependencyManifest(rootPackageJson, workspaces, parseBunLock(lockText), createHash("sha256").update(lockText).digest("hex"));
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const output = argument("output");
  const sbomOutput = argument("sbom-output");
  const summaryOutput = argument("summary-output");
  const baseRef = argument("base-ref") ?? null;
  if (output === undefined || sbomOutput === undefined || summaryOutput === undefined) {
    throw new Error("Usage: supply-chain-manifest.ts --output FILE --sbom-output FILE --summary-output FILE [--base-ref REF]");
  }
  const root = resolve(import.meta.dir, "..");
  const manifest = await buildFromFiles(root);
  const baseline = baseRef === null ? null : await buildBaseline(baseRef);
  const summary = summarizeDependencyChanges(manifest, baseline, baseRef);
  await Promise.all([
    Bun.write(output, `${JSON.stringify(manifest, null, 2)}\n`),
    Bun.write(sbomOutput, `${JSON.stringify(createSpdxSbom(manifest), null, 2)}\n`),
    Bun.write(summaryOutput, markdownSummary(summary)),
  ]);
}
