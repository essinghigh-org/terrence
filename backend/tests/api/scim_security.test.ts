import { afterAll, beforeAll, expect, test } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  identityLinks,
  scimGroupMemberships,
  scimGroups,
  scimSettings,
  scimTokens,
  scimUserIdentities,
  users,
} from "../../src/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { hashAuthenticationToken } from "../../src/lib/token-service";

const suffix = crypto.randomUUID();
const tokenId = `scim-security-token-${suffix}`;
const scimToken = `scim-security-${suffix}`;
const mixedUserId = `scim-mixed-user-${suffix}`;
const omittedActiveUserId = `scim-omitted-active-user-${suffix}`;
const directoryRows = Array.from({ length: 205 }, (_, index) => {
  const number = String(index).padStart(3, "0");
  return {
    userId: `scim-directory-user-${suffix}-${number}`,
    identityId: `scim-directory-identity-${suffix}-${number}`,
    username: `scim-directory-${suffix}-${number}`,
    email: `scim-directory-${suffix}-${number}@example.com`,
  };
});
const groupRows = Array.from({ length: 3 }, (_, index) => ({
  id: `scim-security-group-${suffix}-${index}`,
  name: `SCIM Security Group ${suffix} ${index}`,
}));
const allUserIds = [mixedUserId, omittedActiveUserId, ...directoryRows.map((row) => row.userId)];
const allGroupIds = groupRows.map((row) => row.id);
let previousScimSettings: typeof scimSettings.$inferSelect | undefined;

