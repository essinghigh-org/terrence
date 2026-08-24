import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";

describe("the reference format API v2 - Agent Pools & Agents", () => {
  let userToken: string;
  const orgName = `agent-org-${crypto.randomUUID()}`;
  let poolId: string;
  let agentId: string;
  let workspaceId: string;

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
          data: { type: "organizations", attributes: { name: orgName } },
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
    expect(body.data.relationships.workspaces.data).toEqual([]);
    expect(body.data.relationships["authentication-tokens"].links.related).toContain("/authentication-tokens");
    poolId = body.data.id;
  });

  test("agent pool exposes assigned workspace and related-resource relationships", async () => {
    const createWorkspace = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/workspaces`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "workspaces",
            attributes: {
              name: `agent-workspace-${crypto.randomUUID().slice(0, 8)}`,
              "execution-mode": "agent",
              "agent-pool-id": poolId,
            },
          },
        }),
      }),
    );
    expect(createWorkspace.status).toBe(201);
    workspaceId = (await createWorkspace.json()).data.id;

    const showPool = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${poolId}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(showPool.status).toBe(200);
    const pool = (await showPool.json()).data;
    expect(pool.relationships.workspaces.data).toContainEqual({
      id: workspaceId,
      type: "workspaces",
    });
    expect(pool.relationships.agents.links.related).toBe(`/api/v2/agent-pools/${poolId}/agents`);
    expect(pool.links.self).toBe(`/api/v2/agent-pools/${poolId}`);
  });

  test("team tokens require manage-agent-pools for pool mutations", async () => {
    const createTeam = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/teams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "teams",
            attributes: { name: `agent-managers-${crypto.randomUUID().slice(0, 8)}` },
          },
        }),
      }),
    );
    expect(createTeam.status).toBe(201);
    const teamId = (await createTeam.json()).data.id as string;
    const createToken = await app.handle(
      new Request(`http://localhost/api/v2/teams/${teamId}/authentication-tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({ data: { attributes: { description: "agent pool manager" } } }),
      }),
    );
    expect(createToken.status).toBe(201);
    const teamToken = (await createToken.json()).data.attributes.token as string;
    const poolPayload = JSON.stringify({
      data: { type: "agent-pools", attributes: { name: `scoped-${crypto.randomUUID().slice(0, 8)}` } },
    });

    const denied = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/agent-pools`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${teamToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: poolPayload,
      }),
    );
    expect(denied.status).toBe(404);

    const grant = await app.handle(
      new Request(`http://localhost/api/v2/teams/${teamId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "teams",
            attributes: { "organization-access": { "manage-agent-pools": true } },
          },
        }),
      }),
    );
    expect(grant.status).toBe(200);

    const allowed = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/agent-pools`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${teamToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: poolPayload,
      }),
    );
    expect(allowed.status).toBe(201);
    const teamPoolId = (await allowed.json()).data.id as string;
    const removed = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${teamPoolId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${teamToken}` },
      }),
    );
    expect(removed.status).toBe(204);
  });

  test("should register/create an agent in pool", async () => {
    const tokenResponse = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${poolId}/authentication-tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({ data: { attributes: { description: "worker registration" } } }),
      }),
    );
    expect(tokenResponse.status).toBe(201);
    const tokenData = (await tokenResponse.json()).data;

    const res = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${poolId}/agents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.attributes.token}`,
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
    // tfc-agent sends no iac-binaries: defaults to terraform-only.
    expect(body.data.attributes["iac-binaries"]).toEqual(["terraform"]);
    agentId = body.data.id;

    const tokensResponse = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${poolId}/authentication-tokens`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    const usedToken = (await tokensResponse.json()).data.find(
      (token: { id: string }): boolean => token.id === tokenData.id,
    );
    expect(usedToken.attributes["last-used-at"]).not.toBeNull();
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

  test("generic authentication-token endpoints support agent pool tokens", async () => {
    const createResponse = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${poolId}/authentication-tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({ data: { attributes: { description: "generic endpoint test" } } }),
      }),
    );
    expect(createResponse.status).toBe(201);
    const token = (await createResponse.json()).data;

    const showResponse = await app.handle(
      new Request(`http://localhost/api/v2/authentication-tokens/${token.id}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(showResponse.status).toBe(200);
    const shown = (await showResponse.json()).data;
    expect(shown.id).toBe(token.id);
    expect(shown.attributes.description).toBe("generic endpoint test");
    expect(shown.attributes.token).toBeUndefined();
    expect(shown.relationships["agent-pool"].data.id).toBe(poolId);

    const deleteResponse = await app.handle(
      new Request(`http://localhost/api/v2/authentication-tokens/${token.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(deleteResponse.status).toBe(204);

    const missingResponse = await app.handle(
      new Request(`http://localhost/api/v2/authentication-tokens/${token.id}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(missingResponse.status).toBe(404);
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

  test("agent registration accepts declared iac-binaries capabilities", async () => {
    const poolRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/agent-pools`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: { attributes: { name: `capability-pool-${crypto.randomUUID().slice(0, 8)}` } },
        }),
      })
    );
    expect(poolRes.status).toBe(201);
    const capabilityPoolId = (await poolRes.json()).data.id as string;

    const tokenRes = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${capabilityPoolId}/authentication-tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({ data: { attributes: { description: "capability registration" } } }),
      })
    );
    expect(tokenRes.status).toBe(201);
    const poolToken = (await tokenRes.json()).data.attributes.token as string;

    const register = async (attributes: Record<string, unknown>): Promise<Response> =>
      app.handle(
        new Request(`http://localhost/api/v2/agent-pools/${capabilityPoolId}/agents`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${poolToken}`,
            "Content-Type": "application/vnd.api+json",
          },
          body: JSON.stringify({ data: { attributes } }),
        })
      );

    const tofuAgent = await register({
      name: "tofu-node",
      "iac-binaries": ["tofu", "terraform"],
    });
    expect(tofuAgent.status).toBe(201);
    expect((await tofuAgent.json()).data.attributes["iac-binaries"]).toEqual(["tofu", "terraform"]);

    const tofuOnly = await register({
      name: "tofu-only",
      "iac-binaries": ["tofu"],
    });
    expect(tofuOnly.status).toBe(201);
    expect((await tofuOnly.json()).data.attributes["iac-binaries"]).toEqual(["tofu"]);

    // The stored capabilities are echoed on list and single-agent reads.
    const listRes = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${capabilityPoolId}/agents`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()).data as { id: string; attributes: Record<string, unknown> }[];
    expect(listed.map((a) => a.attributes["iac-binaries"])).toEqual(expect.arrayContaining([
      ["tofu", "terraform"],
      ["tofu"],
    ]));
    expect(listed.length).toBeGreaterThanOrEqual(2);
    const bothBinaryAgent = listed.find((a): boolean =>
      Array.isArray(a.attributes["iac-binaries"])
      && (a.attributes["iac-binaries"] as readonly string[]).includes("tofu")
      && (a.attributes["iac-binaries"] as readonly string[]).includes("terraform"));
    if (bothBinaryAgent === undefined) throw new Error("Expected a tofu+terraform agent to be listed");

    const showRes = await app.handle(
      new Request(`http://localhost/api/v2/agents/${bothBinaryAgent.id}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(showRes.status).toBe(200);
    expect((await showRes.json()).data.attributes["iac-binaries"]).toEqual(["tofu", "terraform"]);
  });

  test("agent registration rejects invalid iac-binaries", async () => {
    const poolRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/agent-pools`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: { attributes: { name: `invalid-pool-${crypto.randomUUID().slice(0, 8)}` } },
        }),
      })
    );
    expect(poolRes.status).toBe(201);
    const invalidPoolId = (await poolRes.json()).data.id as string;

    const tokenRes = await app.handle(
      new Request(`http://localhost/api/v2/agent-pools/${invalidPoolId}/authentication-tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({ data: { attributes: { description: "invalid registration" } } }),
      })
    );
    const poolToken = (await tokenRes.json()).data.attributes.token as string;

    const invalidPayloads: Record<string, unknown>[] = [
      { name: "bad-value", "iac-binaries": ["golang"] },
      { name: "mixed-bad", "iac-binaries": ["tofu", "golang"] },
      { name: "empty", "iac-binaries": [] },
      { name: "not-array", "iac-binaries": "tofu" },
    ];
    for (const attributes of invalidPayloads) {
      const res = await app.handle(
        new Request(`http://localhost/api/v2/agent-pools/${invalidPoolId}/agents`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${poolToken}`,
            "Content-Type": "application/vnd.api+json",
          },
          body: JSON.stringify({ data: { attributes } }),
        })
      );
      expect(res.status).toBe(422);
    }
  });
});
