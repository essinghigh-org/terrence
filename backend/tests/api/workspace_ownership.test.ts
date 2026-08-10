import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizations, workspaces, users, apiTokens, organizationMemberships } from "../../src/db/schema";

describe("workspace ownership metadata (kanban 16.12)", () => {
  let orgName = "";
  let token = "";
  let workspaceId = "";

  beforeAll(async () => {
    orgName = `owner-test-${Date.now()}`;
    await db.delete(organizationMemberships);
    await db.delete(apiTokens);
    await db.delete(users);
    await db.delete(workspaces);
    await db.delete(organizations);

    await app.handle(new Request("http://localhost/api/v2/users", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { type: "users", attributes: { username: "owner-test", password: "securepass" } } }),
    }));
    const login = await app.handle(new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { attributes: { username: "owner-test", password: "securepass" } } }),
    }));
    token = (await login.json()).data.attributes.token;

    const orgRes = await app.handle(new Request("http://localhost/api/v2/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ data: { type: "organizations", attributes: { name: orgName } } }),
    }));
    expect(orgRes.status).toBe(201);
  });

  afterAll(async () => {
    await db.delete(organizationMemberships);
    await db.delete(apiTokens);
    await db.delete(users);
    await db.delete(workspaces);
    await db.delete(organizations);
  });

  it("accepts ownership metadata at create and returns it", async () => {
    const res = await app.handle(new Request(`http://localhost/api/v2/organizations/${orgName}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        data: {
          type: "workspaces",
          attributes: {
            name: "owned-ws",
            "owned-by-type": "team",
            "owned-by-id": "team-platform",
            "contact-email": "platform@example.com",
          },
        },
      }),
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; attributes: Record<string, unknown> } };
    workspaceId = body.data.id;
    expect(body.data.attributes["owned-by-type"]).toBe("team");
    expect(body.data.attributes["owned-by-id"]).toBe("team-platform");
    expect(body.data.attributes["contact-email"]).toBe("platform@example.com");
  });

  it("rejects an invalid owned-by-type", async () => {
    const res = await app.handle(new Request(`http://localhost/api/v2/organizations/${orgName}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        data: { type: "workspaces", attributes: { name: "bad-owned", "owned-by-type": "squad" } },
      }),
    }));
    expect(res.status).toBe(422);
  });

  it("updates ownership metadata via PATCH", async () => {
    const res = await app.handle(new Request(`http://localhost/api/v2/workspaces/${workspaceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/vnd.api+json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        data: {
          type: "workspaces",
          attributes: { "owned-by-type": "user", "owned-by-id": "user-42", "contact-email": "alice@example.com" },
        },
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes["owned-by-type"]).toBe("user");
    expect(body.data.attributes["owned-by-id"]).toBe("user-42");
    expect(body.data.attributes["contact-email"]).toBe("alice@example.com");
  });

  it("clears ownership metadata when set to null", async () => {
    const res = await app.handle(new Request(`http://localhost/api/v2/workspaces/${workspaceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/vnd.api+json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        data: { type: "workspaces", attributes: { "owned-by-type": null, "contact-email": null } },
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes["owned-by-type"]).toBeNull();
    expect(body.data.attributes["contact-email"]).toBeNull();
  });
});