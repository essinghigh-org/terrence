import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cleanupSeed, expectErrorResponse, jsonHeaders, persistSeed, request, seedOrg } from "./compat_contract_helpers";
import { TFP_API_VERSION } from "../../src/lib/constants";

describe("remote-workflow API global conventions", () => {
  const seed = seedOrg("conv");
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
    // /api/v1/ping is a System API endpoint: only a system token authenticates.
    // A normal application (user) token must NOT be accepted on the System API.
    const appToken = await request("/api/v1/ping", { headers });
    expect(appToken.status).toBe(404);
    const authenticated = await request("/api/v1/ping", { headers: jsonHeaders(seed.systemToken) });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toBe("pong");
  });

  it("reports the compatibility version headers", async () => {
    const response = await request("/api/v2/ping", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("TFP-API-Version")).toBe(TFP_API_VERSION);
    // TFP-AppName is intentionally omitted: its literal value is a vendor
    // trademark string and is not required by any run/registry flow.
    expect(response.headers.get("TFP-AppName")).toBeNull();
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

  it("negotiates JSON:API responses and validates request media types (API-005)", async () => {
    const unsupportedAccept = await request("/api/v2/organizations", {
      headers: { ...headers, Accept: "text/plain" },
    });
    expect(unsupportedAccept.status).toBe(406);
    expect(unsupportedAccept.headers.get("content-type")).toContain("application/vnd.api+json");
    const acceptBody = await unsupportedAccept.json() as { errors?: { status?: string; title?: string }[] };
    expect(acceptBody.errors?.[0]?.status).toBe("406");
    expect(acceptBody.errors?.[0]?.title).toBe("Not Acceptable");
    expect(unsupportedAccept.headers.get("vary")?.toLowerCase()).toContain("accept");

    const unsupportedContentType = await request(`/api/v2/organizations/${seed.orgName}/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { type: "workspaces", attributes: { name: "wrong-media-type" } } }),
    });
    expect(unsupportedContentType.status).toBe(415);
    expect(unsupportedContentType.headers.get("content-type")).toContain("application/vnd.api+json");
    const contentTypeBody = await unsupportedContentType.json() as { errors?: { status?: string; title?: string }[] };
    expect(contentTypeBody.errors?.[0]?.status).toBe("415");
    expect(contentTypeBody.errors?.[0]?.title).toBe("Unsupported Media Type");

    const unauthenticatedProtectedRequest = await request("/api/v2/workspace-transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthenticatedProtectedRequest.status).toBe(401);

    const publicLoginWithWrongMediaType = await request("/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(publicLoginWithWrongMediaType.status).toBe(415);

    const missingHeaders = new Headers(headers);
    missingHeaders.delete("Content-Type");
    const missingContentType = await request(`/api/v2/organizations/${seed.orgName}/workspaces`, {
      method: "POST",
      headers: missingHeaders,
      body: JSON.stringify({ data: { type: "workspaces", attributes: { name: "missing-media-type" } } }),
    });
    expect(missingContentType.status).toBe(415);

    const parameterizedContentType = await request(`/api/v2/organizations/${seed.orgName}/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/vnd.api+json; charset=utf-8" },
      body: JSON.stringify({ data: { type: "workspaces", attributes: { name: "parameterized-media-type" } } }),
    });
    expect(parameterizedContentType.status).toBe(415);

    const valid = await request(`/api/v2/organizations/${seed.orgName}/workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data: { type: "workspaces", attributes: { name: `valid-media-${seed.suffix}` } } }),
    });
    expect(valid.status).not.toBe(415);
  });

  it("shapes error documents consistently (API-006)", async () => {
    // Validation error: status + title + detail, JSON:API content type.
    const validation = await request(`/api/v2/organizations/${seed.orgName}/workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data: { type: "workspaces", attributes: {} } }),
    });
    expect(validation.status).toBe(422);
    expect(validation.headers.get("content-type")).toContain("application/vnd.api+json");
    const validationBody = await validation.json();
    expect(Array.isArray(validationBody.errors)).toBe(true);
    const validationError = validationBody.errors[0];
    expect(String(validationError.status)).toBe("422");
    expect(typeof validationError.title).toBe("string");
    expect(validationError.title.length).toBeGreaterThan(0);

    // 404 error document carries status + title + detail consistently.
    const notFound = await request(`/api/v2/organizations/${seed.orgName}/workspaces/ws-nope`, { headers });
    expect(notFound.status).toBe(404);
    const notFoundBody = await notFound.json();
    expect(Array.isArray(notFoundBody.errors)).toBe(true);
    const notFoundError = notFoundBody.errors[0];
    expect(String(notFoundError.status)).toBe("404");
    expect(notFoundError.title).toBeTypeOf("string");
  });
});
