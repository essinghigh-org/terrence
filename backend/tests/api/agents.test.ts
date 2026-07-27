import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";

describe("TFE API v2 - Agent Pools & Agents", () => {
  let userToken: string;
  const orgName = `agent-org-${crypto.randomUUID()}`;
  let poolId: string;
  let agentId: string;

  beforeAll(async () => {
    // Register user & login
    const username = `agentuser_${crypto.randomUUID().slice(0, 8)}`;
    await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username, password: "Password123!" } },
        }),
      })
    );

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username, password: "Password123!" } },
        }),
      })
    );
    const loginData = await loginRes.json();
    userToken = loginData.data.attributes.token;

    // Create organization
    await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: { attributes: { name: orgName } },
        }),
      })
    );
  });

  test("should create an agent pool", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/agent-pools`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              name: "homelab-agents",
              "organization-scoped": true,
            },
          },
        }),
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.attributes.name).toBe("homelab-agents");
    expect(body.data.attributes["agent-count"]).toBe(0);
    poolId = body.data.id;
  });

  test("should register/create an agent in pool", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${poolId}/agents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              name: "worker-node-1",
              status: "idle",
              "ip-address": "192.168.1.50",
              version: "1.4.0",
              architecture: "linux-amd64",
            },
          },
        }),
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.attributes.name).toBe("worker-node-1");
    expect(body.data.attributes.status).toBe("idle");
    expect(body.data.attributes["ip-address"]).toBe("192.168.1.50");
    agentId = body.data.id;
  });

  test("should list agents in pool and reflect updated agent-count on pool", async () => {
    const listRes = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${poolId}/agents`, {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );

    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.length).toBe(1);
    expect(listBody.data[0].id).toBe(agentId);

    const poolRes = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${poolId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(poolRes.status).toBe(200);
    const poolBody = await poolRes.json();
    expect(poolBody.data.attributes["agent-count"]).toBe(1);
  });

  test("should fetch individual agent details", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/agents/${agentId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(agentId);
    expect(body.data.attributes.name).toBe("worker-node-1");
  });

  test("should delete agent and decrease agent-count", async () => {
    const delRes = await app.handle(
      new Request(`http://localhost/api/v2/agents/${agentId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(delRes.status).toBe(204);

    const fetchRes = await app.handle(
      new Request(`http://localhost/api/v2/agents/${agentId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(fetchRes.status).toBe(404);
  });
});