function request(method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${scimToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/scim+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

beforeAll(async () => {
  await db.delete(scimTokens).where(eq(scimTokens.description, "SCIM security regression tests"));
  previousScimSettings = await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") });
  const now = Date.now();
  await db.insert(scimSettings).values({
    id: "scim",
    enabled: true,
    paused: false,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: scimSettings.id,
    set: { enabled: true, paused: false, updatedAt: now },
  });
  await db.insert(scimTokens).values({
    id: tokenId,
    tokenHash: hashAuthenticationToken(scimToken),
    description: "SCIM security regression tests",
    createdAt: now,
    expiresAt: now + 86_400_000,
  });
  await db.insert(users).values([
    {
      id: mixedUserId,
      username: `scim-mixed-account-${suffix}`,
      email: `MiXeD-${suffix}@Example.COM`,
      passwordHash: "unused",
    },
    {
      id: omittedActiveUserId,
      username: `scim-omitted-active-account-${suffix}`,
      email: `scim-omitted-active-${suffix}@example.com`,
      passwordHash: "unused",
      isSuspended: true,
    },
    ...directoryRows.map((row) => ({
      id: row.userId,
      username: row.username,
      email: row.email,
      passwordHash: "unused",
    })),
  ]);
  await db.insert(scimUserIdentities).values([
    ...directoryRows.map((row) => ({
      id: row.identityId,
      userId: row.userId,
      username: row.username,
      externalId: `external-${row.userId}`,
      createdAt: now,
      updatedAt: now,
    })),
  ]);
  await db.insert(scimGroups).values(groupRows.map((group) => ({
    ...group,
    createdAt: now,
    updatedAt: now,
  })));
});

afterAll(async () => {
  await db.delete(scimGroupMemberships).where(inArray(scimGroupMemberships.groupId, allGroupIds));
  await db.delete(scimGroups).where(inArray(scimGroups.id, allGroupIds));
  await db.delete(identityLinks).where(inArray(identityLinks.userId, allUserIds));
  await db.delete(scimUserIdentities).where(inArray(scimUserIdentities.userId, allUserIds));
  await db.delete(scimTokens).where(eq(scimTokens.id, tokenId));
  await db.delete(users).where(inArray(users.id, allUserIds));
  if (previousScimSettings === undefined) {
    await db.delete(scimSettings).where(eq(scimSettings.id, "scim"));
  } else {
    await db.update(scimSettings).set({
      enabled: previousScimSettings.enabled,
      paused: previousScimSettings.paused,
      siteAdminGroupScimId: previousScimSettings.siteAdminGroupScimId,
      updatedAt: previousScimSettings.updatedAt,
    }).where(eq(scimSettings.id, previousScimSettings.id));
  }
});

test("reuses mixed-case email identities and applies string active values", async () => {
  const created = await request("POST", "/scim/v2/Users", {
    userName: `scim-managed-${suffix}`,
    emails: [{ value: `MIXED-${suffix}@EXAMPLE.com`, primary: true }],
    active: "False",
  });
  expect(created.status).toBe(201);
  const createdResource = await created.json();
  expect(createdResource.active).toBeFalse();
  expect(createdResource.id).toStartWith("scimuser-");

  const matchingUsers = await db.select().from(users).where(sql`lower(${users.email}) = lower(${`MiXeD-${suffix}@Example.COM`})`);
  expect(matchingUsers).toHaveLength(1);
  expect(matchingUsers[0]?.id).toBe(mixedUserId);
  expect(matchingUsers[0]?.isSuspended).toBeTrue();

  const identityId = createdResource.id as string;
  const reactivated = await request("PUT", `/scim/v2/Users/${identityId}`, {
    userName: `scim-managed-${suffix}`,
    emails: [{ value: `mixed-${suffix}@example.com`, primary: true }],
    active: "True",
  });
  expect(reactivated.status).toBe(200);
  expect((await reactivated.json()).active).toBeTrue();

  const patched = await request("PATCH", `/scim/v2/Users/${identityId}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "active", value: "False" }],
  });
  expect(patched.status).toBe(200);
  expect((await patched.json()).active).toBeFalse();
  expect((await db.query.users.findFirst({ where: eq(users.id, mixedUserId) }))?.isSuspended).toBeTrue();
});

test("preserves an existing suspension when create omits active", async () => {
  const created = await request("POST", "/scim/v2/Users", {
    userName: `scim-omitted-active-${suffix}`,
    emails: [{ value: `SCIM-OMITTED-ACTIVE-${suffix}@EXAMPLE.COM`, primary: true }],
  });
  expect(created.status).toBe(201);
  expect((await created.json()).active).toBeFalse();
  expect((await db.query.users.findFirst({ where: eq(users.id, omittedActiveUserId) }))?.isSuspended).toBeTrue();
});

test("filters SCIM lists and enforces bounded startIndex/count pagination", async () => {
  const target = directoryRows[42];
  if (target === undefined) throw new Error("directory fixture is incomplete");
  const filter = encodeURIComponent(`userName eq "${target.username}"`);
  const filtered = await request("GET", `/scim/v2/Users?filter=${filter}&startIndex=1&count=10`);
  expect(filtered.status).toBe(200);
  const filteredBody = await filtered.json();
  expect(filteredBody.totalResults).toBe(1);
  expect(filteredBody.startIndex).toBe(1);
  expect(filteredBody.itemsPerPage).toBe(1);
  expect(filteredBody.Resources).toHaveLength(1);
  expect(filteredBody.Resources[0].userName).toBe(target.username);

  const invalidFilter = await request(
    "GET",
    `/scim/v2/Users?filter=${encodeURIComponent(`userName ne "${target.username}"`)}`,
  );
  expect(invalidFilter.status).toBe(400);
  expect((await invalidFilter.json()).status).toBe("400");

  const page = await request("GET", "/scim/v2/Users?startIndex=2&count=2");
  expect(page.status).toBe(200);
  const pageBody = await page.json();
  expect(pageBody.totalResults).toBeGreaterThanOrEqual(205);
  expect(pageBody.startIndex).toBe(2);
  expect(pageBody.itemsPerPage).toBe(2);
  expect(pageBody.Resources).toHaveLength(2);

  const capped = await request("GET", "/scim/v2/Users?count=10000");
  expect(capped.status).toBe(200);
  const cappedBody = await capped.json();
  expect(cappedBody.totalResults).toBeGreaterThanOrEqual(205);
  expect(cappedBody.itemsPerPage).toBe(200);
  expect(cappedBody.Resources).toHaveLength(200);

  const groupTarget = groupRows[1];
  if (groupTarget === undefined) throw new Error("group fixture is incomplete");
  const filteredGroups = await request(
    "GET",
    `/scim/v2/Groups?filter=${encodeURIComponent(`displayName eq "${groupTarget.name}"`)}&startIndex=1&count=1`,
  );
  expect(filteredGroups.status).toBe(200);
  const filteredGroupsBody = await filteredGroups.json();
  expect(filteredGroupsBody.totalResults).toBe(1);
  expect(filteredGroupsBody.itemsPerPage).toBe(1);
  expect(filteredGroupsBody.Resources[0].displayName).toBe(groupTarget.name);

  const groupPage = await request("GET", "/scim/v2/Groups?startIndex=2&count=1");
  expect(groupPage.status).toBe(200);
  const groupPageBody = await groupPage.json();
  expect(groupPageBody.totalResults).toBeGreaterThanOrEqual(3);
  expect(groupPageBody.startIndex).toBe(2);
  expect(groupPageBody.itemsPerPage).toBe(1);
  expect(groupPageBody.Resources).toHaveLength(1);
});
