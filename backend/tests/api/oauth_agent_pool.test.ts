import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  agentPools,
  apiTokens,
  oauthClients,
  organizationMemberships,
  organizations,
  users,
} from "../../src/db/schema";

describe("OAuth client agent-pool relationship", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-oauth-pool-${suffix}`;
  const orgId = `org-oauth-pool-${suffix}`;
  const orgName = `oauth-pool-${suffix}`;
  const otherOrgId = `org-oauth-pool-other-${suffix}`;
  const token = `oauth-pool-token-${suffix}`;
  const firstPoolId = `apool-oauth-first-${suffix}`;
  const secondPoolId = `apool-oauth-second-${suffix}`;
  const otherPoolId = `apool-oauth-other-${suffix}`;
  let clientId = "";

  const request = (method: string, path: string, body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.api+json",
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: otherOrgId, name: `other-${orgName}` },
    ]);
    await db.insert(organizationMemberships).values({
      id: `orgmem-oauth-pool-${suffix}`,
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({
      id: `api-oauth-pool-${suffix}`,
      token: createHash("sha256").update(token).digest("hex"),
      userId,
    });
    await db.insert(agentPools).values([
      { id: firstPoolId, orgId, name: "Private VCS pool" },
      { id: secondPoolId, orgId, name: "Replacement pool" },
      { id: otherPoolId, orgId: otherOrgId, name: "Other organization pool" },
    ]);
  });

  afterAll(async () => {
    await db.delete(oauthClients).where(eq(oauthClients.orgId, orgId));
    await db.delete(agentPools).where(eq(agentPools.orgId, orgId));
    await db.delete(agentPools).where(eq(agentPools.orgId, otherOrgId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("creates, returns, replaces, and clears an organization-scoped agent pool", async () => {
    const createdResponse = await request("POST", `/api/v2/organizations/${orgName}/oauth-clients`, {
      data: {
        type: "oauth-clients",
        attributes: { name: "Private GitLab", "service-provider": "gitlab_ee" },
        relationships: {
          "agent-pool": { data: { id: firstPoolId, type: "agent-pools" } },
        },
      },
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    clientId = created.data.id;
    expect(created.data.relationships["agent-pool"]).toEqual({
      data: { id: firstPoolId, type: "agent-pools" },
      links: { related: `/api/v2/agent-pools/${firstPoolId}` },
    });
    expect((await db.query.oauthClients.findFirst({
      where: eq(oauthClients.id, clientId),
    }))?.agentPoolId).toBe(firstPoolId);

    const replaced = await request("PATCH", `/api/v2/oauth-clients/${clientId}`, {
      data: {
        type: "oauth-clients",
        id: clientId,
        relationships: {
          "agent-pool": { data: { id: secondPoolId, type: "agent-pools" } },
        },
      },
    });
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).data.relationships["agent-pool"].data.id).toBe(secondPoolId);

    const cleared = await request("PATCH", `/api/v2/oauth-clients/${clientId}`, {
      data: {
        type: "oauth-clients",
        id: clientId,
        relationships: { "agent-pool": { data: null } },
      },
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.relationships["agent-pool"]).toEqual({ data: null, links: {} });
    expect((await db.query.oauthClients.findFirst({
      where: eq(oauthClients.id, clientId),
    }))?.agentPoolId).toBeNull();
  });

  test("rejects malformed and cross-organization agent-pool references without partial updates", async () => {
    const malformed = await request("POST", `/api/v2/organizations/${orgName}/oauth-clients`, {
      data: {
        type: "oauth-clients",
        attributes: { name: "Malformed relationship" },
        relationships: {
          "agent-pool": { data: { id: firstPoolId, type: "workspaces" } },
        },
      },
    });
    expect(malformed.status).toBe(422);

    const crossOrganization = await request("PATCH", `/api/v2/oauth-clients/${clientId}`, {
      data: {
        type: "oauth-clients",
        id: clientId,
        attributes: { name: "Must not be persisted" },
        relationships: {
          "agent-pool": { data: { id: otherPoolId, type: "agent-pools" } },
        },
      },
    });
    expect(crossOrganization.status).toBe(422);
    expect(await db.query.oauthClients.findFirst({
      where: eq(oauthClients.id, clientId),
    })).toMatchObject({ name: "Private GitLab", agentPoolId: null });
  });
});
