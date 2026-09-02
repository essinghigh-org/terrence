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
  if (path.startsWith("/api/v2/")) {
    const seg = path.slice("/api/v2/".length).split("/")[0] ?? "misc";
    return [seg];
  }
  if (path.startsWith("/api/v1/")) return ["system"];
  if (path.startsWith("/api/")) return ["api"];
  if (path === "/openapi.json") return [];
  return [];
}

// Build a minimal valid OAS 3.1 document. Per-route schemas can be added
// incrementally; today every operation gets a generic JSON:API response stub
// so the contract is still machine-readable and testable against registration.
const paths: Record<string, Record<string, unknown>> = {};
const usedOperationIds = new Set<string>();

function uniqueOperationId(base: string): string {
  if (!usedOperationIds.has(base)) {
    usedOperationIds.add(base);
    return base;
  }
  let suffix = 2;
  while (usedOperationIds.has(`${base}-${String(suffix)}`)) suffix += 1;
  const id = `${base}-${String(suffix)}`;
  usedOperationIds.add(id);
  return id;
}

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
  // Keep only the verbs that are actually declared; drop auto-registered ones.
  const m = method.toLowerCase();
  if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
  // Skip internal plugin routes (openapi's own /openapi/json if present).
  if (path.startsWith("/openapi")) continue;

  // Convert Elysia :param syntax to OAS {param} and declare path parameters.
  const paramNames: string[] = [];
  const openApiPath = path.replaceAll(/:([A-Za-z0-9_]+)/g, (_m: string, name: string): string => {
    paramNames.push(name);
    return `{${name}}`;
  });
  const slug = openApiPath.replaceAll(/[^a-zA-Z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
  const operationId = uniqueOperationId(slug === "" ? `${m}-root` : `${m}-${slug}`);
  const tags = tagForPath(openApiPath);
  const successStatus = m === "post" && openApiPath === "/api/v2/organizations/{org_name}/explorer/bulk-actions"
    ? "201"
    : "200";

  paths[openApiPath] ??= {};
  // If two handlers share the same path+method (overlapping plugins), keep the first.
  if (paths[openApiPath][m] !== undefined) continue;

  const operation: Record<string, unknown> = {
    operationId,
    ...(tags.length > 0 ? { tags } : {}),
    ...(paramNames.length > 0
      ? {
          parameters: paramNames.map((name) => ({
            name,
            in: "path",
            required: true,
            schema: { type: "string" },
          })),
        }
      : {}),
    summary: `${m.toUpperCase()} ${openApiPath}`,
    responses: {
      [successStatus]: {
        description: "Success",
        content: { "application/vnd.api+json": { schema: { type: "object" } } },
      },
      "401": { description: "Unauthorized" },
      "404": { description: "Not Found" },
    },
  };
  if (m === "get" && openApiPath === "/api/v2/provider-icons/{hostname}/{namespace}/{name}") {
    operation.responses = {
      "200": {
        description: "Provider icon image",
        content: Object.fromEntries([
          "image/gif",
          "image/jpeg",
          "image/png",
          "image/svg+xml",
          "image/webp",
        ].map((mediaType) => [mediaType, { schema: { type: "string", format: "binary" } }])),
      },
      "401": { description: "Unauthorized" },
      "404": { description: "Not Found" },
    };
  }
  // Plan artifacts are ordinary JSON documents (terraform show sends
  // Accept: application/json), not JSON:API resources: they answer 200 with
  // application/json and 204 while the plan is still running.
  const isPlanArtifact = m === "get" && /^\/api\/v2\/(plans\/\{[^}]+\}|runs\/\{[^}]+\}\/plan)\/(json-output|json-output-redacted|sanitized-plan)$/.test(openApiPath);
  if (isPlanArtifact) {
    (operation.responses as Record<string, unknown>)["204"] = { description: "Plan accepted but not completed yet" };
    ((operation.responses as Record<string, Record<string, unknown>>)["200"] as Record<string, unknown>)["content"] = {
      "application/json": { schema: { type: "object" } },
    };
  }
  if (m === "patch" && openApiPath === "/api/v2/organization-memberships/{id}") {
    operation.requestBody = {
      required: true,
      content: {
        "application/vnd.api+json": {
          schema: {
            type: "object",
            required: ["data"],
            properties: {
              data: {
                type: "object",
                required: ["attributes"],
                properties: {
                  attributes: {
                    type: "object",
                    anyOf: [{ required: ["status"] }, { required: ["role"] }],
                    properties: {
                      status: { type: "string", enum: ["active", "invited"] },
                      role: { type: "string", enum: ["owner", "member"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const responses = operation.responses as Record<string, unknown>;
    delete responses["401"];
    responses["422"] = { description: "Unprocessable Entity" };
  }
  paths[openApiPath][m] = operation;
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
