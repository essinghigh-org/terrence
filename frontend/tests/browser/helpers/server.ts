import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

export type TestServer = {
  baseUrl: string;
  apiUrl?: string;
  close: () => Promise<void>;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Start a static preview server for the frontend build output on an ephemeral port.
 */
export async function startStaticServer(customDistDir?: string): Promise<TestServer> {
  const distDir = customDistDir ?? resolve(import.meta.dir, "../../../dist");

  if (!existsSync(distDir) || !existsSync(join(distDir, "index.html"))) {
    // Run frontend build if dist is missing
    const buildProc = Bun.spawn(["bun", "run", "build"], {
      cwd: resolve(import.meta.dir, "../../../"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(buildProc.stdout).text(),
      new Response(buildProc.stderr).text(),
      buildProc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Frontend build failed (exit ${String(exitCode)}):\n${stdout}\n${stderr}`);
    }
  }

  const server = Bun.serve({
    port: 0,
    fetch(req: Readonly<Request>): Response {
      const url = new URL(req.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";

      const normalized = normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
      const filePath = resolve(distDir, "." + normalized);
      const rel = relative(distDir, filePath);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return new Response("Forbidden", { status: 403 });
      }

      try {
        const stat = statSync(filePath);
        if (stat.isFile()) {
          const ext = pathname.slice(pathname.lastIndexOf("."));
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          const content = readFileSync(filePath);
          return new Response(content, {
            headers: {
              "content-type": contentType,
              "cache-control": "no-cache",
            },
          });
        }
      } catch {
        // Fall through to SPA fallback
      }

      // Do not serve index.html for missing asset requests with file extensions
      if (/\.[a-zA-Z0-9]+$/.test(pathname)) {
        return new Response("Not Found", { status: 404 });
      }

      // SPA fallback to index.html
      try {
        const indexPath = join(distDir, "index.html");
        const content = readFileSync(indexPath, "utf8");
        return new Response(content, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    close: async (): Promise<void> => {
      await server.stop(true);
    },
  };
}

/**
 * Start authenticated test servers (frontend static server + mock/ephemeral backend API).
 */
export async function startTestServer(): Promise<TestServer> {
  const staticServer = await startStaticServer();
  return {
    baseUrl: staticServer.baseUrl,
    apiUrl: process.env.TERRENCE_API_URL ?? `${staticServer.baseUrl}/api`,
    close: async () => {
      await staticServer.close();
    },
  };
}
