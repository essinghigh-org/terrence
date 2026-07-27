import { Elysia } from "elysia";
import { db } from "../db";
import { teams, teamMemberships, teamWorkspaces, organizationMemberships, apiTokens, workspaces, users, organizations, notificationConfigurations } from "../db/schema";
import { eq, and, count, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { userResource } from "../lib/response";
import { tokenExpiry } from "../lib/validation";
import { checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

export const teamRoutes = new Elysia({ name: "teams" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/teams", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const teamList = await db.query.teams.findMany({ where: eq(teams.orgId, org.id) });
    const data = await Promise.all(teamList.map(async t => {
      const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, t.id)))[0]?.val ?? 0;
      return { id: t.id, type: "teams", attributes: { name: t.name, description: t.description, visibility: t.visibility, "sso-team-id": t.ssoTeamId, "users-count": userCount, permissions: { "can-update": true, "can-destroy": true } }, relationships: { users: { links: { related: `/api/v2/teams/${t.id}/relationships/users` } } } };
    }));
    return { data };
  })
  .post("/api/v2/organizations/:org_name/teams", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `team-${crypto.randomUUID()}`;
    const newTeam = { id, orgId: org.id, name: attributes.name, description: attributes.description ?? null, visibility: attributes.visibility ?? "organization", ssoTeamId: attributes["sso-team-id"] ?? null, createdAt: Date.now() };
    await db.insert(teams).values(newTeam);
    set.status = 201;
    return { data: { id, type: "teams", attributes: { name: newTeam.name, description: newTeam.description, visibility: newTeam.visibility, "sso-team-id": newTeam.ssoTeamId, "users-count": 0, permissions: { "can-update": true, "can-destroy": true } } } };
  })
  .get("/api/v2/teams/:team_id", async ({ params: { team_id }, user, orgId: tokenOrgId, query, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, team.id)))[0]?.val ?? 0;
    const includeUsers = (query as any)?.include?.split(",").includes("users");
    let included: any[] = [];
    if (includeUsers) {
      const members = await db.query.teamMemberships.findMany({ where: eq(teamMemberships.teamId, team.id) });
      const userIds = members.map(m => m.userId);
      if (userIds.length > 0) { const uList = await db.query.users.findMany({ where: inArray(users.id, userIds) }); included = uList.map(u => ({ id: u.id, type: "users", attributes: { username: u.username, email: u.email } })); }
    }
    return { data: { id: team.id, type: "teams", attributes: { name: team.name, description: team.description, visibility: team.visibility, "sso-team-id": team.ssoTeamId, "users-count": userCount, permissions: { "can-update": true, "can-destroy": true } } }, ...(included.length > 0 ? { included } : {}) };
  })
  .patch("/api/v2/teams/:team_id", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof teams.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = attributes.description;
    if (typeof attributes.visibility === "string") updates.visibility = attributes.visibility;
    if (attributes["sso-team-id"] !== undefined) updates.ssoTeamId = attributes["sso-team-id"];
    if (Object.keys(updates).length > 0) await db.update(teams).set(updates).where(eq(teams.id, team_id));
    const updated = (await db.query.teams.findFirst({ where: eq(teams.id, team_id) }))!;
    const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, team_id)))[0]?.val ?? 0;
    return { data: { id: updated.id, type: "teams", attributes: { name: updated.name, description: updated.description, visibility: updated.visibility, "sso-team-id": updated.ssoTeamId, "users-count": userCount, permissions: { "can-update": true, "can-destroy": true } } } };
  })
  .delete("/api/v2/teams/:team_id", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(apiTokens).where(eq(apiTokens.teamId, team_id));
    await db.delete(teamMemberships).where(eq(teamMemberships.teamId, team_id));
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.teamId, team_id));
    await db.delete(teams).where(eq(teams.id, team_id));
    set.status = 204;
  })
  .post("/api/v2/teams/:team_id/relationships/users", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userItems = (body as any)?.data;
    if (Array.isArray(userItems)) { for (const item of userItems) { if (item?.id) await db.insert(teamMemberships).values({ id: `tm-${crypto.randomUUID()}`, teamId: team_id, userId: item.id, createdAt: Date.now() }).onConflictDoNothing(); } }
    set.status = 204;
  })
  .delete("/api/v2/teams/:team_id/relationships/users", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userItems = (body as any)?.data;
    if (Array.isArray(userItems)) { const uIds = userItems.map(i => i.id).filter(Boolean); if (uIds.length > 0) await db.delete(teamMemberships).where(and(eq(teamMemberships.teamId, team_id), inArray(teamMemberships.userId, uIds))); }
    set.status = 204;
  })
  .post("/api/v2/teams/:team_id/relationships/organization-memberships", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const items = (body as any)?.data;
    if (Array.isArray(items)) { for (const item of items) { if (item?.id) { const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, item.id) }); if (mem && mem.orgId === team.orgId) await db.insert(teamMemberships).values({ id: `tm-${crypto.randomUUID()}`, teamId: team_id, userId: mem.userId, createdAt: Date.now() }).onConflictDoNothing(); } } }
    set.status = 204;
  })
  // --- Team Auth Tokens ---
  .post("/api/v2/teams/:team_id/authentication-token", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "owner", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const rawToken = `team-tok-${crypto.randomUUID()}`;
    const id = `tok-${crypto.randomUUID()}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.delete(apiTokens).where(eq(apiTokens.teamId, team_id));
    await db.insert(apiTokens).values({ id, token: tokenHash, teamId: team_id, orgId: team.orgId, description: `Team token for ${team.name}`, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "authentication-tokens", attributes: { token: rawToken, "created-at": new Date().toISOString() } } };
  })
  .get("/api/v2/teams/:team_id/authentication-token", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "owner", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tok = await db.query.apiTokens.findFirst({ where: eq(apiTokens.teamId, team_id) });
    if (!tok) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: tok.id, type: "authentication-tokens", attributes: { "created-at": new Date(tok.createdAt).toISOString() } } };
  })
  .delete("/api/v2/teams/:team_id/authentication-token", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "owner", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(apiTokens).where(eq(apiTokens.teamId, team_id));
    set.status = 204;
  })
  .post("/api/v2/teams/:team_id/authentication-tokens", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const secret = `team-${crypto.randomUUID().replace(/-/g, "")}`;
    const tokenId = `tok-${crypto.randomUUID()}`;
    const attrs = (body as any)?.data?.attributes || {};
    const description = attrs.description ?? `Team token for ${team.name}`;
    const expiredAtStr = attrs["expired-at"] || attrs["expires-at"] || attrs.expiredAt || attrs.expiresAt;
    const expiresAt = expiredAtStr ? new Date(expiredAtStr).getTime() : null;
    const tokenHash = createHash("sha256").update(secret).digest("hex");
    await db.insert(apiTokens).values({ id: tokenId, token: tokenHash, orgId: team.orgId, teamId: team.id, description, createdAt: Date.now(), expiresAt });
    set.status = 201;
    return { data: { id: tokenId, type: "authentication-tokens", attributes: { token: secret, description, "created-at": new Date().toISOString(), "expired-at": expiresAt ? new Date(expiresAt).toISOString() : null } } };
  })
  .get("/api/v2/teams/:team_id/authentication-tokens", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tokenList = await db.query.apiTokens.findMany({ where: eq(apiTokens.teamId, team_id) });
    return { data: tokenList.map(t => ({ id: t.id, type: "authentication-tokens", attributes: { description: t.description, "created-at": new Date(t.createdAt).toISOString(), "last-used-at": t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : null } })) };
  })
  .delete("/api/v2/teams/:team_id/authentication-tokens/:token_id", async ({ params: { team_id, token_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(apiTokens).where(and(eq(apiTokens.id, token_id), eq(apiTokens.teamId, team_id)));
    set.status = 204;
  })
  // --- Team Workspaces ---
  .get("/api/v2/team-workspaces", async ({ query, user, orgId: tokenOrgId, set }) => {
    const workspaceId = (query as any)?.["filter[workspace][id]"];
    if (!workspaceId) return { data: [] };
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const twList = await db.query.teamWorkspaces.findMany({ where: eq(teamWorkspaces.workspaceId, workspaceId) });
    return { data: twList.map(tw => ({ id: tw.id, type: "team-workspaces", attributes: { access: tw.access, permissions: tw.permissions ?? { runs: "write", variables: "write", "state-versions": "write" } }, relationships: { team: { data: { id: tw.teamId, type: "teams" } }, workspace: { data: { id: tw.workspaceId, type: "workspaces" } } } })) };
  })
  .post("/api/v2/team-workspaces", async ({ body, user, orgId: tokenOrgId, set }) => {
    const data = (body as any)?.data;
    const teamId = data?.relationships?.team?.data?.id;
    const workspaceId = data?.relationships?.workspace?.data?.id;
    const access = data?.attributes?.access ?? "write";
    const permissions = data?.attributes?.permissions ?? null;
    if (!teamId || !workspaceId) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const id = `tw-${crypto.randomUUID()}`;
    await db.insert(teamWorkspaces).values({ id, teamId, workspaceId, access, permissions });
    set.status = 201;
    return { data: { id, type: "team-workspaces", attributes: { access, permissions: permissions ?? { runs: "write", variables: "write" } }, relationships: { team: { data: { id: teamId, type: "teams" } }, workspace: { data: { id: workspaceId, type: "workspaces" } } } } };
  })
  .patch("/api/v2/team-workspaces/:id", async ({ params: { id }, body, user, orgId: tokenOrgId, set }) => {
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (!tw) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof teamWorkspaces.$inferInsert> = {};
    if (typeof attributes.access === "string") updates.access = attributes.access;
    if (attributes.permissions !== undefined) updates.permissions = attributes.permissions;
    if (Object.keys(updates).length > 0) await db.update(teamWorkspaces).set(updates).where(eq(teamWorkspaces.id, id));
    const updated = (await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) }))!;
    return { data: { id: updated.id, type: "team-workspaces", attributes: { access: updated.access, permissions: updated.permissions }, relationships: { team: { data: { id: updated.teamId, type: "teams" } }, workspace: { data: { id: updated.workspaceId, type: "workspaces" } } } } };
  })
  .delete("/api/v2/team-workspaces/:id", async ({ params: { id }, user, orgId: tokenOrgId, set }) => {
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (!tw) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.id, id));
    set.status = 204;
  })
  // --- Team Notification Configurations ---
  .post("/api/v2/teams/:team_id/notification-configurations", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "owner", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.url || !attributes["destination-type"]) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "URL and destination-type are required" }] }; }
    const id = `nc-${crypto.randomUUID()}`;
    await db.insert(notificationConfigurations).values({ id, workspaceId: null, teamId: team_id, name: attributes.name ?? `Team notification for ${team.name}`, destinationType: attributes["destination-type"], url: attributes.url, triggers: Array.isArray(attributes.triggers) ? attributes.triggers : ["team:change_request"], enabled: attributes.enabled ?? true, token: attributes.token ?? null, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "notification-configurations", attributes: { name: attributes.name ?? `Team notification for ${team.name}`, "destination-type": attributes["destination-type"], url: attributes.url, triggers: Array.isArray(attributes.triggers) ? attributes.triggers : ["team:change_request"], enabled: attributes.enabled ?? true } } };
  });
