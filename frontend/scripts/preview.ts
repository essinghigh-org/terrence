import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

function parsePort(): number {
  const portArgIdx = process.argv.indexOf("--port");
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1] !== undefined) {
    const p = Number(process.argv[portArgIdx + 1]);
    if (Number.isFinite(p) && p > 0) return p;
  }
  const envPort = Number(process.env.PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return 4173;
}

function parseHost(): string {
  const hostArgIdx = process.argv.indexOf("--host");
  if (hostArgIdx !== -1) {
    const val = process.argv[hostArgIdx + 1];
    if (typeof val === "string" && val !== "") return val;
  }
  return process.env.HOST ?? "127.0.0.1";
}

const port = parsePort();
const hostname = parseHost();
const distDir = resolve(join(import.meta.dir, "../dist"));
const distDirWithSlash = distDir.endsWith("/") ? distDir : distDir + "/";

if (!existsSync(distDir)) {
  console.error("frontend/dist does not exist. Run `bun run build` first.");
  process.exit(1);
}

const indexHtmlPath = join(distDir, "index.html");
if (!existsSync(indexHtmlPath)) {
  console.error("frontend/dist/index.html is missing. Run `bun run build` first.");
  process.exit(1);
}

const server = Bun.serve({
  port,
  hostname,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  fetch(req: Request): Response {
    const url = new URL(req.url);
    const pathname = decodeURIComponent(url.pathname);

    // Normalize path to prevent directory traversal
    const normalizedPath = normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
    const requestedPath = resolve(distDir, "." + normalizedPath);

    // Security check: must stay within distDir
    if (requestedPath !== distDir && !requestedPath.startsWith(distDirWithSlash)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      if (existsSync(requestedPath)) {
        const stat = statSync(requestedPath);
        if (stat.isFile()) {
          const file = Bun.file(requestedPath);
          const headers = new Headers();
          // Add caching headers for hashed assets
          if (pathname.startsWith("/chunk-") || pathname.includes("-")) {
            headers.set("cache-control", "public, max-age=31536000, immutable");
          }
          return new Response(file, { headers });
        }
        if (stat.isDirectory()) {
          const nestedIndex = join(requestedPath, "index.html");
          if (existsSync(nestedIndex)) {
            return new Response(Bun.file(nestedIndex), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
        }
      }
    } catch {
      // Ignore filesystem errors and proceed
    }

    // Do not serve index.html for missing asset requests with file extensions
    if (/\.[a-zA-Z0-9]+$/.test(pathname)) {
      return new Response("Not Found", { status: 404 });
    }

    // SPA fallback: return index.html for navigation routes
    return new Response(Bun.file(indexHtmlPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Terrence frontend preview server running at http://${String(server.hostname)}:${String(server.port)}`);
