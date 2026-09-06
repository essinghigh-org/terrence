import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const ROOT = resolve(import.meta.dir, "..");
const EXCEPTION_KINDS = new Set(["dependency-override", "audit", "license", "release-age"]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function readJson(path: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function stripTrailingCommas(raw: string): string {
  let inString = false;
  let escaped = false;
  let output = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === undefined) continue;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < raw.length && /\s/.test(raw[next] ?? "")) next += 1;
      if (raw[next] === "}" || raw[next] === "]") continue;
    }
    output += character;
  }
  return output;
}

function requireCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Supply-chain check failed: ${message}`);
}

function checkPackageManager(packageJson: Readonly<JsonRecord>): void {
  const packageManager = typeof packageJson["packageManager"] === "string" ? packageJson["packageManager"] : "";
  const bunEngine = isRecord(packageJson["engines"]) && typeof packageJson["engines"]["bun"] === "string"
    ? packageJson["engines"]["bun"]
    : "";
  requireCondition(/^bun@[0-9]+\.[0-9]+\.[0-9]+$/.test(packageManager), "packageManager must pin Bun to an exact version");
  requireCondition(packageManager.slice(4) === bunEngine, "engines.bun must match packageManager");
}

function checkLockIntegrity(lockText: string, expectedOverrides: Readonly<Record<string, string>>): void {
  const parsed: unknown = JSON.parse(stripTrailingCommas(lockText));
  if (!isRecord(parsed)) throw new Error("Supply-chain check failed: bun.lock must contain an object");
  requireCondition(parsed["lockfileVersion"] === 2 && parsed["configVersion"] === 1, "bun.lock format is not the reviewed Bun 1.4 format");
  const lockedPackages = parsed["packages"];
  if (!isRecord(lockedPackages)) throw new Error("Supply-chain check failed: bun.lock packages are missing");
  requireCondition(JSON.stringify(stringRecord(parsed["overrides"])) === JSON.stringify(expectedOverrides), "bun.lock overrides differ from package.json");
  for (const [locator, value] of Object.entries(lockedPackages)) {
    if (!Array.isArray(value) || typeof value[0] !== "string") throw new Error(`Supply-chain check failed: invalid lock entry ${locator}`);
    if (value[0].includes("@workspace:")) continue;
    requireCondition(typeof value[3] === "string" && /^sha512-[A-Za-z0-9+/]+=*$/.test(value[3]), `lock entry ${locator} has no SHA-512 integrity record`);
  }
}

function checkExceptionEntry(
  entry: Readonly<JsonRecord>,
  overrides: Readonly<Record<string, string>>,
  seenIds: Readonly<Set<string>>,
  seenOverrides: Readonly<Set<string>>,
): Readonly<{ id: string; overridePackage: string | null }> {
  const id = typeof entry.id === "string" ? entry.id : "";
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  const packageName = typeof entry.package === "string" ? entry.package : "";
  const owner = typeof entry.owner === "string" ? entry.owner.trim() : "";
  const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
  const disposition = typeof entry.disposition === "string" ? entry.disposition.trim() : "";
  const expiresOn = typeof entry.expiresOn === "string" ? entry.expiresOn : "";
  requireCondition(id !== "" && !seenIds.has(id), `exception ids must be unique (${id === "" ? "missing" : id})`);
  requireCondition(EXCEPTION_KINDS.has(kind), `${id} has an unsupported kind`);
  requireCondition(packageName !== "" && owner !== "" && reason !== "" && disposition !== "", `${id} needs package, owner, reason, and disposition`);
  requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) && !Number.isNaN(Date.parse(`${expiresOn}T00:00:00Z`)), `${id} needs an ISO expiry date`);
  requireCondition(expiresOn >= new Date().toISOString().slice(0, 10), `${id} is expired`);
  if (kind === "dependency-override") {
    requireCondition(typeof overrides[packageName] === "string", `${id} does not match a package.json override`);
    requireCondition(entry.constraint === overrides[packageName], `${id} constraint does not match package.json`);
    requireCondition(!seenOverrides.has(packageName), `${packageName} has more than one override exception`);
    return { id, overridePackage: packageName };
  }
  return { id, overridePackage: null };
}

function checkExceptionRegister(packageJson: Readonly<JsonRecord>, exceptions: Readonly<JsonRecord>): void {
  const overrides = stringRecord(packageJson["overrides"]);
  requireCondition(exceptions["version"] === 1 && Array.isArray(exceptions["exceptions"]), "exception register has an invalid schema");
  const exceptionEntries = exceptions["exceptions"];
  if (!Array.isArray(exceptionEntries)) throw new Error("Supply-chain check failed: exception register entries are missing");
  const seenIds = new Set<string>();
  const seenOverrides = new Set<string>();
  for (const entry of exceptionEntries) {
    if (!isRecord(entry)) throw new Error("Supply-chain check failed: exception entries must be objects");
    const checked = checkExceptionEntry(entry, overrides, seenIds, seenOverrides);
    seenIds.add(checked.id);
    if (checked.overridePackage !== null) seenOverrides.add(checked.overridePackage);
  }
  for (const packageName of Object.keys(overrides)) requireCondition(seenOverrides.has(packageName), `package.json override ${packageName} has no expiring exception`);
}

async function checkDependencyPolicy(): Promise<void> {
  const packageJson = await readJson(join(ROOT, "package.json"));
  checkPackageManager(packageJson);
  checkLockIntegrity(await readFile(join(ROOT, "bun.lock"), "utf8"), stringRecord(packageJson["overrides"]));
  checkExceptionRegister(packageJson, await readJson(join(ROOT, "supply-chain/dependency-exceptions.json")));
}

async function checkPinnedBuildInputs(): Promise<void> {
  const dockerfile = await readFile(join(ROOT, "Dockerfile"), "utf8");
  const bases = [...dockerfile.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+[^\s]+)?$/gm)].map((match): string => match[1] ?? "");
  requireCondition(bases.length > 0 && bases.every((base): boolean => /@sha256:[0-9a-f]{64}$/.test(base)), "every Docker base image must use an immutable digest");
  requireCondition(dockerfile.includes("terraform-config-inspect@v0.0.0-"), "terraform-config-inspect must use an exact upstream revision");

  const workflowFiles = (await readdir(join(ROOT, ".github/workflows"))).filter((file): boolean => file.endsWith(".yml") || file.endsWith(".yaml"));
  for (const file of workflowFiles) {
    const content = await readFile(join(ROOT, ".github/workflows", file), "utf8");
    for (const match of content.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)$/gm)) {
      const action = match[1] ?? "";
      requireCondition(/@[0-9a-f]{40}$/.test(action), `${file} has an unpinned action ${action}`);
    }
  }
  const publish = await readFile(join(ROOT, ".github/workflows/docker-publish.yml"), "utf8");
  requireCondition(publish.includes("provenance: mode=max"), "container publish must emit maximum provenance");
  requireCondition(publish.includes("sbom: true"), "container publish must emit an SBOM");
  const cliMatrix = await readJson(join(ROOT, "backend/tests/e2e/cli_matrix.json"));
  for (const tool of ["terraform", "tofu"]) {
    const versions = cliMatrix[tool];
    if (!isRecord(versions)) throw new Error(`Supply-chain check failed: ${tool} compatibility floor/current pins are missing`);
    requireCondition(typeof versions["floor"] === "string" && typeof versions["current"] === "string", `${tool} compatibility floor/current pins are missing`);
  }
}

await Promise.all([checkDependencyPolicy(), checkPinnedBuildInputs()]);
console.log("Supply-chain policy OK: lock integrity, expiring exceptions, pinned build inputs, SBOM, and provenance are present.");
