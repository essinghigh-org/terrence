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

const { app, systemApiApp, handleAppError } = await import("../src/app");
const { systemAuthError } = await import("../src/lib/system-api");

// Collect every registered route from both listeners. The public application
// owns the shared contract for overlapping paths; system-only routes are
// included without mounting them on the public listener.
type Route = Readonly<{
  method: string;
  path: string;
  handler?: unknown;
  hooks?: unknown;
  listener: "application" | "system";
}>;
const routes = [
  ...(app as unknown as { routes: Omit<Route, "listener">[] }).routes.map((route) => ({ ...route, listener: "application" as const })),
  ...(systemApiApp as unknown as { routes: Omit<Route, "listener">[] }).routes.map((route) => ({ ...route, listener: "system" as const })),
];

const statusDescriptions: Readonly<Record<number, string>> = {
  200: "Success",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

const statusCodePattern = /\b([1-5]\d{2})\b/g;

function addStatusCodes(target: Set<number>, source: string): void {
  for (const match of source.matchAll(statusCodePattern)) {
    const status = Number(match[1]);
    if (statusDescriptions[status] !== undefined) target.add(status);
  }
}

function collectFunctionSources(value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || value === undefined || seen.has(value)) return [];
  if (typeof value === "function") return [Function.prototype.toString.call(value)];
  if (typeof value !== "object") return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => collectFunctionSources(item, seen));
  return Object.values(value).flatMap((item) => collectFunctionSources(item, seen));
}

/**
 * Infer codes from the executable route and hook functions rather than
 * assigning the same fabricated 200/401/404 response set to every operation.
 * Elysia composes handlers into functions, so this intentionally recognizes
 * the status mutations and response/helper calls that survive composition.
 */
function responseStatusCodes(source: string): Set<number> {
  const statuses = new Set<number>();
  const add = (fragment: string): void => { addStatusCodes(statuses, fragment); };

  // `===` must not be mistaken for an assignment. The negative lookahead is
  // important because composed hooks contain comparisons such as
  // `set.status === "number"`.
  for (const match of source.matchAll(/\b(?:set|mutableSet|context\.set)\.status\s*=(?!=)\s*([^;\n}]*)/g)) {
    add(match[1]);
  }
  // Capture literal response/status object fields, including conditional
  // expressions such as `status: hasErrors ? 503 : 200`, without treating
  // unrelated numeric values elsewhere in the object as HTTP codes.
  for (const match of source.matchAll(/(?:\bstatus\b|["']status["'])\s*:\s*([^,\n}]*)/g)) {
    add(match[1]);
  }
  // A few handlers return shared helpers whose implementation is outside the
  // composed function. Capture explicit numeric helper arguments and infer
  // the fixed-code helpers from their names.
  for (const match of source.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:Error|Response|error))\(([^)]*)\)/g)) {
    add(match[2]);
  }
  for (const match of source.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\(\s*set\b[^)]*/g)) {
    const helper = match[1];
    if (/(?:notFound|NotFound|hidden|denied|providerIconNotFound)/.test(helper)) statuses.add(404);
    if (/(?:unauthorized|Unauthorized|webhookUnauthorized|refreshUnauthorized)/.test(helper)) statuses.add(401);
    if (/(?:unprocessable|Unprocessable|invalid[^\s(]*Input|loggingSettingError)/.test(helper)) statuses.add(422);
    if (/(?:conflict|Conflict|fencing)/.test(helper)) statuses.add(409);
  }
  // App-level validation/parse handling is not inlined into each route
  // handler, but it is part of the executable contract for API routes.
  for (const match of source.matchAll(/\b(?:clientStatus|statusCode|httpStatus)\s*=(?!=)\s*([^;\n}]*)/g)) {
    add(match[1]);
  }
  return statuses;
}

