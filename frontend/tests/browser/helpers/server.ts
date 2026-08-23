import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export type TestServer = {
  baseUrl: string;
  apiUrl: string;
  fetch: (path: string) => Promise<Response>;
  close: () => Promise<void>;
};

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
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// Deterministic mock API responses for browser tests
function handleMockApi(req: Request): Response | null {
  const url = new URL(req.url);
  const path = url.pathname;

  const jsonHeaders = {
    "content-type": "application/vnd.api+json",
    "cache-control": "no-cache",
  };

  if (path === "/api/v2/ping") {
    return new Response(JSON.stringify({ data: { type: "pings", id: "ping", attributes: { status: "ok" } } }), {
      headers: jsonHeaders,
    });
  }

  if (path === "/api/v2/users/refresh" || path === "/api/v2/sessions" || path === "/api/v2/users/login") {
    return new Response(
      JSON.stringify({
        data: {
          id: "session-1",
          type: "sessions",
          attributes: {
            token: "terr_test_mock_admin_token_1234567890abcdef",
            "expired-at": "2030-01-01T00:00:00.000Z",
          },
        },
      }),
      {
        headers: {
          ...jsonHeaders,
          "set-cookie": "terrence_refresh=1; HttpOnly; Path=/; SameSite=Lax",
        },
      }
    );
  }

  if (path === "/api/v2/account/details") {
    return new Response(
      JSON.stringify({
        data: {
          id: "user-admin",
          type: "users",
          attributes: {
            username: "admin",
            email: "admin@example.com",
            "is-site-admin": true,
            "has-password": true,
            "mfa-enabled": false,
            "avatar-url": null,
            "created-at": "2026-01-01T00:00:00.000Z",
            permissions: {
              "can-create-organizations": true,
              "can-change-username": true,
              "can-change-email": true,
              "can-manage-tokens": true,
            },
          },
          relationships: {
            organizations: {
              data: [{ id: "essinghigh-org", type: "organizations" }],
            },
          },
        },
        included: [
          {
            id: "essinghigh-org",
            type: "organizations",
            attributes: {
              name: "essinghigh-org",
              permissions: {
                "can-update": true,
                "can-destroy": true,
                "can-manage-users": true,
                "can-manage-workspaces": true,
              },
            },
          },
        ],
      }),
      { headers: jsonHeaders }
    );
  }

  if (path === "/api/v2/organizations" || path === "/api/v2/organizations/essinghigh-org") {
    return new Response(
      JSON.stringify({
        data: {
          id: "essinghigh-org",
          type: "organizations",
          attributes: {
            name: "essinghigh-org",
            "created-at": "2026-01-01T00:00:00.000Z",
            permissions: {
              "can-update": true,
              "can-destroy": true,
              "can-manage-users": true,
              "can-manage-workspaces": true,
            },
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path === "/api/v2/organizations/essinghigh-org/workspaces") {
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "ws-1",
            type: "workspaces",
            attributes: {
              name: "tf-deploy-github-repository",
              "created-at": "2026-01-01T00:00:00.000Z",
              "updated-at": "2026-01-01T00:00:00.000Z",
              "execution-mode": "remote",
              "auto-apply": false,
              locked: false,
              "resource-count": 3,
              "current-run": {
                id: "423b4c6e-3b0b-4707-94c6-678d80c43f09",
                status: "applied",
                "created-at": "2026-01-01T00:00:00.000Z",
              },
              permissions: {
                "can-update": true,
                "can-destroy": true,
                "can-queue-run": true,
                "can-lock": true,
                "can-unlock": true,
                "can-read-state": true,
              },
            },
          },
        ],
        meta: {
          pagination: { "current-page": 1, "total-pages": 1, "total-count": 1 },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (
    path === "/api/v2/organizations/essinghigh-org/workspaces/tf-deploy-github-repository" ||
    path === "/api/v2/workspaces/ws-1"
  ) {
    return new Response(
      JSON.stringify({
        data: {
          id: "ws-1",
          type: "workspaces",
          attributes: {
            name: "tf-deploy-github-repository",
            "created-at": "2026-01-01T00:00:00.000Z",
            "updated-at": "2026-01-01T00:00:00.000Z",
            "execution-mode": "remote",
            "auto-apply": false,
            locked: false,
            "resource-count": 3,
            "current-run": {
              id: "423b4c6e-3b0b-4707-94c6-678d80c43f09",
              status: "applied",
              "created-at": "2026-01-01T00:00:00.000Z",
            },
            permissions: {
              "can-update": true,
              "can-destroy": true,
              "can-queue-run": true,
              "can-lock": true,
              "can-unlock": true,
              "can-read-state": true,
            },
          },
          relationships: {
            organization: {
              data: { id: "essinghigh-org", type: "organizations" },
            },
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path === "/api/v2/workspaces/ws-1/runs") {
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "423b4c6e-3b0b-4707-94c6-678d80c43f09",
            type: "runs",
            attributes: {
              status: "applied",
              "created-at": "2026-01-01T00:00:00.000Z",
              message: "Deploy production infrastructure",
              "is-destroy": false,
              "plan-only": false,
              "auto-apply": false,
              "has-changes": true,
              "resource-additions": 3,
              "resource-changes": 0,
              "resource-destructions": 0,
              actions: {
                "is-cancelable": false,
                "is-confirmable": false,
                "is-discardable": false,
                "is-force-cancelable": false,
              },
              permissions: {
                "can-apply": true,
                "can-cancel": true,
                "can-discard": true,
                "can-force-cancel": true,
              },
            },
          },
        ],
        meta: {
          pagination: { "current-page": 1, "total-pages": 1, "total-count": 1 },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path === "/api/v2/runs/423b4c6e-3b0b-4707-94c6-678d80c43f09") {
    return new Response(
      JSON.stringify({
        data: {
          id: "423b4c6e-3b0b-4707-94c6-678d80c43f09",
          type: "runs",
          attributes: {
            status: "applied",
            "created-at": "2026-01-01T00:00:00.000Z",
            message: "Deploy production infrastructure",
            "is-destroy": false,
            "plan-only": false,
            "auto-apply": false,
            "has-changes": true,
            "resource-additions": 3,
            "resource-changes": 0,
            "resource-destructions": 0,
            actions: {
              "is-cancelable": false,
              "is-confirmable": false,
              "is-discardable": false,
              "is-force-cancelable": false,
            },
            permissions: {
              "can-apply": true,
              "can-cancel": true,
              "can-discard": true,
              "can-force-cancel": true,
            },
          },
          relationships: {
            workspace: {
              data: { id: "ws-1", type: "workspaces" },
            },
            plan: {
              data: { id: "plan-1", type: "plans" },
            },
            apply: {
              data: { id: "apply-1", type: "applies" },
            },
          },
        },
        included: [
          {
            id: "plan-1",
            type: "plans",
            attributes: {
              status: "finished",
              "has-changes": true,
              "resource-additions": 3,
              "resource-changes": 0,
              "resource-destructions": 0,
              "log-read-url": null,
            },
          },
          {
            id: "apply-1",
            type: "applies",
            attributes: {
              status: "finished",
              "resource-additions": 3,
              "resource-changes": 0,
              "resource-destructions": 0,
              "log-read-url": null,
            },
          },
        ],
      }),
      { headers: jsonHeaders }
    );
  }

  if (path === "/api/v2/runs/423b4c6e-3b0b-4707-94c6-678d80c43f09/plan") {
    return new Response(
      JSON.stringify({
        data: {
          id: "plan-1",
          type: "plans",
          attributes: {
            status: "finished",
            "has-changes": true,
            "resource-additions": 3,
            "resource-changes": 0,
            "resource-destructions": 0,
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path === "/api/v2/applies/apply-423b4c6e-3b0b-4707-94c6-678d80c43f09") {
    return new Response(
      JSON.stringify({
        data: {
          id: "apply-1",
          type: "applies",
          attributes: {
            status: "finished",
            "resource-additions": 3,
            "resource-changes": 0,
            "resource-destructions": 0,
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path === "/api/v2/admin/security") {
    return new Response(
      JSON.stringify({
        data: {
          id: "security",
          type: "admin-security",
          attributes: {
            "mfa-required": false,
            "session-timeout-minutes": 1440,
            "password-min-length": 12,
            "password-require-uppercase": true,
            "password-require-numbers": true,
            "password-require-symbols": true,
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path === "/api/v2/admin/operations") {
    return new Response(
      JSON.stringify({
        data: {
          id: "operations",
          type: "admin-operations",
          attributes: {
            "active-workers": 1,
            "queued-runs": 0,
            "running-runs": 0,
            "disk-usage-percent": 24,
            "database-type": "sqlite",
            "terrence-version": "1.4.0",
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path.startsWith("/api/v2/admin/")) {
    return new Response(
      JSON.stringify({
        data: {
          id: "admin",
          type: "admin-settings",
          attributes: {
            "allow-user-registration": true,
            "system-banner": null,
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path.includes("/relationships/") || path.endsWith("/vars") || path.endsWith("/resources") || path.endsWith("/projects") || path.endsWith("/agent-pools")) {
    return new Response(
      JSON.stringify({
        data: [],
        meta: { "current-page": 1, "total-pages": 1, "total-count": 0 },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path.endsWith("/plan")) {
    return new Response(
      JSON.stringify({
        data: {
          id: "plan-1",
          type: "plans",
          attributes: {
            status: "finished",
            "has-changes": true,
            "resource-additions": 3,
            "resource-changes": 0,
            "resource-destructions": 0,
            "log-read-url": null,
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path.endsWith("/apply")) {
    return new Response(
      JSON.stringify({
        data: {
          id: "apply-1",
          type: "applies",
          attributes: {
            status: "finished",
            "resource-additions": 3,
            "resource-changes": 0,
            "resource-destructions": 0,
            "log-read-url": null,
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  // Generic JSON:API fallback for unhandled /api requests
  return new Response(
    JSON.stringify({
      data: [],
      meta: { message: "Mock endpoint fallback" },
    }),
    { headers: jsonHeaders }
  );
}

/**
 * Start a static preview server for the frontend build output on an ephemeral port.
 */
export async function startStaticServer(customDistDir?: string): Promise<TestServer> {
  const distDir = customDistDir ?? resolve(import.meta.dir, "../../../dist");

  if (!existsSync(distDir) || !existsSync(join(distDir, "index.html"))) {
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
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // Handle /api requests
      if (url.pathname.startsWith("/api/")) {
        const backendUrl = process.env.TERRENCE_API_URL;
        if (backendUrl) {
          const target = new URL(url.pathname + url.search, backendUrl);
          try {
            return await fetch(target.toString(), {
              method: req.method,
              headers: req.headers,
              body: req.body,
            });
          } catch (err: unknown) {
            return new Response(JSON.stringify({ error: "Backend proxy error" }), {
              status: 502,
              headers: { "content-type": "application/json" },
            });
          }
        }
        const mockRes = handleMockApi(req);
        if (mockRes) return mockRes;
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      if (pathname === "/") pathname = "/index.html";

      const normalized = normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
      const filePath = resolve(distDir, "." + normalized);
      const rel = relative(distDir, filePath);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return new Response("Forbidden", { status: 403 });
      }

      try {
        const content = readFileSync(filePath);
        const ext = pathname.slice(pathname.lastIndexOf("."));
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        return new Response(content, {
          headers: {
            "content-type": contentType,
            "cache-control": "no-cache",
          },
        });
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
    apiUrl: `http://127.0.0.1:${server.port}/api`,
    fetch: async (path: string): Promise<Response> => await server.fetch(new Request(`http://127.0.0.1:${server.port}${path}`)),
    close: async (): Promise<void> => {
      await server.stop(true);
    },
  };
}

/**
 * Start test servers (frontend static server with built-in or proxied API).
 */
export async function startTestServer(): Promise<TestServer> {
  return await startStaticServer();
}
