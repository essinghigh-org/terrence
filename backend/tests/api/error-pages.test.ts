import { describe, expect, it } from "bun:test";
import { app } from "../../src/app";

describe("server-level error pages", () => {
  const request = (method: string, path: string): Promise<Response> =>
    app.handle(new Request(`http://localhost${path}`, { method }));

  it("returns a branded 404 page for unknown top-level paths", async () => {
    const res = await request("GET", "/meow");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Page not found");
    expect(html).toContain('data-pose="lost"');
    expect(html).toContain('href="/app/docs"');
    expect(html).not.toContain('<script');
  });

  it("returns a branded 404 page for unknown methods on unknown paths", async () => {
    const res = await request("POST", "/meow");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Page not found");
  });

  it("returns a bare 404 for missing assets", async () => {
    const res = await request("GET", "/assets/not-a-real-hash.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("Not Found");
  });

  it("keeps JSON 404s for unknown API paths", async () => {
    const res = await request("GET", "/api/v2/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/vnd.api+json");
    const body = (await res.json()) as { errors: { title: string }[] };
    expect(body.errors[0]?.title).toBe("Not Found");
  });

  it("still serves the SPA shell for app routes", async () => {
    const res = await request("GET", "/app/workspaces/nope");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("does not treat lookalike paths as app routes", async () => {
    const res = await request("GET", "/application");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Page not found");
  });
});
