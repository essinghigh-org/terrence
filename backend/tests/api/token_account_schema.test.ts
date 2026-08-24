import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  users,
  workspaces,
  workspaceVariables,
} from "../../src/db/schema";

describe("account, token, and variable schema contracts", () => {
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const authTokenId = crypto.randomUUID();
  const expiredTokenId = crypto.randomUUID();
  const authToken = `user-${crypto.randomUUID()}`;
  const expiredToken = `user-${crypto.randomUUID()}`;
  const orgName = `tokens-${crypto.randomUUID()}`;

  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    token = authToken,
  ) => app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  }));

  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      username: `user-${crypto.randomUUID()}`,
      passwordHash: "unused",
    });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: crypto.randomUUID(),
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      name: "token-schema",
      orgId,
    });
    await db.insert(apiTokens).values([
      {
        id: authTokenId,
        token: authToken,
        userId,
        description: "test auth",
        createdAt: Date.now() - 10_000,
      },
      {
        id: expiredTokenId,
        token: expiredToken,
        userId,
        description: "expired",
        createdAt: Date.now() - 10_000,
        expiresAt: Date.now() - 1_000,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("updates account username and nullable email", async () => {
    const username = `renamed-${crypto.randomUUID()}`;
    const update = await request("/api/v2/account/update", "PATCH", {
      data: {
        type: "users",
        attributes: { username, email: "terraform@example.test" },
      },
    });
    expect(update.status).toBe(200);
    expect((await update.json()).data.attributes).toMatchObject({
      username,
      email: "terraform@example.test",
    });

    const clearEmail = await request("/api/v2/account/update", "PATCH", {
      data: { type: "users", attributes: { email: null } },
    });
    expect(clearEmail.status).toBe(200);
    expect((await clearEmail.json()).data.attributes.email).toBeNull();

    const stored = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(stored).toMatchObject({ username, email: null });

    const invalid = await request("/api/v2/account/update", "PATCH", {
      data: { type: "users", attributes: { username: "@@@" } },
    });
    expect(invalid.status).toBe(422);
  });

  it("persists a validated account theme", async () => {
    const theme = "catppuccin-mocha";
    const update = await request("/api/v2/account/update", "PATCH", {
      data: { type: "users", attributes: { theme } },
    });
    expect(update.status).toBe(200);
    expect((await update.json()).data.attributes.theme).toBe(theme);

    const invalid = await request("/api/v2/account/update", "PATCH", {
      data: { type: "users", attributes: { theme: "not a theme" } },
    });
    expect(invalid.status).toBe(422);

    for (const invalidTheme of ["", "Catppuccin-Mocha", "a".repeat(65)]) {
      const response = await request("/api/v2/account/update", "PATCH", {
        data: { type: "users", attributes: { theme: invalidTheme } },
      });
      expect(response.status).toBe(422);
    }

    const maxLengthTheme = "a".repeat(64);
    const maxLengthUpdate = await request("/api/v2/account/update", "PATCH", {
      data: { type: "users", attributes: { theme: maxLengthTheme } },
    });
    expect(maxLengthUpdate.status).toBe(200);

    const stored = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(stored?.theme).toBe(maxLengthTheme);
  });

  it("rejects expired tokens and tracks successful token use in milliseconds", async () => {
    // Previous tests in this suite already hit auth with the same token; the
    // 60s lastUsedAt throttle would suppress the DB write and make the
    // timestamp stale. Clear it so this measurement is deterministic.
    await db.update(apiTokens).set({ lastUsedAt: null }).where(eq(apiTokens.id, authTokenId));
    const before = Date.now() - 100;
    const valid = await request("/api/v2/account/details");
    expect(valid.status).toBe(200);

    let used = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, authTokenId) });
    for (let i = 0; i < 20 && !used?.lastUsedAt; i++) {
      await Bun.sleep(10);
      used = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, authTokenId) });
    }
    expect(used?.lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(used?.lastUsedAt).toBeLessThanOrEqual(Date.now());

    const expired = await request("/api/v2/account/details", "GET", undefined, expiredToken);
    expect(expired.status).toBe(401);
    const unchanged = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, expiredTokenId) });
    expect(unchanged?.lastUsedAt).toBeNull();
  });

  it("creates, lists, shows, and revokes user token metadata without leaking secrets", async () => {
    const expiredAt = "2030-05-06T12:34:56.789Z";
    const created = await request("/api/v2/tokens", "POST", {
      data: {
        type: "authentication-tokens",
        attributes: { description: "automation", "expired-at": expiredAt },
      },
    });
    expect(created.status).toBe(201);
    const createdData = (await created.json()).data;
    expect(createdData.type).toBe("authentication-tokens");
    expect(createdData.attributes.token).toStartWith("user-");
    expect(createdData.attributes["expired-at"]).toBe(expiredAt);
    expect(new Date(createdData.attributes["created-at"]).toISOString()).toBe(createdData.attributes["created-at"]);

    const stored = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, createdData.id) });
    expect(stored).toMatchObject({
      userId,
      orgId: null,
      description: "automation",
      expiresAt: Date.parse(expiredAt),
    });

    const list = await request(`/api/v2/users/${userId}/authentication-tokens`);
    expect(list.status).toBe(200);
    const listed = (await list.json()).data.find((item: any) => item.id === createdData.id);
    expect(listed.attributes.token).toBeNull();
    expect(listed.attributes["expired-at"]).toBe(expiredAt);

    const show = await request(`/api/v2/authentication-tokens/${createdData.id}`);
    expect(show.status).toBe(200);
    expect((await show.json()).data.attributes.token).toBeNull();

    expect((await request(`/api/v2/authentication-tokens/${createdData.id}`, "DELETE")).status).toBe(204);
    expect(await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, createdData.id) })).toBeUndefined();
  });

  it("keeps exactly one true organization token across both creation endpoints", async () => {
    const first = await request(`/api/v2/organizations/${orgName}/authentication-token`, "POST", {
      data: { type: "authentication-token", attributes: {} },
    });
    expect(first.status).toBe(201);
    const firstData = (await first.json()).data;
    expect(firstData.attributes.token).toStartWith("org-");

    const metadata = await request(`/api/v2/organizations/${orgName}/authentication-token`);
    expect(metadata.status).toBe(200);
    expect((await metadata.json()).data.attributes.token).toBeNull();

    const replacement = await request(`/api/v2/organizations/${orgName}/authentication-token`, "POST", {
      data: { type: "authentication-token", attributes: {} },
    });
    expect(replacement.status).toBe(201);
    expect(await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, firstData.id) })).toBeUndefined();

    const generic = await request("/api/v2/tokens", "POST", {
      data: {
        type: "authentication-tokens",
        attributes: { description: "organization automation" },
        relationships: { organization: { data: { id: orgId, type: "organizations" } } },
      },
    });
    expect(generic.status).toBe(201);
    const genericData = (await generic.json()).data;
    const orgTokens = await db.query.apiTokens.findMany({ where: eq(apiTokens.orgId, orgId) });
    expect(orgTokens).toHaveLength(1);
    expect(orgTokens[0]).toMatchObject({ id: genericData.id, userId: null, orgId });

    const identity = await request("/api/v2/account/details", "GET", undefined, genericData.attributes.token);
    expect(identity.status).toBe(200);
    expect((await identity.json()).data.relationships["authenticated-resource"].data).toEqual({
      id: orgName,
      type: "organizations",
    });

    expect((await request(
      `/api/v2/organizations/${orgName}/authentication-token`,
      "DELETE",
      undefined,
      genericData.attributes.token,
    )).status).toBe(204);
    expect(await db.query.apiTokens.findFirst({ where: eq(apiTokens.orgId, orgId) })).toBeUndefined();
  });

  it("persists HCL mode when workspace variables are created, read, and updated", async () => {
    const invalid = await request(`/api/v2/workspaces/${workspaceId}/vars`, "POST", {
      data: {
        type: "vars",
        attributes: { key: "bad\ninjected", value: "true", hcl: true },
      },
    });
    expect(invalid.status).toBe(422);

    const created = await request(`/api/v2/workspaces/${workspaceId}/vars`, "POST", {
      data: {
        type: "vars",
        attributes: { key: "settings", value: "{ enabled = true }", category: "terraform", hcl: true },
      },
    });
    expect(created.status).toBe(201);
    const createdData = (await created.json()).data;
    expect(createdData.attributes.hcl).toBe(true);

    const show = await request(`/api/v2/workspaces/${workspaceId}/vars/${createdData.id}`);
    expect(show.status).toBe(200);
    expect((await show.json()).data.attributes.hcl).toBe(true);

    const list = await request(`/api/v2/workspaces/${workspaceId}/vars`);
    const listed = (await list.json()).data.find((item: any) => item.id === createdData.id);
    expect(listed.attributes.hcl).toBe(true);

    const updated = await request(`/api/v2/workspaces/${workspaceId}/vars/${createdData.id}`, "PATCH", {
      data: { type: "vars", attributes: { hcl: false } },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.attributes.hcl).toBe(false);

    const stored = await db.query.workspaceVariables.findFirst({
      where: eq(workspaceVariables.id, createdData.id),
    });
    expect(stored?.hcl).toBe(false);
  });
});
