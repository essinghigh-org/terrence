import { isAbsolute, join, relative, resolve, sep } from "path";
import { mkdir, exists, chmod, unlink, readdir, rm } from "fs/promises";
import { spawn } from "bun";
import { log } from "./lib/log";

const STORAGE_DIR = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../storage"));
const BINARY_BASE_DIR = join(STORAGE_DIR, "binaries");

/** Reject a single archive entry whose normalized path escapes the extraction
 * root via an absolute path, a drive letter, or a `..` traversal segment. */
function zipEntryEscapes(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/");
  return normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((segment): boolean => segment === "..");
}

/** Inspect a Zip archive's member list before extracting so a potentially
 * malicious entry can never be written outside the target directory. Returns
 * the member names, or `null` if the listing could not be produced. */
async function listZipEntries(zipPath: string): Promise<string[] | null> {
  const listingProc = spawn(["unzip", "-Z1", zipPath], { stdout: "pipe", stderr: "pipe" });
  const listingText = await new Response(listingProc.stdout).text();
  if ((await listingProc.exited) !== 0) return null;
  return listingText.split("\n").map((entry): string => entry.trim()).filter((entry): boolean => entry !== "");
}

export function validateVersion(version: string): boolean {
  if (version === "") return false;
  if (version === "latest") return true;
  // Allow exact semver
  if (/^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/.test(version)) return true;
  // ~> requires full X.Y.Z (not shorthand ~> 1.5 or ~> 1)
  if (/^~> v?[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) return true;
  if (/^>= v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) return true;
  if (/^<= v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) return true;
  if (/^> v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) return true;
  if (/^< v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) return true;
  // Comma-separated: ">= 1.2, < 2.0" (no != allowed)
  if (/^[><=~]+ v?[0-9.]+(, [><=~]+ v?[0-9.]+)*$/.test(version) && !version.includes("!=")) return true;
  return false;
}

  // Strip pre-release suffix (everything after the first `-`) before numeric version segment parsing
  function parseSemver(version: string): number[] {
  const clean = version.replace(/^v/, "").split("-")[0];
  return (clean ?? "").split(".").map((s: string): number => Number.parseInt(s, 10));
}

function compareSemver(a: string, b: string): number {
  const aParts = parseSemver(a);
  const bParts = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const aNum = aParts[i];
    const bNum = bParts[i];
    const aVal = typeof aNum === "number" && !Number.isNaN(aNum) ? aNum : 0;
    const bVal = typeof bNum === "number" && !Number.isNaN(bNum) ? bNum : 0;
    if (aVal !== bVal) return aVal - bVal;
  }
  // Pre-release sorts below stable: a build with a `-` suffix comes before the same version without one
  const aHasPre = a.replace(/^v/, "").includes("-");
  const bHasPre = b.replace(/^v/, "").includes("-");
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  return 0;
}

function matchesConstraint(version: string, constraint: string): boolean {
  const trimmed = constraint.trim();
  if (trimmed.startsWith("~> ")) {
    // Pessimistic: >= X.Y.Z, < X.(Y+1).0
    const target = trimmed.slice(3).replace(/^v/, "");
    const parts = target.split(".").map((s: string): number => Number.parseInt(s, 10));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const upper = `${major}.${minor + 1}.0`;
    return compareSemver(version, target) >= 0 && compareSemver(version, upper) < 0;
  }
  if (trimmed.startsWith(">= ")) {
    const target = trimmed.slice(3).replace(/^v/, "");
    return compareSemver(version, target) >= 0;
  }
  if (trimmed.startsWith("<= ")) {
    const target = trimmed.slice(3).replace(/^v/, "");
    return compareSemver(version, target) <= 0;
  }
  if (trimmed.startsWith("> ")) {
    const target = trimmed.slice(2).replace(/^v/, "");
    return compareSemver(version, target) > 0;
  }
  if (trimmed.startsWith("< ")) {
    const target = trimmed.slice(2).replace(/^v/, "");
    return compareSemver(version, target) < 0;
  }
  // Exact
  return compareSemver(version, trimmed.replace(/^v/, "")) === 0;
}

