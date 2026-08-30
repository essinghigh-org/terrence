import { beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("openapi contract", () => {
  let spec: Record<string, unknown>;
  let paths: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    const res = await app.handle(new Request("http://terrence.test/openapi.json"));
    expect(res.status).toBe(200);
    spec = (await res.json()) as Record<string, unknown>;
    paths = spec.paths as Record<string, Record<string, unknown>>;
  });

  it("is valid OAS 3.1 with required top-level fields", () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect((spec.info as { title?: string }).title).toBeTruthy();
    expect((spec.info as { version?: string }).version).toBeTruthy();
    expect(spec.paths).toBeDefined();
    expect(typeof paths).toBe("object");
  });

  it("covers every registered route", () => {
    type Route = Readonly<{ method: string; path: string }>;
    const routes = (app as unknown as { routes: Route[] }).routes;
    const apiRoutes = routes.filter((r): boolean => {
      if (
        r.path === "/" ||
        r.path === "/login" ||
        r.path === "/register" ||
        r.path === "/app" ||
        r.path === "/app/*" ||
        r.path === "*" ||
        r.path === "/*" ||
        r.path === "/404.html" ||
        r.path === "/index.html" ||
        r.path === "" ||
        r.path === "/openapi.json" ||
        r.path.startsWith("/openapi")
      ) {
        return false;
      }
      const m = r.method.toLowerCase();
      if (!["get", "post", "put", "patch", "delete"].includes(m)) return false;
      return true;
    });
    const toOasPath = (p: string): string => p.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
    const missing: string[] = [];
    for (const route of apiRoutes) {
      const m = route.method.toLowerCase();
      const oasPath = toOasPath(route.path);
      const pathEntry = paths[oasPath];
      if (pathEntry?.[m] === undefined) {
        missing.push(`${route.method} ${route.path} -> ${oasPath}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("matches the checked-in artifact exactly", () => {
    const artifact = JSON.parse(readFileSync(join(import.meta.dir, "../../openapi.json"), "utf8")) as Record<string, unknown>;
    expect(spec).toEqual(artifact);
  });

  it("documents create-style bulk actions with their 201 response", () => {
    const operation = paths["/api/v2/organizations/{org_name}/explorer/bulk-actions"]?.post as {
      responses?: Record<string, unknown>;
    } | undefined;
    expect(operation?.responses?.["201"]).toBeDefined();
    expect(operation?.responses?.["200"]).toBeUndefined();
  });

  it("documents provider artwork as an image response", () => {
    const operation = paths["/api/v2/provider-icons/{namespace}/{name}"]?.get as {
      responses?: Record<string, { content?: Record<string, unknown> }>;
    } | undefined;
    expect(operation?.responses?.["200"]?.content?.["image/svg+xml"]).toEqual({
      schema: { type: "string", format: "binary" },
    });
    expect(operation?.responses?.["200"]?.content?.["application/vnd.api+json"]).toBeUndefined();
  });

  it("has no frontend catch-alls in the contract", () => {
    expect(paths["/*"]).toBeUndefined();
    expect(paths["*"]).toBeUndefined();
    expect(paths["/"]).toBeUndefined();
  });

  it("uses OAS templated paths and declares path parameters", () => {
    for (const [path, methods] of Object.entries(paths)) {
      expect(path.includes(":")).toBe(false);
      for (const op of Object.values(methods)) {
        const params = (op as { parameters?: { in: string }[] }).parameters;
        if (path.includes("{")) {
          expect(params?.some((p) => p.in === "path")).toBe(true);
        }
      }
    }
  });
});
