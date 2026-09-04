import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  agentPoolTokens,
  agentPools,
  apiTokens,
  organizationMemberships,
  organizations,
  users,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

type JsonObject = Record<string, unknown>;

async function request(
  method: string,
  path: string,
  options: Readonly<{ body?: unknown; token?: string }> = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers["Authorization"] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/vnd.api+json";
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }));
}

async function responseJson(response: Response): Promise<JsonObject> {
  return await response.json() as JsonObject;
}

describe("agent pool token expiry and revocation", () => {
  const suffix = crypto.randomUUID();
  const userId = `agent-token-user-${suffix}`;
  const orgId = `agent-token-org-${suffix}`;
  const orgName = `agent-token-org-${suffix}`;
  const userToken = `agent-token-user-credential-${suffix}`;
  let poolId = "";

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: crypto.randomUUID(),
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({
      id: crypto.randomUUID(),
      token: hashAuthenticationToken(userToken),
      userId,
    });

    const response = await request("POST", `/api/v2/organizations/${orgName}/agent-pools`, {
      token: userToken,
      body: { data: { attributes: { name: `pool-${suffix}` } } },
    });
    expect(response.status).toBe(201);
    const body = await responseJson(response);
    poolId = ((body["data"] as JsonObject)["id"] as string);
  });

  afterAll(async () => {
    if (poolId !== "") await db.delete(agentPoolTokens).where(eq(agentPoolTokens.agentPoolId, poolId));
    await db.delete(agentPools).where(eq(agentPools.id, poolId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  const setPolicy = async (maxTtlMs?: number): Promise<void> => {
    const policies = maxTtlMs === undefined
      ? []
      : [{ "token-type": "agent", "max-ttl-ms": maxTtlMs }];
    const response = await request("PATCH", `/api/v2/organizations/${orgName}/token-ttl-policies`, {
      token: userToken,
      body: { data: { attributes: { "token-ttl-policies": policies } } },
    });
    expect(response.status).toBe(200);
  };

  const createToken = async (description: string, expiredAt?: string): Promise<{ id: string; token: string }> => {
    const response = await request("POST", `/api/v2/agent-pools/${poolId}/authentication-tokens`, {
      token: userToken,
      body: {
        data: {
          attributes: {
            description,
            ...(expiredAt === undefined ? {} : { "expired-at": expiredAt }),
          },
        },
      },
    });
    expect(response.status).toBe(201);
    const body = await responseJson(response);
    const data = body["data"] as JsonObject;
    const attributes = data["attributes"] as JsonObject;
    return { id: data["id"] as string, token: attributes["token"] as string };
  };

  const registerAgent = (token: string, name: string): Promise<Response> =>
    request("POST", "/api/agent/register", {
      token,
      body: { name },
    });

  it("assigns a default expiry and applies the agent TTL policy", async () => {
    await setPolicy();
    const defaultToken = await createToken(`default-${suffix}`);
    const defaultRow = await db.query.agentPoolTokens.findFirst({ where: eq(agentPoolTokens.id, defaultToken.id) });
    expect(defaultRow?.expiresAt).not.toBeNull();
    expect(defaultRow!.expiresAt! - Date.now()).toBeLessThanOrEqual(TWO_YEARS_MS);
    expect(defaultRow!.expiresAt!).toBeGreaterThan(Date.now());

    await setPolicy(60_000);
    try {
      const created = await createToken(`policy-${suffix}`, new Date(Date.now() + ONE_YEAR_MS).toISOString());
      const row = await db.query.agentPoolTokens.findFirst({ where: eq(agentPoolTokens.id, created.id) });
      expect(row).toBeDefined();
      expect(row?.expiresAt).not.toBeNull();
      expect(row!.expiresAt! - Date.now()).toBeLessThanOrEqual(60_000);
      expect(row!.expiresAt!).toBeGreaterThan(Date.now());

      const shown = await request("GET", `/api/v2/agent-pools/${poolId}/authentication-tokens`, { token: userToken });
      expect(shown.status).toBe(200);
      const tokens = (await responseJson(shown))["data"] as JsonObject[];
      const resource = tokens.find((candidate) => candidate["id"] === created.id);
      expect(resource).toBeDefined();
      expect((resource!["attributes"] as JsonObject)["expired-at"]).toBe(new Date(row!.expiresAt!).toISOString());
    } finally {
      await setPolicy();
    }
  });

  it("rejects agent token creation when the policy forbids it", async () => {
    await setPolicy(0);
    try {
      const before = await db.query.agentPoolTokens.findMany({ where: eq(agentPoolTokens.agentPoolId, poolId) });
      const response = await request("POST", `/api/v2/agent-pools/${poolId}/authentication-tokens`, {
        token: userToken,
        body: { data: { attributes: { description: `forbidden-${suffix}` } } },
      });
      expect(response.status).toBe(403);
      const after = await db.query.agentPoolTokens.findMany({ where: eq(agentPoolTokens.agentPoolId, poolId) });
      expect(after).toHaveLength(before.length);
    } finally {
      await setPolicy();
    }
  });

  it("rejects an expired token across pool registration and agent protocol authentication", async () => {
    const created = await createToken(`expired-${suffix}`, new Date(Date.now() + 120_000).toISOString());
    const registration = await registerAgent(created.token, `expired-agent-${suffix}`);
    expect(registration.status).toBe(200);
    const registered = await responseJson(registration);
    const agentId = registered["id"] as string;

    await db.update(agentPoolTokens).set({ expiresAt: Date.now() - 1 }).where(eq(agentPoolTokens.id, created.id));

    expect((await registerAgent(created.token, `expired-agent-${suffix}`)).status).toBe(401);
    const poll = await request("POST", `/api/v2/agents/${agentId}/jobs/poll`, { token: created.token });
    expect(poll.status).toBe(401);
    const poolRegistration = await request("POST", `/api/v2/agent-pools/${poolId}/agents`, {
      token: created.token,
      body: { data: { attributes: { name: `expired-v2-agent-${suffix}` } } },
    });
    expect(poolRegistration.status).toBe(404);
  });

  it("revokes the credential instead of deleting its audit row and rejects it", async () => {
    const created = await createToken(`revoked-${suffix}`);
    const registration = await registerAgent(created.token, `revoked-agent-${suffix}`);
    expect(registration.status).toBe(200);
    const registered = await responseJson(registration);
    const agentId = registered["id"] as string;

    const revoke = await request("DELETE", `/api/v2/authentication-tokens/${created.id}`, { token: userToken });
    expect(revoke.status).toBe(204);
    const row = await db.query.agentPoolTokens.findFirst({ where: eq(agentPoolTokens.id, created.id) });
    expect(row?.revokedAt).not.toBeNull();

    expect((await registerAgent(created.token, `revoked-agent-${suffix}`)).status).toBe(401);
    const poll = await request("POST", `/api/v2/agents/${agentId}/jobs/poll`, { token: created.token });
    expect(poll.status).toBe(401);
    const poolRegistration = await request("POST", `/api/v2/agent-pools/${poolId}/agents`, {
      token: created.token,
      body: { data: { attributes: { name: `revoked-v2-agent-${suffix}` } } },
    });
    expect(poolRegistration.status).toBe(404);

    const retained = await db.query.agentPoolTokens.findFirst({
      where: and(eq(agentPoolTokens.id, created.id), eq(agentPoolTokens.agentPoolId, poolId)),
    });
    expect(retained).toBeDefined();
  });
});
