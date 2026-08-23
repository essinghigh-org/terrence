import tailwind from "bun-plugin-tailwind";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const isDev = process.argv.includes("--development") || process.argv.includes("--mode=development");
const frontendDir = join(import.meta.dir, "..");
const outDir = join(frontendDir, "dist");
const publicDir = join(frontendDir, "public");

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(frontendDir, "index.html")],
  outdir: outDir,
  target: "browser",
  publicPath: "/",
  minify: !isDev,
  splitting: true,
  plugins: [tailwind],
  metafile: true,
  sourcemap: isDev ? "inline" : "none",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Copy unreferenced or directly expected public assets into dist
if (existsSync(publicDir)) {
  cpSync(publicDir, outDir, { recursive: true });
}

console.log(`Frontend build completed successfully (${result.outputs.length} outputs, ${isDev ? "development" : "production"} mode).`);
