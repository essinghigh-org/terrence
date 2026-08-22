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

  it("covers every registered API route", async () => {
    const { app: liveApp } = await import("../../src/app");
    type Route = Readonly<{ method: string; path: string }>;
    const routes = (liveApp as unknown as { routes: Route[] }).routes;
    const apiRoutes = routes.filter(
      (r) =>
        r.path.startsWith("/api/") ||
        r.path.startsWith("/oauth/") ||
        r.path.startsWith("/admin/"),
    );
    const missing: string[] = [];
    for (const route of apiRoutes) {
      const m = route.method.toLowerCase();
      if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
      const pathEntry = paths[route.path];
      if (pathEntry === undefined || pathEntry[m] === undefined) {
        missing.push(`${route.method} ${route.path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("matches the checked-in artifact", () => {
    const artifact = JSON.parse(readFileSync(join(import.meta.dir, "../../openapi.json"), "utf8")) as Record<string, unknown>;
    expect(spec.openapi).toBe(artifact.openapi);
    expect(Object.keys(paths).length).toBe(Object.keys(artifact.paths as object).length);
  });

  it("has no frontend catch-alls in the contract", () => {
    expect(paths["/*"]).toBeUndefined();
    expect(paths["*"]).toBeUndefined();
    expect(paths["/"]).toBeUndefined();
  });
});
