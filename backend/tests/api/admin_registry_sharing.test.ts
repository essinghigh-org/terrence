import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  registryModules,
  registryModuleVersions,
  registryPartnerships,
  registryProviderVersions,
  registryProviders,
  users,
} from "../../src/db/schema";

describe("Admin registry sharing", () => {
  const suffix = crypto.randomUUID();
  const adminId = `sharing-admin-${suffix}`;
  const consumerUserId = `sharing-consumer-${suffix}`;
  const outsiderUserId = `sharing-outsider-${suffix}`;
  const producerId = `org-producer-${suffix}`;
  const consumerId = `org-consumer-${suffix}`;
  const outsiderId = `org-outsider-${suffix}`;
  const producerName = `producer-${suffix}`;
  const consumerName = `consumer-${suffix}`;
  const outsiderName = `outsider-${suffix}`;
  const adminToken = `sharing-admin-token-${suffix}`;
  const consumerToken = `sharing-consumer-token-${suffix}`;
  const outsiderToken = `sharing-outsider-token-${suffix}`;
  const moduleId = `sharing-module-${suffix}`;
  const moduleVersionId = `sharing-module-version-${suffix}`;
  const providerId = `sharing-provider-${suffix}`;
  const providerVersionId = `sharing-provider-version-${suffix}`;

  const request = (path: string, token: string, method = "GET", body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: consumerUserId, username: consumerUserId, passwordHash: "unused" },
      { id: outsiderUserId, username: outsiderUserId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: producerId, name: producerName },
      { id: consumerId, name: consumerName },
      { id: outsiderId, name: outsiderName },
    ]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId: consumerUserId, orgId: consumerId, role: "owner" },
      { id: crypto.randomUUID(), userId: outsiderUserId, orgId: outsiderId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: createHash("sha256").update(adminToken).digest("hex"), userId: adminId },
      { id: crypto.randomUUID(), token: createHash("sha256").update(consumerToken).digest("hex"), userId: consumerUserId },
      { id: crypto.randomUUID(), token: createHash("sha256").update(outsiderToken).digest("hex"), userId: outsiderUserId },
    ]);
    await db.insert(registryModules).values({
      id: moduleId,
      orgId: producerId,
      namespace: producerName,
      name: "network",
      provider: "aws",
      createdAt: Date.now(),
    });
    await db.insert(registryModuleVersions).values({
      id: moduleVersionId,
      moduleId,
      version: "1.0.0",
      status: "ok",
      createdAt: Date.now(),
    });
    await db.insert(registryProviders).values({
      id: providerId,
      orgId: producerId,
      namespace: producerName,
      type: "custom",
      createdAt: Date.now(),
    });
    await db.insert(registryProviderVersions).values({
      id: providerVersionId,
      providerId,
      version: "1.0.0",
      createdAt: Date.now(),
    });
  });

  afterAll(async () => {
    await db.delete(registryPartnerships).where(eq(registryPartnerships.producerOrgId, producerId));
    await db.delete(registryProviderVersions).where(eq(registryProviderVersions.id, providerVersionId));
    await db.delete(registryProviders).where(eq(registryProviders.id, providerId));
    await db.delete(registryModuleVersions).where(eq(registryModuleVersions.id, moduleVersionId));
    await db.delete(registryModules).where(eq(registryModules.id, moduleId));
    await db.delete(apiTokens).where(inArray(apiTokens.userId, [adminId, consumerUserId, outsiderUserId]));
    await db.delete(organizationMemberships).where(inArray(organizationMemberships.orgId, [producerId, consumerId, outsiderId]));
    await db.delete(organizations).where(inArray(organizations.id, [producerId, consumerId, outsiderId]));
    await db.delete(users).where(inArray(users.id, [adminId, consumerUserId, outsiderUserId]));
  });

  it("creates, lists, enforces, and deletes explicit module sharing", async () => {
    expect((await request(`/api/v2/organizations/${producerName}/registry-modules`, outsiderToken)).status).toBe(404);
    expect((await request(`/api/registry/v1/modules/${producerName}/network/aws/versions`, outsiderToken)).status).toBe(404);

    const create = await request("/api/v2/admin/module-sharing", adminToken, "POST", {
      data: {
        type: "module-partnerships",
        attributes: {
          "producing-organization-id": producerId,
          "consuming-organization-id": consumerId,
        },
      },
    });
    expect(create.status).toBe(201);
    const sharingId = (await create.json()).data.id as string;
    expect((await request("/api/v2/admin/module-sharing", adminToken)).status).toBe(200);

    expect((await request(`/api/v2/organizations/${producerName}/registry-modules`, consumerToken)).status).toBe(200);
    expect((await request(`/api/v2/registry-modules/${moduleId}/versions`, consumerToken)).status).toBe(200);
    expect((await request(`/api/registry/v1/modules/${producerName}/network/aws/versions`, consumerToken)).status).toBe(200);
    expect((await request(`/api/v2/registry-modules/${moduleId}/versions`, outsiderToken)).status).toBe(404);

    expect((await request(`/api/v2/admin/module-sharing/${sharingId}`, adminToken, "DELETE")).status).toBe(204);
    expect((await request(`/api/v2/organizations/${producerName}/registry-modules`, consumerToken)).status).toBe(404);
  });

  it("updates canonical module/provider partnerships and global sharing", async () => {
    const update = await request(`/api/v2/admin/organizations/${producerName}/registry-partnerships`, adminToken, "PUT", {
      data: {
        type: "registry-partnerships",
        attributes: {
          module_consumers: [consumerName],
          provider_consumers: [consumerName],
        },
      },
    });
    expect(update.status).toBe(204);
    expect((await request(`/api/v2/admin/organizations/${producerName}/relationships/module-consumers`, adminToken)).status).toBe(200);
    expect((await request(`/api/v2/admin/organizations/${producerName}/relationships/provider-consumers`, adminToken)).status).toBe(200);
    expect((await request(`/api/v2/organizations/${producerName}/registry-providers`, consumerToken)).status).toBe(200);
    expect((await request(`/api/registry/v1/providers/${producerName}/custom/versions`, consumerToken)).status).toBe(200);

    const global = await request(`/api/v2/admin/organizations/${producerName}`, adminToken, "PATCH", {
      data: { type: "organizations", attributes: { "global-module-sharing": true } },
    });
    expect(global.status).toBe(200);
    expect((await global.json()).data.attributes["global-module-sharing"]).toBeTrue();
    expect((await request(`/api/v2/organizations/${producerName}/registry-modules`, outsiderToken)).status).toBe(200);
    const moduleConsumers = await request(`/api/v2/admin/organizations/${producerName}/relationships/module-consumers`, adminToken);
    expect((await moduleConsumers.json()).data).toEqual([]);
  });

  it("rejects malformed sharing payloads and non-admin callers", async () => {
    expect((await request("/api/v2/admin/module-sharing", consumerToken)).status).toBe(404);
    expect((await request("/api/v2/admin/module-sharing", adminToken, "POST", { data: {} })).status).toBe(422);
    expect((await request(`/api/v2/admin/organizations/${producerName}/registry-partnerships`, adminToken, "PUT", {
      data: { type: "registry-partnerships", attributes: { module_consumers: [producerName], provider_consumers: [] } },
    })).status).toBe(422);
  });
});
