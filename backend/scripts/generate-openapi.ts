import { writeFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(
  await Bun.file(join(import.meta.dir, "../../package.json")).text(),
) as { version?: string };

const version = pkg.version ?? "0.0.0";

// Import app without triggering DB migration against a stale file: run with
// a temp DB so drizzle's migrate does not fail on leftover schemas.
process.env.DATABASE_URL ??= `file:${join(import.meta.dir, "../.tmp-openapi.db")}`;
process.env.STORAGE_DIR ??= join(import.meta.dir, "../.tmp-openapi-storage");
process.env.TERRENCE_DISABLE_WORKER = "1";

const { app } = await import("../src/app");

// Collect every registered route (Elysia exposes them via app.routes).
type Route = Readonly<{ method: string; path: string }>;
const routes = (app as unknown as { routes: Route[] }).routes;

function tagForPath(path: string): string[] {
  // Derive a tag from the first two path segments so the generated spec groups
  // sensibly (organizations, workspaces, runs, …). Frontend catch-alls get no tag.
  if (path.startsWith("/api/v2/")) {
    const seg = path.slice("/api/v2/".length).split("/")[0] ?? "misc";
    return [seg];
  }
  if (path.startsWith("/api/v1/") || path.startsWith("/api/v1/")) return ["system"];
  if (path.startsWith("/api/")) return ["api"];
  if (path === "/openapi.json") return [];
  return [];
}

// Build a minimal valid OAS 3.1 document. Per-route schemas can be added
// incrementally; today every operation gets a generic JSON:API response stub
// so the contract is still machine-readable and testable against registration.
const paths: Record<string, Record<string, unknown>> = {};

for (const route of routes) {
  const { method, path } = route;
  // Exclude frontend shell / static fallbacks and the internal static wildcard.
  if (
    path === "/" ||
    path === "/login" ||
    path === "/register" ||
    path === "/app" ||
    path === "/app/*" ||
    path === "*" ||
    path === "/*"
  ) {
    continue;
  }
  // Elysia may register HEAD/OPTIONS automatically; keep only the declared verbs.
  const m = method.toLowerCase();
  if (!["get", "post", "put", "patch", "delete", "options", "head"].includes(m)) continue;
  // Skip internal plugin routes (openapi's own /openapi/json if present).
  if (path.startsWith("/openapi")) continue;

  const openApiPath = path;
  const operationId = `${m}${openApiPath.replaceAll(/[^a-zA-Z0-9]+/g, "-").replaceAll(/^-|-$/g, "")}` || `${m}-root`;
  const tags = tagForPath(openApiPath);

  paths[openApiPath] ??= {};
  // If two handlers share the same path+method (overlapping plugins), keep the first.
  if (paths[openApiPath]![m] !== undefined) continue;

  paths[openApiPath]![m] = {
    operationId,
    ...(tags.length > 0 ? { tags } : {}),
    summary: `${m.toUpperCase()} ${openApiPath}`,
    responses: {
      "200": {
        description: "Success",
        content: { "application/vnd.api+json": { schema: { type: "object" } } },
      },
      "401": { description: "Unauthorized" },
      "404": { description: "Not Found" },
    },
  };
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "Terrence API",
    description: "Machine-readable contract generated from the registered route table. Per-route request/response schemas are added incrementally.",
    version,
  },
  servers: [{ url: "/api/v2", description: "Terrence API v2" }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
  security: [{ bearerAuth: [] }],
};

const outPath = join(import.meta.dir, "../openapi.json");
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${Object.keys(paths).length} paths to ${outPath} (v${version})`);
process.exit(0);
