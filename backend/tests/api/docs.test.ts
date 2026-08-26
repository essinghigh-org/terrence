import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import {
  cleanupSeed,
  jsonHeaders,
  persistSeed,
  seedOrg,
} from "./compat_contract_helpers";

// Bundled documentation endpoints (auth-gated, file-backed, additive).
describe("bundled documentation endpoints", () => {
  const seed = seedOrg("docs");
  const headers = jsonHeaders(seed.token);

  beforeAll(async () => {
    await persistSeed(seed);
  });

  afterAll(async () => {
    await cleanupSeed(seed);
  });

  it("requires authentication", async () => {
    const response = await app.handle(new Request("http://localhost/api/v2/docs"));
    expect(response.status).toBe(401);
    const detail = await app.handle(new Request("http://localhost/api/v2/docs/overview"));
    expect(detail.status).toBe(401);
  });

  it("lists the documentation index for authenticated users", async () => {
    const response = await app.handle(new Request("http://localhost/api/v2/docs", { headers }));
    expect(response.status).toBe(200);
    const body = await response.json() as { data?: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data ?? []).length).toBeGreaterThan(10);
    const overview = (body.data ?? []).find((entry): boolean =>
      (entry as { id?: string }).id === "overview");
    expect(overview).toBeDefined();
    const attributes = (overview as { attributes?: Record<string, unknown> }).attributes ?? {};
    expect(attributes.title).toBe("Overview");
    expect(attributes.category).toBe("Getting started");
    // The index must not carry the full markdown payloads.
    expect(attributes.markdown).toBeUndefined();
  });

  it("serves a document by slug with markdown content", async () => {
    const response = await app.handle(new Request("http://localhost/api/v2/docs/runs", { headers }));
    expect(response.status).toBe(200);
    const body = await response.json() as { data?: { attributes?: Record<string, unknown> } };
    const markdown = body.data?.attributes?.markdown;
    expect(typeof markdown).toBe("string");
    expect((markdown as string).length).toBeGreaterThan(500);
    // The doc must be the Terrence documentation, not a redirect to external docs.
    expect((markdown as string)).not.toContain("developer.hashicorp.com");
  });

  it("returns 404 for an unknown slug", async () => {
    const response = await app.handle(new Request("http://localhost/api/v2/docs/does-not-exist", { headers }));
    expect(response.status).toBe(404);
  });
});
