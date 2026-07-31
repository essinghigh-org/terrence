import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cleanupSeed, expectErrorResponse, jsonHeaders, persistSeed, request, seedTfeOrg } from "./tfe_contract_helpers";

describe("TFE API global conventions", () => {
  const seed = seedTfeOrg("conv");
  const headers = jsonHeaders(seed.token);

  beforeAll(async () => {
    await persistSeed(seed);
  });

  afterAll(async () => {
    await cleanupSeed(seed);
  });

  it("requires authentication for ping and returns pong when authenticated", async () => {
    const unauthenticated = await request("/api/v1/ping");
    expect(unauthenticated.status).toBe(401);
    await expectErrorResponse(await request("/api/v1/ping", { headers: jsonHeaders("bad-token") }), 401);
    const authenticated = await request("/api/v1/ping", { headers });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toBe("pong");
  });

  it("reports Terraform Enterprise version headers", async () => {
    const response = await request("/api/v2/ping", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("TFP-API-Version")).toBe("2.5");
    expect(response.headers.get("TFP-AppName")).toBe("Terraform Enterprise");
  });

  it("serves the terraform discovery document", async () => {
    const response = await request("/.well-known/terraform.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const discovery = await response.json();
    expect(discovery["tfe.v2"]).toBe("/api/v2/");
    expect(discovery["tfe.v2.1"]).toBe("/api/v2/");
    expect(discovery["state.v2"]).toBe("/api/v2/");
    expect(discovery["modules.v1"]).toBe("/api/registry/v1/modules/");
    expect(discovery["providers.v1"]).toBe("/api/registry/v1/providers/");
    expect(discovery["login.v1"]).toBeTypeOf("object");
  });

  it("rejects unauthenticated requests with a 401 error document", async () => {
    await expectErrorResponse(await request("/api/v2/organizations", { headers: jsonHeaders("bad-token") }), 401);
  });

  it("returns 404 error documents for unknown API routes", async () => {
    await expectErrorResponse(await request("/api/v2/definitely-not-a-route", { headers }), 404);
    await expectErrorResponse(await request("/api", { method: "POST", headers, body: "{}" }), 404);
    await expectErrorResponse(await request("/api/v2", { headers }), 404);
  });

  it("returns 404 error documents for unknown resources", async () => {
    await expectErrorResponse(await request("/api/v2/workspaces/ws-does-not-exist", { headers }), 404);
    await expectErrorResponse(await request(`/api/v2/organizations/${seed.orgName}/workspaces/does-not-exist`, { headers }), 404);
    await expectErrorResponse(await request("/api/v2/runs/run-does-not-exist", { headers }), 404);
    await expectErrorResponse(await request("/api/v2/teams/team-does-not-exist", { headers }), 404);
    await expectErrorResponse(await request("/api/v2/projects/prj-does-not-exist", { headers }), 404);
    await expectErrorResponse(await request("/api/v2/state-versions/sv-does-not-exist", { headers }), 404);
  });

  it("returns 404 error documents for unknown organizations", async () => {
    await expectErrorResponse(await request("/api/v2/organizations/no-such-org", { headers }), 404);
    await expectErrorResponse(await request("/api/v2/organizations/no-such-org/workspaces", { headers }), 404);
    await expectErrorResponse(await request("/api/v2/organizations/no-such-org/teams", { headers }), 404);
  });

  it("rejects invalid JSON payloads with a 4xx error document", async () => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/workspaces`, {
      method: "POST",
      headers,
      body: "this is not json",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("content-type")).toContain("application/vnd.api+json");
  });

  it("supports CORS preflight requests", async () => {
    const response = await request("/api/v2/organizations", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});
