import { join, resolve } from "path";
import { mkdir, exists, chmod, unlink } from "fs/promises";
import { spawn } from "bun";

const STORAGE_DIR = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../storage"));
const BINARY_BASE_DIR = join(STORAGE_DIR, "binaries");

export function validateVersion(version: string): boolean {
  if (!version) return false;
  if (version === "latest") return true;
  return /^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/.test(version);
}

export async function resolveLatestVersion(tool: "tofu" | "terraform"): Promise<string> {
  try {
    if (tool === "tofu") {
      const res = await fetch("https://api.github.com/repos/opentofu/opentofu/releases/latest", {
        headers: { "User-Agent": "terrence-iac-manager" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        const tag = data.tag_name?.replace(/^v/, "");
        if (tag && validateVersion(tag)) return tag;
      }
      return "1.7.2";
    } else {
      const res = await fetch("https://checkpoint-api.hashicorp.com/v1/check/terraform", {
        headers: { "User-Agent": "terrence-iac-manager" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.current_version && validateVersion(data.current_version)) return data.current_version;
      }
      return "1.9.3";
    }
  } catch (err) {
    console.warn(`[terrence] Could not resolve latest version for ${tool}, using default:`, err);
    return tool === "tofu" ? "1.7.2" : "1.9.3";
  }
}

async function calculateSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifySha256(tool: "tofu" | "terraform", version: string, filename: string, buffer: ArrayBuffer): Promise<boolean> {
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
        const [expectedHash, file] = parts;
        if (file === filename || file === `./${filename}`) {
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
  } catch (err: any) {
    console.warn(`[terrence] Checksum verification warning: ${err.message || err}`);
    return allowBypass;
  }
}

export async function ensureBinary(toolInput?: string | null, versionInput?: string | null): Promise<{ binaryPath: string; tool: string; version: string } | null> {
  const tool = (toolInput?.toLowerCase() === "terraform" ? "terraform" : "tofu") as "tofu" | "terraform";
  let version = versionInput || "latest";
  const allowSystemFallback = version === "latest" || process.env.ALLOW_TOOL_FALLBACK === "true";

  if (!validateVersion(version)) {
    console.warn(`[terrence] Invalid version format requested: ${versionInput}`);
    return null;
  }

  if (version === "latest") {
    version = await resolveLatestVersion(tool);
  }

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

    console.log(`[terrence] Downloading ${tool} v${version} from ${downloadUrl}`);
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

    let exitCode = -1;
    try {
      const unzipProc = spawn(["unzip", "-o", zipPath, "-d", targetDir]);
      exitCode = await unzipProc.exited;
    } catch (spawnErr: any) {
      console.error(`[terrence] Failed to spawn unzip process: ${spawnErr.message || spawnErr}`);
    }

    try {
      await unlink(zipPath);
    } catch {}

    if (exitCode === 0 && (await exists(binaryPath))) {
      await chmod(binaryPath, 0o755);
      console.log(`[terrence] Successfully installed ${tool} v${version} to ${binaryPath}`);
      return { binaryPath, tool, version };
    } else {
      console.error(`[terrence] Unzip failed with exit code ${exitCode}`);
    }
  } catch (err: any) {
    console.warn(`[terrence] Dynamic download failed for ${tool} v${version}: ${err.message || err}`);
  }

  if (allowSystemFallback) {
    try {
      const sysProc = spawn(["which", tool]);
      if ((await sysProc.exited) === 0) {
        const sysPath = (await new Response(sysProc.stdout).text()).trim();
        if (sysPath) {
          console.log(`[terrence] Falling back to system-installed ${tool} at ${sysPath}`);
          return { binaryPath: sysPath, tool, version: `${version} (system-fallback)` };
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
        if (sysPath) {
          console.warn(`[terrence] ALLOW_TOOL_FALLBACK: using alternative tool ${fallbackTool} at ${sysPath}`);
          return { binaryPath: sysPath, tool: fallbackTool, version: "system-fallback" };
        }
      }
    } catch {}
  }

  return null;
}
