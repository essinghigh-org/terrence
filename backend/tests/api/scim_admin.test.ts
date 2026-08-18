import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  samlSettings,
  scimGroupMemberships,
  scimGroups,
  scimSettings,
  scimTokens,
  scimUserIdentities,
  teamMemberships,
  teamScimGroupMappings,
  teams,
  users,
} from "../../src/db/schema";

const DAY_MS = 86_400_000;
const suffix = crypto.randomUUID();
const adminId = `usr-scim-admin-${suffix}`;
const ownerId = `usr-scim-owner-${suffix}`;
const groupUserId = `usr-scim-member-${suffix}`;
const replacedUserId = `usr-scim-replaced-${suffix}`;
const orgId = `org-scim-${suffix}`;
const teamId = `team-scim-${suffix}`;
const ownersTeamId = `team-scim-owners-${suffix}`;
const engineeringGroupId = `scim-group-engineering-${suffix}`;
const adminGroupId = `scim-group-admin-${suffix}`;
const teamTokenId = `api-scim-team-${suffix}`;
const adminToken = `scim-admin-token-${suffix}`;
const ownerToken = `scim-owner-token-${suffix}`;

function request(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

beforeAll(async () => {
  await db.delete(scimSettings).where(eq(scimSettings.id, "scim"));
  await db.delete(samlSettings).where(eq(samlSettings.id, "saml"));
  await db.insert(users).values([
    { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
    { id: ownerId, username: ownerId, passwordHash: "unused" },
    { id: groupUserId, username: groupUserId, passwordHash: "unused" },
    { id: replacedUserId, username: replacedUserId, passwordHash: "unused" },
  ]);
  await db.insert(organizations).values({ id: orgId, name: `scim-${suffix}` });
  await db.insert(organizationMemberships).values({
    id: `orgmem-scim-owner-${suffix}`,
    userId: ownerId,
    orgId,
    role: "owner",
    status: "active",
  });
  await db.insert(apiTokens).values([
    {
      id: `api-scim-admin-${suffix}`,
      token: createHash("sha256").update(adminToken).digest("hex"),
      userId: adminId,
    },
    {
      id: `api-scim-owner-${suffix}`,
      token: createHash("sha256").update(ownerToken).digest("hex"),
      userId: ownerId,
    },
  ]);
  await db.insert(teams).values([
    { id: teamId, orgId, name: `engineering-${suffix}`, ssoTeamId: "saml-engineering" },
    { id: ownersTeamId, orgId, name: "owners" },
  ]);
  await db.insert(apiTokens).values({
    id: teamTokenId,
    token: createHash("sha256").update(`scim-team-token-${suffix}`).digest("hex"),
    teamId,
    orgId,
  });
  await db.insert(teamMemberships).values({
    id: `tm-scim-replaced-${suffix}`,
    teamId,
    userId: replacedUserId,
  });
  await db.insert(scimGroups).values([
    { id: engineeringGroupId, name: `Engineering ${suffix}` },
    { id: adminGroupId, name: `Terrence Admins ${suffix}` },
  ]);
  await db.insert(scimUserIdentities).values({
    id: `scim-user-${suffix}`,
    userId: groupUserId,
    username: groupUserId,
  });
  await db.insert(scimGroupMemberships).values({
    id: `scim-group-member-${suffix}`,
    groupId: engineeringGroupId,
    scimUserId: `scim-user-${suffix}`,
  });
  await db.insert(samlSettings).values({
    id: "saml",
    enabled: false,
    idpCert: "-----BEGIN CERTIFICATE-----\nSCIM\n-----END CERTIFICATE-----",
    ssoEndpointUrl: "https://idp.example.test/sso",
  });
});

afterAll(async () => {
  await db.delete(teamScimGroupMappings).where(inArray(teamScimGroupMappings.teamId, [teamId, ownersTeamId]));
  await db.delete(scimGroupMemberships).where(eq(scimGroupMemberships.groupId, engineeringGroupId));
  await db.delete(scimUserIdentities).where(eq(scimUserIdentities.userId, groupUserId));
  await db.delete(scimGroups).where(inArray(scimGroups.id, [engineeringGroupId, adminGroupId]));
  await db.delete(scimTokens);
  await db.delete(scimSettings).where(eq(scimSettings.id, "scim"));
  await db.delete(samlSettings).where(eq(samlSettings.id, "saml"));
  await db.delete(teamMemberships).where(inArray(teamMemberships.teamId, [teamId, ownersTeamId]));
  await db.delete(teams).where(inArray(teams.id, [teamId, ownersTeamId]));
  await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
  await db.delete(apiTokens).where(inArray(apiTokens.userId, [adminId, ownerId]));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(inArray(users.id, [adminId, ownerId, groupUserId, replacedUserId]));
});

test("implements the documented admin SCIM lifecycle and linked-team restrictions", async () => {
  expect((await request("GET", "/api/v2/admin/scim-groups")).status).toBe(401);
  expect((await request("GET", "/api/v2/admin/scim-settings", ownerToken)).status).toBe(404);

  const initial = await request("GET", "/api/v2/admin/scim-settings", adminToken);
  expect(initial.status).toBe(200);
  expect((await initial.json()).data.attributes).toEqual({
    enabled: false,
    paused: false,
    "site-admin-group-scim-id": null,
    "site-admin-group-display-name": null,
  });

  const settingsPayload = {
    data: {
      type: "scim-settings",
      attributes: {
        enabled: true,
        paused: false,
        "site-admin-group-scim-id": adminGroupId,
      },
    },
  };
  expect((await request("PATCH", "/api/v2/admin/scim-settings", adminToken, settingsPayload)).status).toBe(422);
  await db.update(samlSettings).set({ enabled: true }).where(eq(samlSettings.id, "saml"));
  const enabled = await request("PATCH", "/api/v2/admin/scim-settings", adminToken, settingsPayload);
  expect(enabled.status).toBe(200);
  expect((await enabled.json()).data.attributes).toMatchObject({
    enabled: true,
    "site-admin-group-scim-id": adminGroupId,
    "site-admin-group-display-name": `Terrence Admins ${suffix}`,
  });
  expect((await request("PATCH", "/api/v2/admin/scim-settings", adminToken, {
    data: { type: "scim-settings", attributes: { enabled: false } },
  })).status).toBe(422);

  const listedGroups = await request(
    "GET",
    `/api/v2/admin/scim-groups?q=engineering&page%5Bnumber%5D=1&page%5Bsize%5D=1`,
    adminToken,
  );
  expect(listedGroups.status).toBe(200);
  const listedGroupsBody = await listedGroups.json();
  expect(listedGroupsBody.data).toEqual([{
    id: engineeringGroupId,
    type: "scim-groups",
    attributes: { name: `Engineering ${suffix}` },
  }]);
  expect(listedGroupsBody.meta.pagination).toMatchObject({
    "current-page": 1,
    "page-size": 1,
    "total-count": 1,
  });

  const tokenPayload = (description: string) => ({
    data: {
      type: "authentication-tokens",
      attributes: {
        description,
        "expired-at": new Date(Date.now() + (30 * DAY_MS)).toISOString(),
      },
    },
  });
  const firstTokenResponse = await request("POST", "/api/v2/admin/scim-tokens", adminToken, tokenPayload("Okta"));
  const secondTokenResponse = await request("POST", "/api/v2/admin/scim-tokens", adminToken, tokenPayload("Entra"));
  expect(firstTokenResponse.status).toBe(201);
  expect(secondTokenResponse.status).toBe(201);
  const firstToken = (await firstTokenResponse.json()).data;
  const secondToken = (await secondTokenResponse.json()).data;
  expect(firstToken.attributes.token).toStartWith("scim-");
  const storedToken = await db.query.scimTokens.findFirst({ where: eq(scimTokens.id, firstToken.id) });
  expect(storedToken?.tokenHash).toBe(createHash("sha256").update(firstToken.attributes.token).digest("hex"));
  const shownToken = await request("GET", `/api/v2/admin/scim-tokens/${firstToken.id}`, adminToken);
  expect((await shownToken.json()).data.attributes.token).toBeNull();
  const listedTokens = await request("GET", "/api/v2/admin/scim-tokens", adminToken);
  expect((await listedTokens.json()).data).toHaveLength(2);
  expect((await request("DELETE", `/api/v2/admin/scim-tokens/${firstToken.id}`, adminToken)).status).toBe(204);
  expect((await request("POST", "/api/v2/admin/scim-tokens", adminToken, {
    data: {
      type: "authentication-tokens",
      attributes: { "expired-at": new Date(Date.now() + (10 * DAY_MS)).toISOString() },
    },
  })).status).toBe(400);

  const mappingPayload = (groupId: string) => ({
    data: {
      type: "scim-group-mapping",
      attributes: { "scim-group-id": groupId },
    },
  });
  const updatedSsoId = await request("PATCH", `/api/v2/teams/${teamId}`, ownerToken, {
    data: { type: "teams", attributes: { "sso-team-id": "saml-engineering-updated" } },
  });
  expect(updatedSsoId.status).toBe(200);
  expect((await updatedSsoId.json()).data.attributes["sso-team-id"]).toBe("saml-engineering-updated");
  expect((await request(
    "POST",
    `/api/v2/admin/teams/${teamId}/scim-group-mapping`,
    adminToken,
    mappingPayload(adminGroupId),
  )).status).toBe(422);
  expect((await request(
    "POST",
    `/api/v2/admin/teams/${ownersTeamId}/scim-group-mapping`,
    adminToken,
    mappingPayload(engineeringGroupId),
  )).status).toBe(422);
  expect((await request(
    "POST",
    `/api/v2/admin/teams/${teamId}/scim-group-mapping`,
    adminToken,
    mappingPayload(engineeringGroupId),
  )).status).toBe(204);

  const syncedMembers = await db.query.teamMemberships.findMany({ where: eq(teamMemberships.teamId, teamId) });
  expect(syncedMembers.map((membership) => membership.userId)).toEqual([groupUserId]);
  expect(await db.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.orgId, orgId),
      eq(organizationMemberships.userId, groupUserId),
    ),
  })).toBeDefined();

  let shownTeam = await request("GET", `/api/v2/teams/${teamId}`, ownerToken);
  expect((await shownTeam.json()).data.attributes).toMatchObject({
    "sso-team-id": "saml-engineering-updated",
    "scim-linked": true,
    "scim-group-name": `Engineering ${suffix}`,
    "scim-sync-paused": false,
  });
  expect((await request("PATCH", `/api/v2/teams/${teamId}`, ownerToken, {
    data: { type: "teams", attributes: { name: "blocked" } },
  })).status).toBe(422);
  const ignoredSsoChange = await request("PATCH", `/api/v2/teams/${teamId}`, ownerToken, {
    data: { type: "teams", attributes: { "sso-team-id": "ignored", visibility: "secret" } },
  });
  expect(ignoredSsoChange.status).toBe(200);
  expect((await ignoredSsoChange.json()).data.attributes).toMatchObject({
    "sso-team-id": "saml-engineering-updated",
    visibility: "secret",
  });
  expect((await request("POST", `/api/v2/teams/${teamId}/relationships/users`, ownerToken, {
    data: [{ id: replacedUserId, type: "users" }],
  })).status).toBe(403);
  expect((await request("DELETE", `/api/v2/teams/${teamId}`, ownerToken)).status).toBe(404);

  const pausePayload = {
    data: { type: "scim-group-mapping", attributes: { "scim-sync-paused": true } },
  };
  expect((await request(
    "PATCH",
    `/api/v2/admin/teams/${teamId}/scim-group-mapping`,
    adminToken,
    pausePayload,
  )).status).toBe(204);
  shownTeam = await request("GET", `/api/v2/teams/${teamId}`, ownerToken);
  expect((await shownTeam.json()).data.attributes["scim-sync-paused"]).toBeTrue();
  await db.delete(scimGroupMemberships).where(eq(scimGroupMemberships.groupId, engineeringGroupId));
  expect(await db.query.teamMemberships.findFirst({
    where: and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, groupUserId)),
  })).toBeDefined();
  expect((await request(
    "PATCH",
    `/api/v2/admin/teams/${teamId}/scim-group-mapping`,
    adminToken,
    { data: { type: "scim-group-mapping", attributes: { "scim-sync-paused": false } } },
  )).status).toBe(204);
  expect(await db.query.teamMemberships.findFirst({ where: eq(teamMemberships.teamId, teamId) })).toBeUndefined();
  await db.insert(scimGroupMemberships).values({
    id: `scim-group-member-${suffix}`,
    groupId: engineeringGroupId,
    scimUserId: `scim-user-${suffix}`,
  });
  expect((await request(
    "DELETE",
    `/api/v2/admin/teams/${teamId}/scim-group-mapping`,
    adminToken,
  )).status).toBe(204);
  expect((await request("POST", `/api/v2/teams/${teamId}/relationships/users`, ownerToken, {
    data: [{ id: replacedUserId, type: "users" }],
  })).status).toBe(204);

  expect((await request(
    "POST",
    `/api/v2/admin/teams/${teamId}/scim-group-mapping`,
    adminToken,
    mappingPayload(engineeringGroupId),
  )).status).toBe(204);
  const disabled = await request("DELETE", "/api/v2/admin/scim-settings", adminToken);
  expect(disabled.status).toBe(200);
  expect((await disabled.json()).data.attributes).toEqual({
    enabled: false,
    paused: false,
    "site-admin-group-scim-id": null,
    "site-admin-group-display-name": null,
  });
  expect(await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, engineeringGroupId) })).toBeUndefined();
  expect(await db.query.scimTokens.findFirst({ where: eq(scimTokens.id, secondToken.id) })).toBeUndefined();
  expect(await db.query.teamScimGroupMappings.findFirst({
    where: eq(teamScimGroupMappings.teamId, teamId),
  })).toBeUndefined();
  expect(await db.query.teams.findFirst({ where: eq(teams.id, teamId) })).toBeDefined();
  expect(await db.query.users.findFirst({ where: eq(users.id, groupUserId) })).toBeDefined();
  expect(await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, teamTokenId) })).toBeDefined();
});