function hasImplicitSuccessReturn(source: string): boolean {
  // The compiled handler contains nested transaction/map callbacks. Their
  // `return` values are not HTTP responses, so ignore returns in nested arrow
  // or function scopes while retaining returns in route-level conditionals.
  let functionDepth = 0;

  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const functionBraces: boolean[] = [];
  const routeReturns: { index: number; expression: string }[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (character === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "{") {
      const prefix = source.slice(Math.max(0, index - 8), index).replaceAll(/\s/g, "");
      const isNestedFunction = prefix.endsWith("=>") || /function(?:[A-Za-z_$][A-Za-z0-9_$]*)?\([^)]*\)$/.test(source.slice(Math.max(0, index - 100), index).replaceAll(/\s/g, ""));
      functionBraces.push(isNestedFunction);
      if (isNestedFunction) functionDepth += 1;
      continue;
    }
    if (character === "}") {
      if (functionBraces.pop() === true) functionDepth -= 1;
      continue;
    }
    if (functionDepth !== 1 || !source.startsWith("return", index)) continue;
    const previous = index === 0 ? "" : source[index - 1] ?? "";
    if (/[A-Za-z0-9_$.]/.test(previous) || /[A-Za-z0-9_$]/.test(source[index + 6] ?? "")) continue;
    const remainder = source.slice(index + 6).trim();
    const expression = remainder.startsWith("{")
      ? "object"
      : remainder.startsWith(";") || remainder.startsWith("}")
        ? ""
        : remainder.split(/[;}\n]/, 1)[0]?.trim() ?? "";
    routeReturns.push({ index, expression });
    index += 5;
  }

  return routeReturns.some(({ index, expression }) => {
    if (expression === "" || /^(?:new\s+Response\b)/.test(expression)) return false;
    if (/\b[A-Za-z_$][A-Za-z0-9_$]*(?:Error|error|NotFound|Unauthorized|Conflict|unprocessable|hidden|denied|fencing)\s*\([^)]*\bset\b/.test(expression)) return false;
    const prefix = source.slice(Math.max(0, index - 180), index);
    if (/\b(?:set|mutableSet|context\.set)\.status\s*=(?!=)[^;\n}]*;\s*$/.test(prefix)) return false;
    return true;
  });
}

const appErrorStatusCodes = responseStatusCodes(String(handleAppError));
const systemAuthStatusCodes = responseStatusCodes(String(systemAuthError));

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

// Build a minimal valid OAS 3.1 document. Response keys come from the
// executable route/handler and app-level hook code; per-route schemas can be
// added incrementally while the generated contract remains tied to routing.
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
  const handlerSource = typeof route.handler === "function" ? Function.prototype.toString.call(route.handler) : "";
  const hookSource = collectFunctionSources(route.hooks).join("\n");
  const responseStatuses = responseStatusCodes(handlerSource);
  for (const status of responseStatusCodes(hookSource)) {
    // A composed hook can contain the default 200 fallback used while
    // serializing a response. It is not a route declaration, unlike all
    // non-200 codes found in the hook.
    if (status === 304 && m !== "get") continue;
    if (status !== 200) responseStatuses.add(status);
  }
  if (route.listener === "system") {
    for (const status of systemAuthStatusCodes) responseStatuses.add(status);
  }
  const isApiPath = openApiPath === "/api" || openApiPath.startsWith("/api/");
  if (isApiPath) {
    for (const status of appErrorStatusCodes) {
      if (status >= 400) responseStatuses.add(status);
    }
  }
  const isPlanArtifact = m === "get" && /^\/api\/v2\/(plans\/\{[^}]+\}|runs\/\{[^}]+\}\/plan)\/(json-output|json-output-redacted|sanitized-plan)$/.test(openApiPath);
  if (hasImplicitSuccessReturn(handlerSource) || isPlanArtifact || ![...responseStatuses].some((status) => status >= 200 && status < 300)) {
    responseStatuses.add(200);
  }
  // The shared artifact responder is called from the handler and therefore
  // does not appear in its composed source. Keep its executable 204 branch in
  // the generated contract alongside the inferred 200/404 codes.
  if (isPlanArtifact) responseStatuses.add(204);
  const responseCodes = [...responseStatuses].sort((left, right) => left - right);

  paths[openApiPath] ??= {};
  // If two handlers share the same path+method (overlapping plugins), keep the first.
  if (paths[openApiPath][m] !== undefined) continue;

  const responses: Record<string, unknown> = Object.fromEntries(responseCodes.map((status) => [
    String(status), {
      description: statusDescriptions[status] ?? `HTTP ${String(status)}`,
      ...(status >= 200 && status < 300 && status !== 204
        ? { content: { "application/vnd.api+json": { schema: { type: "object" } } } }
        : {}),
    },
  ]));
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
    responses,
  };
  if (m === "get" && openApiPath === "/api/v2/provider-icons/{hostname}/{namespace}/{name}") {
    const providerIconResponse = responses["200"] as Record<string, unknown> | undefined;
    if (providerIconResponse !== undefined) {
      providerIconResponse.description = "Provider icon image";
      providerIconResponse.content = Object.fromEntries([
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/webp",
      ].map((mediaType) => [mediaType, { schema: { type: "string", format: "binary" } }]));
    }
  }
  // Plan artifacts are ordinary JSON documents (terraform show sends
  // Accept: application/json), not JSON:API resources: they answer 200 with
  // application/json and 204 while the plan is still running.
  if (isPlanArtifact) {
    const planResponse = responses["200"] as Record<string, unknown> | undefined;
    if (planResponse !== undefined) {
      planResponse.content = {
        "application/json": { schema: { type: "object" } },
      };
    }
    const pendingResponse = responses["204"] as Record<string, unknown> | undefined;
    if (pendingResponse !== undefined) pendingResponse.description = "Plan accepted but not completed yet";
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