function matchesConstraints(version: string, constraintExpr: string): boolean {
  if (constraintExpr === "latest") return true;
  const constraints = constraintExpr.split(",").map((s: string): string => s.trim());
  return constraints.every((c: string): boolean => matchesConstraint(version, c));
}

async function resolveLatestVersion(tool: "tofu" | "terraform"): Promise<string> {
  try {
    if (tool === "tofu") {
      const res = await fetch("https://api.github.com/repos/opentofu/opentofu/releases/latest", {
        headers: { "User-Agent": "terrence-iac-manager" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const tagName = data.tag_name;
        const tag = typeof tagName === "string" ? tagName.replace(/^v/, "") : undefined;
        if (tag !== undefined && validateVersion(tag)) return tag;
      }
      return "1.7.2";
    } else {
      const res = await fetch("https://checkpoint-api.hashicorp.com/v1/check/terraform", {
        headers: { "User-Agent": "terrence-iac-manager" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const currentVersion = data.current_version;
        if (typeof currentVersion === "string" && validateVersion(currentVersion)) return currentVersion;
      }
      return "1.9.3";
    }
  } catch (err: unknown) {
    log.warn(`Could not resolve latest version for ${tool}, using default`, { tool, error: err instanceof Error ? err.message : String(err) });
    return tool === "tofu" ? "1.7.2" : "1.9.3";
  }
}

// Short-lived cache for available versions
const versionCache = new Map<string, { versions: string[]; fetchedAt: number }>();
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchAvailableVersions(tool: "tofu" | "terraform"): Promise<string[]> {
  const cached = versionCache.get(tool);
  if (cached !== undefined && Date.now() - cached.fetchedAt < VERSION_CACHE_TTL_MS) {
    return cached.versions;
  }

  try {
    let versions: string[] = [];
    if (tool === "tofu") {
      // Paginate through all GitHub releases
      let page = 1;
      while (page <= 100) {
        const res = await fetch(
          `https://api.github.com/repos/opentofu/opentofu/releases?per_page=100&page=${page}`,
          {
            headers: { "User-Agent": "terrence-iac-manager" },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!res.ok) break;
        const data = (await res.json()) as Record<string, unknown>[];
        if (!Array.isArray(data) || data.length === 0) break;
        versions.push(...data
          .map((r: Readonly<Record<string, unknown>>): string | undefined => {
            const tagName = r.tag_name;
            return typeof tagName === "string" ? tagName.replace(/^v/, "") : undefined;
          })
          .filter((v: string | undefined): v is string => v !== undefined && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)));
        page++;
        if (data.length < 100) break;
      }
    } else {
      const res = await fetch("https://releases.hashicorp.com/terraform/index.json", {
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = (await res.json()) as { versions?: Record<string, unknown> };
        versions = Object.keys(data.versions ?? {})
          .filter((v: string): boolean => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v));
      }
    }
    versions.sort(compareSemver);
    versionCache.set(tool, { versions, fetchedAt: Date.now() });
    return versions;
  } catch {
    if (cached !== undefined) return cached.versions;
    throw new Error(`Failed to fetch available versions for ${tool}`);
  }
}

export async function availableVersions(tool: "tofu" | "terraform"): Promise<string[]> {
  return fetchAvailableVersions(tool);
}

async function resolveVersionConstraint(tool: "tofu" | "terraform", constraintExpr: string): Promise<string> {
  if (constraintExpr === "latest") {
    return resolveLatestVersion(tool);
  }
  // Check if it's already an exact version
  if (/^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/.test(constraintExpr.replace(/^v/, ""))) {
    return constraintExpr.replace(/^v/, "");
  }
  // Fetch available versions and find best match
  const available = await fetchAvailableVersions(tool);
  if (available.length === 0) {
    // No versions available — fail through ensureBinary error path
    throw new Error(`Could not fetch available versions for ${tool}`);
  }
  // Find the highest version matching the constraint (iterate descending)
  for (let i = available.length - 1; i >= 0; i--) {
    const candidate = available[i];
    if (candidate !== undefined && matchesConstraints(candidate, constraintExpr)) {
      return candidate;
    }
  }
  // No match found — throw
  throw new Error(`No ${tool} version matching "${constraintExpr}" found`);
}

async function calculateSha256(buffer: Readonly<ArrayBuffer>): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b: number): string => b.toString(16).padStart(2, "0")).join("");
}

async function verifySha256(tool: "tofu" | "terraform", version: string, filename: string, buffer: Readonly<ArrayBuffer>): Promise<boolean> {

  const allowBypass = process.env.ALLOW_TOOL_FALLBACK === "true" || process.env.ALLOW_UNVERIFIED_CHECKSUMS === "true";
  try {
    let checksumUrl = "";
    if (tool === "tofu") {
      checksumUrl = `https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_SHA256SUMS`;
    } else {
      checksumUrl = `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_SHA256SUMS`;
    }

    const res = await fetch(checksumUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`[terrence] Could not download SHA256SUMS for ${tool} v${version}`);
      return allowBypass;
    }

    const text = await res.text();
    const actualHash = await calculateSha256(buffer);

    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const expectedHash = parts[0];
        const file = parts[1];
        if (expectedHash !== undefined && (file === filename || file === `./${filename}`)) {
          if (expectedHash.toLowerCase() !== actualHash.toLowerCase()) {
            console.error(`[terrence] SHA256 mismatch for ${filename}! Expected ${expectedHash}, got ${actualHash}`);
            return false;
          }
          return true;
        }
      }
    }
    console.error(`[terrence] Checksum entry not found for ${filename}`);
    return allowBypass;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[terrence] Checksum verification warning: ${errMsg}`);
    return allowBypass;
  }
}

export async function ensureBinary(toolInput?: string | null, versionInput?: string | null): Promise<{ binaryPath: string; tool: string; version: string } | null> {
  const tool = (toolInput?.toLowerCase() === "terraform" ? "terraform" : "tofu");
  let version = (versionInput !== null && versionInput !== undefined && versionInput !== "" ? versionInput : "latest");
  const allowSystemFallback = version === "latest" || process.env.ALLOW_TOOL_FALLBACK === "true";

  if (!validateVersion(version)) {
    console.warn(`[terrence] Invalid version format requested: ${versionInput ?? ""}`);
    return null;
  }

  // Resolve constraints to exact versions
  version = await resolveVersionConstraint(tool, version);
  version = version.replace(/^v/, "");

  const targetDir = join(BINARY_BASE_DIR, tool, version);
  const binaryPath = join(targetDir, tool);

  if (await exists(binaryPath)) {
    return { binaryPath, tool, version };
  }

  try {
    await mkdir(targetDir, { recursive: true });
    const zipPath = join(targetDir, "download.zip");

    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const os = process.platform === "darwin" ? "darwin" : "linux";

    const zipFilename = tool === "tofu"
      ? `tofu_${version}_${os}_${arch}.zip`
      : `terraform_${version}_${os}_${arch}.zip`;

    const downloadUrl = tool === "tofu"
      ? `https://github.com/opentofu/opentofu/releases/download/v${version}/${zipFilename}`
      : `https://releases.hashicorp.com/terraform/${version}/${zipFilename}`;

    log.info(`Downloading ${tool} v${version} from ${downloadUrl}`);
    const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });

    if (!res.ok) {
      throw new Error(`HTTP status ${res.status} when fetching binary package`);
    }

    const arrayBuffer = await res.arrayBuffer();

    const isValidHash = await verifySha256(tool, version, zipFilename, arrayBuffer);
    if (!isValidHash) {
      throw new Error(`SHA256 verification failed for ${zipFilename}`);
    }

    await Bun.write(zipPath, arrayBuffer);

    // Zip Slip protection: verify the archive's member list BEFORE extraction
    // so a malicious entry can never be written outside the target directory.
    const zipEntries = await listZipEntries(zipPath);
    if (zipEntries === null || zipEntries.some(zipEntryEscapes)) {
      await rm(targetDir, { recursive: true, force: true });
      throw new Error("Zip Slip detected: archive contains a path that escapes the target directory");
    }

    let exitCode = -1;
    try {
      const unzipProc = spawn(["unzip", "-o", zipPath, "-d", targetDir]);
      exitCode = await unzipProc.exited;
      // Defense in depth: confirm every extracted path still resolves under the
      // target directory (path containment, not a string prefix check).
      if (exitCode === 0) {
        const resolvedTarget = resolve(targetDir);
        const entries = await readdir(targetDir, { recursive: true, withFileTypes: false });
        const escaped = entries.some((entry): boolean => {
          const relativePath = relative(resolvedTarget, resolve(join(targetDir, entry)));
          return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
        });
        if (escaped) {
          exitCode = -1;
          try {
            await rm(targetDir, { recursive: true, force: true });
          } catch {
            // Cleanup failure is secondary — Zip Slip error is primary
          }
        }
      }
    } catch (spawnErr: unknown) {
      exitCode = -1;
      const spawnMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      console.error(`[terrence] Failed to spawn unzip process: ${spawnMsg}`);
    }

    try {
      await unlink(zipPath);
    } catch {}

    if (exitCode === 0 && (await exists(binaryPath))) {
      await chmod(binaryPath, 0o755);
      log.info(`Successfully installed ${tool} v${version} to ${binaryPath}`);
      return { binaryPath, tool, version };
    } else {
      console.error(`[terrence] Unzip failed with exit code ${exitCode}`);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[terrence] Dynamic download failed for ${tool} v${version}: ${errMsg}`);
  }

  if (allowSystemFallback) {
    try {
      const sysProc = spawn(["which", tool]);
      if ((await sysProc.exited) === 0) {
        const sysPath = (await new Response(sysProc.stdout).text()).trim();
        if (sysPath !== "") {
          // Validate the system binary version before accepting fallback
          const versionProc = spawn([sysPath, "version"]);
          if ((await versionProc.exited) === 0) {
            const versionOutput = (await new Response(versionProc.stdout).text()).trim();
            const vMatch = /(\d+\.\d+\.\d+)/.exec(versionOutput);
            if (vMatch !== null) {
              const sysVersion = vMatch[1];
              if (sysVersion !== undefined && matchesConstraints(sysVersion, version)) {
                log.info(`System-installed ${tool} v${sysVersion} satisfies constraint "${version}" at ${sysPath}`);
                return { binaryPath: sysPath, tool, version: sysVersion };
              }
            }
          }
          console.warn(`[terrence] System-installed ${tool} at ${sysPath} does not satisfy version constraint "${version}", skipping`);
        }
      }
    } catch {}
  }

  // Alternate-tool fallback ONLY if opt-in via environment flag
  if (process.env.ALLOW_TOOL_FALLBACK === "true") {
    const fallbackTool = tool === "tofu" ? "terraform" : "tofu";
    try {
      const sysAlt = spawn(["which", fallbackTool]);
      if ((await sysAlt.exited) === 0) {
        const sysPath = (await new Response(sysAlt.stdout).text()).trim();
        if (sysPath !== "") {
          console.warn(`[terrence] ALLOW_TOOL_FALLBACK: using alternative tool ${fallbackTool} at ${sysPath}`);
          return { binaryPath: sysPath, tool: fallbackTool, version: "system-fallback" };
        }
      }
    } catch {}
  }

  return null;
}
