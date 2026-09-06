import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const publicDir = resolve(import.meta.dir, "../public");
const iconsDir = join(publicDir, "icons");
const manifestPath = join(iconsDir, "brand-manifest.json");

const iconSpecs = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
  { name: "maskable-512.png", size: 512 },
] as const;

type IconManifest = Readonly<{
  version: 1;
  sourceSha256: string;
  icons: Readonly<Record<string, Readonly<{ size: number; sha256: string }>>>;
}>;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function pngSize(path: string): number {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`Invalid PNG header: ${path}`);
  }
  return bytes.readUInt32BE(16);
}

function readManifest(path = manifestPath): IconManifest {
  if (!existsSync(path)) throw new Error(`Missing generated icon manifest: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<IconManifest>;
  if (parsed.version !== 1 || typeof parsed.sourceSha256 !== "string" || parsed.icons === undefined) {
    throw new Error(`Invalid generated icon manifest: ${manifestPath}`);
  }
  return parsed as IconManifest;
}

export function verifyBrandIcons(root = publicDir): void {
  const faviconPath = join(root, "favicon.svg");
  const manifest = readManifest(join(root, "icons", "brand-manifest.json"));
  const sourceHash = sha256(readFileSync(faviconPath));
  if (manifest.sourceSha256 !== sourceHash) {
    throw new Error(`Stale generated icons: ${faviconPath} changed. Run frontend/scripts/brand-icons.ts.`);
  }
  for (const spec of iconSpecs) {
    const path = join(root, "icons", spec.name);
    const recorded = manifest.icons[spec.name];
    if (recorded === undefined || recorded.size !== spec.size || pngSize(path) !== spec.size) {
      throw new Error(`Invalid generated icon dimensions: ${path}`);
    }
    const actualHash = sha256(readFileSync(path));
    if (recorded.sha256 !== actualHash) throw new Error(`Stale generated icon: ${path}. Run frontend/scripts/brand-icons.ts.`);
  }
}

function rasterize(source: string, output: string, size: number): void {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), source, "-o", output], { stdio: "inherit" });
}

export function generateBrandIcons(root = publicDir): void {
  const source = join(root, "favicon.svg");
  const outputDir = join(root, "icons");
  const temporaryDir = mkdtempSync(join(tmpdir(), "terrence-brand-"));
  try {
    const regular = iconSpecs.filter((spec): boolean => spec.name !== "maskable-512.png");
    for (const spec of regular) rasterize(source, join(outputDir, spec.name), spec.size);
    const mark = join(temporaryDir, "mark-360.png");
    rasterize(source, mark, 360);
    execFileSync("magick", ["-size", "512x512", "xc:#233654", mark, "-gravity", "center", "-compose", "over", "-composite", `PNG32:${join(outputDir, "maskable-512.png")}`], { stdio: "inherit" });

    const icons = Object.fromEntries(iconSpecs.map((spec): [string, { size: number; sha256: string }] => {
      const path = join(outputDir, spec.name);
      return [spec.name, { size: pngSize(path), sha256: sha256(readFileSync(path)) }];
    }));
    const manifest: IconManifest = { version: 1, sourceSha256: sha256(readFileSync(source)), icons };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.includes("--check")) verifyBrandIcons();
  else generateBrandIcons();
}
