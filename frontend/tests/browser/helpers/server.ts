import { join, resolve } from "node:path";
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
    await buildProc.exited;
  }

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";

      const filePath = resolve(distDir, `.${pathname}`);
      if (!filePath.startsWith(distDir)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (existsSync(filePath) && statSync(filePath).isFile()) {
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

      // SPA fallback to index.html
      const indexPath = join(distDir, "index.html");
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath, "utf8");
        return new Response(content, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
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
