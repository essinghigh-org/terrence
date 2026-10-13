import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import packageJson from "../package.json";

const root = resolve(import.meta.dir, "..");
const rawVersion = packageJson.packageManager;
const expectedVersion = rawVersion.replace(/^bun@/, "");

if (!/^bun@\d+\.\d+\.\d+$/.test(rawVersion)) {
  console.error("package.json packageManager must pin an exact Bun version");
  process.exit(1);
}

function checkVersion(version: string | undefined, source: string): void {
  if (version !== expectedVersion) {
    console.error(
      `Bun version mismatch: expected ${expectedVersion} (from package.json packageManager), but ${source} uses ${version ?? "no version"}`,
    );
    process.exit(1);
  }
}

checkVersion(Bun.version, "the current runtime");
checkVersion(packageJson.engines.bun, "package.json engines.bun");

const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const dockerPins = [...dockerfile.matchAll(/^FROM\s+oven\/bun:([^\s@]+)/gm)];
if (dockerPins.length === 0) checkVersion(undefined, "Dockerfile");
for (const match of dockerPins) checkVersion(match[1], "Dockerfile");

const workflowDirectory = join(root, ".github/workflows");
for (const file of readdirSync(workflowDirectory).filter((name): boolean => /\.ya?ml$/.test(name))) {
  const workflow = readFileSync(join(workflowDirectory, file), "utf8");
  const pins = [...workflow.matchAll(/^\s*bun-version:\s*["']?([^\s"'#]+)/gm)];
  if (workflow.includes("oven-sh/setup-bun@") && pins.length === 0) checkVersion(undefined, file);
  for (const match of pins) checkVersion(match[1], file);
}

console.log(`Bun version OK: ${expectedVersion} (runtime, package.json, Dockerfile, and GitHub Actions)`);
