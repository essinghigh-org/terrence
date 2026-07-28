import { describe, expect, test } from "bun:test";
import { app } from "../../src/app";

describe("instance metrics", () => {
  test("serves JSON and Prometheus representations", async () => {
    const jsonResponse = await app.handle(new Request("http://localhost/metrics"));
    expect(jsonResponse.status).toBe(200);
    expect((await jsonResponse.json()).metrics).toMatchObject({
      terrence_users_total: expect.any(Number),
      terrence_organizations_total: expect.any(Number),
      terrence_workspaces_total: expect.any(Number),
      terrence_runs_total: expect.any(Number),
    });

    const prometheusResponse = await app.handle(
      new Request("http://localhost/metrics?format=prometheus"),
    );
    expect(prometheusResponse.status).toBe(200);
    expect(prometheusResponse.headers.get("content-type")).toContain("text/plain");
    const body = await prometheusResponse.text();
    expect(body).toContain("# TYPE terrence_runs_total gauge");
    expect(body).toMatch(/terrence_runs_total \d+/);
  });
});
