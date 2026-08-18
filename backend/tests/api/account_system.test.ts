import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, systemApiTokens, users } from "../../src/db/schema";
import { hashSystemApiToken } from "../../src/lib/system-api";

describe("account and system compatibility", () => {
  const username = `account-${crypto.randomUUID()}`;
  const organizationName = `account-org-${crypto.randomUUID()}`;
  const password = "old-password";
  const systemToken = `tfe-system-${crypto.randomUUID()}`;
  let userId = "";
  let token = "";

  beforeAll(async () => {
    await db.insert(systemApiTokens).values({
      id: `system-api-token-${crypto.randomUUID()}`,
      tokenHash: hashSystemApiToken(systemToken),
      description: "account system compatibility test",
      expiresAt: Date.now() + 7_200_000,
    });
    const registration = await app.handle(new Request("http://localhost/api/v2/users", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "users", attributes: { username, password, email: "owner@example.test" } },
      }),
    }));
    expect(registration.status).toBe(201);
    const registered = (await registration.json()).data;
    expect(registered.attributes.email).toBe("owner@example.test");
    userId = registered.id;

    const login = await app.handle(new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { attributes: { username, password } } }),
    }));
    token = (await login.json()).data.attributes.token;

    const organization = await app.handle(new Request("http://localhost/api/v2/organizations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.api+json",
      },
      body: JSON.stringify({
        data: { type: "organizations", attributes: { name: organizationName } },
      }),
    }));
    expect(organization.status).toBe(201);
  });

  afterAll(async () => {
    const organization = await db.query.organizations.findFirst({
      where: eq(organizations.name, organizationName),
    });
    if (organization) {
      await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, organization.id));
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("rejects short registration passwords", async () => {
    const response = await app.handle(new Request("http://localhost/api/v2/users", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "users", attributes: { username: `${username}-short`, password: "too-short" } },
      }),
    }));
    expect(response.status).toBe(422);
  });

  it("returns the current Terraform account identity", async () => {
    const response = await app.handle(new Request("http://localhost/api/v2/account/details", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/vnd.api+json");
    expect(response.headers.get("access-control-allow-origin")).toBeDefined();
    expect(response.headers.get("x-ratelimit-limit")).toBeDefined();
    const body = await response.json();
    expect(body.data.id).toBe(userId);
    expect(body.data.attributes.username).toBe(username);
    expect(body.data.attributes.email).toBe("owner@example.test");
    expect(body.data.attributes.permissions["can-create-organizations"]).toBe(true);
    expect(body.data.relationships["authenticated-resource"].data).toEqual({ id: userId, type: "users" });
  });

  it("exposes authenticated system endpoints and public readiness probes", async () => {
    expect((await app.handle(new Request("http://localhost/api/v1/ping"))).status).toBe(401);

    const ping = await app.handle(new Request("http://localhost/api/v1/ping", {
      headers: { Authorization: `Bearer ${systemToken}` },
    }));
    expect(ping.status).toBe(200);
    expect(await ping.text()).toBe("pong");

    expect((await app.handle(new Request("http://localhost/healthz"))).status).toBe(200);
    expect((await app.handle(new Request("http://localhost/readyz"))).status).toBe(200);

    const preflight = await app.handle(new Request("http://localhost/api/v2/account/details", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
      },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("returns the organization's run and state entitlements", async () => {
    const response = await app.handle(new Request(
      `http://localhost/api/v2/organizations/${organizationName}/entitlement-set`,
      { headers: { Authorization: `Bearer ${token}` } },
    ));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.attributes.operations).toBe(true);
    expect(body.data.attributes["state-storage"]).toBe(true);
    // ORG-009: current the reference format entitlement keys with truthful OSS values.
    expect(body.data.attributes["configuration-designer"]).toBe(true);
    expect(body.data.attributes["module-tests-generation"]).toBe(true);
    expect(body.data.attributes["usage-reporting"]).toBe(true);
    expect(body.data.attributes["run-task-limit"]).toBeNull();
    expect(body.data.attributes["policy-set-limit"]).toBeNull();
    expect(body.data.attributes["user-limit"]).toBeNull();
  });

  it("changes the local account password", async () => {
    const nextPassword = "new-password";
    const response = await app.handle(new Request("http://localhost/api/v2/account/password", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.api+json",
      },
      body: JSON.stringify({
        data: {
          type: "users",
          attributes: {
            current_password: password,
            password: nextPassword,
            password_confirmation: nextPassword,
          },
        },
      }),
    }));
    expect(response.status).toBe(200);

    const login = await app.handle(new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { attributes: { username, password: nextPassword } } }),
    }));
    expect(login.status).toBe(200);
  });
});
