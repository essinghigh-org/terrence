import { createHash } from "node:crypto";
import { Elysia } from "elysia";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import {
  organizationMemberships,
  samlSettings,
  scimGroupMemberships,
  scimGroups,
  scimSettings,
  scimTokens,
  scimUserIdentities,
  teamMemberships,
  teamScimGroupMappings,
  teams,
  type users,
} from "../db/schema";
import { pageRequest, pagination } from "../lib/utils";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;
type ScimSettings = Readonly<typeof scimSettings.$inferSelect>;
type ScimToken = Readonly<typeof scimTokens.$inferSelect>;
type MappedTeam = Readonly<{ id: string; orgId: string }>;
type RateWindow = Readonly<{ count: number; startedAt: number }>;
type RateWindowStore = Readonly<{
  get: (key: string) => RateWindow | undefined;
  set: (key: string, value: RateWindow) => unknown;
}>;

const SCIM_SETTINGS_ID = "scim";
const DAY_MS = 86_400_000;
const settingsWindows = new Map<string, RateWindow>();
const mappingWindows = new Map<string, RateWindow>();

function error(set: SetObj, status: number, title: string, detail?: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  return { errors: [{ status: String(status), title, ...(detail === undefined ? {} : { detail }) }] };
}

function requireAdmin(
  user: ParamCtx["user"],
  set: SetObj,
  authenticateFirst = false,
): Record<string, unknown> | undefined {
  if (user === null || user === undefined) {
    return error(set, authenticateFirst ? 401 : 404, authenticateFirst ? "Unauthorized" : "Not Found");
  }
  return user.isSiteAdmin === true ? undefined : error(set, 404, "Not Found");
}

// ponytail: process-local windows are sufficient for the single-node server; use a shared limiter for multi-node deployments.
function rateLimited(
  windows: RateWindowStore,
  key: string,
  limit: number,
  duration: number,
  set: SetObj,
): Record<string, unknown> | undefined {
  const now = Date.now();
  const current = windows.get(key);
  if (current === undefined || now - current.startedAt >= duration) {
    windows.set(key, { count: 1, startedAt: now });
    return;
  }
  if (current.count >= limit) return error(set, 429, "Too Many Requests");
  windows.set(key, { ...current, count: current.count + 1 });
}

async function currentSettings(): Promise<ScimSettings> {
  await db.insert(scimSettings).values({
    id: SCIM_SETTINGS_ID,
    enabled: false,
    paused: false,
    siteAdminGroupScimId: null,
    updatedAt: Date.now(),
  }).onConflictDoNothing();
  const settings = await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, SCIM_SETTINGS_ID) });
  if (settings === undefined) throw new Error("SCIM settings are unavailable");
  return settings;
}

async function settingsResource(settings: ScimSettings): Promise<Record<string, unknown>> {
  const group = settings.siteAdminGroupScimId === null
    ? undefined
    : await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, settings.siteAdminGroupScimId) });
  return {
    id: SCIM_SETTINGS_ID,
    type: "scim-settings",
    attributes: {
      enabled: settings.enabled,
      paused: settings.paused,
      "site-admin-group-scim-id": settings.siteAdminGroupScimId,
      "site-admin-group-display-name": group?.name ?? null,
    },
  };
}

function jsonApiAttributes(
  body: unknown,
  type: "authentication-tokens" | "scim-group-mapping" | "scim-settings",
): Readonly<{ attributes: Readonly<Record<string, unknown>> }> | Readonly<{ error: string }> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { error: "Request body must be an object" };
  const data = (body as Record<string, unknown>).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { error: "data must be an object" };
  const record = data as Record<string, unknown>;
  if (record.type !== type) return { error: `data.type must be ${type}` };
  const attributes = record.attributes;
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    return { error: "data.attributes must be an object" };
  }
  return { attributes: attributes as Readonly<Record<string, unknown>> };
}

function tokenResource(token: ScimToken, rawToken?: string): Record<string, unknown> {
  return {
    id: token.id,
    type: "authentication-tokens",
    attributes: {
      description: token.description,
      token: rawToken ?? null,
      "created-at": new Date(token.createdAt).toISOString(),
      "expired-at": new Date(token.expiresAt).toISOString(),
      "last-used-at": token.lastUsedAt === null ? null : new Date(token.lastUsedAt).toISOString(),
    },
  };
}

async function reconcileTeam(team: MappedTeam, groupId: string, transaction: unknown): Promise<void> {
  const tx = transaction as typeof db;
  const links = await tx.query.scimGroupMemberships.findMany({
    where: eq(scimGroupMemberships.groupId, groupId),
  });
  const identities = links.length === 0
    ? []
    : await tx.query.scimUserIdentities.findMany({
      where: inArray(scimUserIdentities.id, links.map((link): string => link.scimUserId)),
    });
  const userIds = [...new Set(identities.map((identity): string => identity.userId))];

  await tx.delete(teamMemberships).where(eq(teamMemberships.teamId, team.id));

  // Pre-fetch all org memberships to avoid N+1
  const existingMemberships = userIds.length === 0
    ? new Map<string, typeof organizationMemberships.$inferSelect>()
    : new Map(
        (await tx.query.organizationMemberships.findMany({
          where: and(
            inArray(organizationMemberships.userId, userIds),
            eq(organizationMemberships.orgId, team.orgId),
          ),
        })).map((m): [string, typeof organizationMemberships.$inferSelect] => [m.userId, m]),
      );

  for (const userId of userIds) {
    const membership = existingMemberships.get(userId);
    if (membership === undefined) {
      await tx.insert(organizationMemberships).values({
        id: `orgmem-${crypto.randomUUID()}`,
        userId,
        orgId: team.orgId,
        role: "member",
        status: "active",
      });
    }
    await tx.insert(teamMemberships).values({
      id: `tm-${crypto.randomUUID()}`,
      teamId: team.id,
      userId,
      createdAt: Date.now(),
    }).onConflictDoNothing();
  }
}

export const scimAdminRoutes = new Elysia({ name: "scim-admin" })
  .use(authPlugin)
  .get("/api/v2/admin/scim-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set);
    if (denied !== undefined) return denied;
    const limited = rateLimited(settingsWindows, user?.id ?? "", 20, 1_000, set);
    if (limited !== undefined) return limited;
    return { data: await settingsResource(await currentSettings()) };
  })
  .patch("/api/v2/admin/scim-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set);
    if (denied !== undefined) return denied;
    const limited = rateLimited(settingsWindows, user?.id ?? "", 20, 1_000, set);
    if (limited !== undefined) return limited;
    const input = jsonApiAttributes(body, "scim-settings");
    if ("error" in input) return error(set, 422, "Unprocessable Entity", input.error);
    const current = await currentSettings();
    const attributes = input.attributes;

    if (attributes.enabled !== undefined && typeof attributes.enabled !== "boolean") {
      return error(set, 422, "Unprocessable Entity", "enabled must be a boolean");
    }
    if (attributes.enabled === false) {
      return error(set, 422, "Unprocessable Entity", "Use DELETE to disable SCIM");
    }
    if (attributes.paused !== undefined && typeof attributes.paused !== "boolean") {
      return error(set, 422, "Unprocessable Entity", "paused must be a boolean");
    }
    const requestedGroup = attributes["site-admin-group-scim-id"];
    if (requestedGroup !== undefined && requestedGroup !== null && typeof requestedGroup !== "string") {
      return error(set, 422, "Unprocessable Entity", "site-admin-group-scim-id must be a string or null");
    }
    if (requestedGroup === "") {
      return error(set, 422, "Unprocessable Entity", "site-admin-group-scim-id must not be empty");
    }
    if (attributes.enabled === true && !current.enabled) {
      const saml = await db.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") });
      if (saml?.enabled !== true) return error(set, 422, "Unprocessable Entity", "SAML must be enabled before SCIM");
    }
    const enabled = attributes.enabled === true || current.enabled;
    const paused = typeof attributes.paused === "boolean" ? attributes.paused : current.paused;
    if (paused && !enabled) return error(set, 422, "Unprocessable Entity", "SCIM must be enabled before it can be paused");
    if (typeof requestedGroup === "string") {
      const group = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, requestedGroup) });
      if (group === undefined) return error(set, 422, "Unprocessable Entity", "SCIM group not found");
    }

    await db.update(scimSettings).set({
      enabled,
      paused,
      siteAdminGroupScimId: requestedGroup === undefined
        ? current.siteAdminGroupScimId
        : requestedGroup,
      updatedAt: Date.now(),
    }).where(eq(scimSettings.id, SCIM_SETTINGS_ID));
    return { data: await settingsResource(await currentSettings()) };
  })
  .delete("/api/v2/admin/scim-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set);
    if (denied !== undefined) return denied;
    const limited = rateLimited(settingsWindows, user?.id ?? "", 20, 1_000, set);
    if (limited !== undefined) return limited;
    await currentSettings();
    await db.transaction(async (tx): Promise<void> => {
      await tx.update(scimSettings).set({
        enabled: false,
        paused: false,
        siteAdminGroupScimId: null,
        updatedAt: Date.now(),
      }).where(eq(scimSettings.id, SCIM_SETTINGS_ID));
      await tx.delete(teamScimGroupMappings);
      await tx.delete(scimGroupMemberships);
      await tx.delete(scimGroups);
      await tx.delete(scimUserIdentities);
      await tx.delete(scimTokens);
    });
    return { data: await settingsResource(await currentSettings()) };
  })
  .get("/api/v2/admin/scim-tokens", async ({ user, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set);
    if (denied !== undefined) return denied;
    const tokens = await db.query.scimTokens.findMany({ orderBy: [asc(scimTokens.createdAt)] });
    return { data: tokens.map((token): Record<string, unknown> => tokenResource(token)) };
  })
  .get("/api/v2/admin/scim-tokens/:token_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set);
    if (denied !== undefined) return denied;
    const token = await db.query.scimTokens.findFirst({
      where: eq(scimTokens.id, params.token_id ?? ""),
    });
    return token === undefined ? error(set, 404, "Not Found") : { data: tokenResource(token) };
  })
  .post("/api/v2/admin/scim-tokens", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set);
    if (denied !== undefined) return denied;
    const input = jsonApiAttributes(body, "authentication-tokens");
    if ("error" in input) return error(set, 400, "Bad Request", input.error);
    const description = input.attributes.description;
    if (description !== undefined && typeof description !== "string") {
      return error(set, 400, "Bad Request", "description must be a string");
    }
    const now = Date.now();
    const rawExpiry = input.attributes["expired-at"];
    if (rawExpiry !== undefined && typeof rawExpiry !== "string") {
      return error(set, 400, "Bad Request", "expired-at must be an ISO-8601 timestamp");
    }
    const expiresAt = typeof rawExpiry === "string" ? Date.parse(rawExpiry) : now + (365 * DAY_MS);
    if (!Number.isFinite(expiresAt) || expiresAt - now < 29 * DAY_MS || expiresAt - now > 365 * DAY_MS) {
      return error(set, 400, "Bad Request", "expired-at must be between 29 and 365 days in the future");
    }
    const rawToken = `scim-${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const token = {
      id: `at-${crypto.randomUUID()}`,
      tokenHash: createHash("sha256").update(rawToken).digest("hex"),
      description: typeof description === "string" ? description : null,
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
    };
    await db.insert(scimTokens).values(token);
    (set as { status: number }).status = 201;
    return { data: tokenResource(token, rawToken) };
  })
  .delete("/api/v2/admin/scim-tokens/:token_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set);
    if (denied !== undefined) return denied;
    const deleted = await db.delete(scimTokens)
      .where(eq(scimTokens.id, params.token_id ?? ""))
      .returning({ id: scimTokens.id });
    if (deleted.length === 0) return error(set, 404, "Not Found");
    (set as { status: number }).status = 204;
    return;
  })
  .get("/api/v2/admin/scim-groups", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set, true);
    if (denied !== undefined) return denied;
    const { number, size } = pageRequest(request);
    const query = new URL(request.url).searchParams.get("q")?.toLocaleLowerCase() ?? "";
    // ponytail: filter in memory until a real deployment shows a group catalog large enough to need indexed search.
    const allGroups = await db.query.scimGroups.findMany({ orderBy: [asc(scimGroups.name)] });
    const matching = query === ""
      ? allGroups
      : allGroups.filter((group): boolean => group.name.toLocaleLowerCase().includes(query));
    const data = matching
      .slice((number - 1) * size, number * size)
      .map((group): Record<string, unknown> => ({
        id: group.id,
        type: "scim-groups",
        attributes: { name: group.name },
      }));
    return { data, ...pagination(request, number, size, matching.length) };
  })
  .post("/api/v2/admin/teams/:external_id/scim-group-mapping", async ({ params, user, body, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set, true);
    if (denied !== undefined) return denied;
    const limited = rateLimited(mappingWindows, user?.id ?? "", 10, 60_000, set);
    if (limited !== undefined) return limited;
    const input = jsonApiAttributes(body, "scim-group-mapping");
    if ("error" in input) return error(set, 422, "Unprocessable Entity", input.error);
    const groupId = input.attributes["scim-group-id"];
    if (typeof groupId !== "string" || groupId === "") {
      return error(set, 422, "Unprocessable Entity", "scim-group-id must be a non-empty string");
    }
    const [team, group, settings] = await Promise.all([
      db.query.teams.findFirst({ where: eq(teams.id, params.external_id ?? "") }),
      db.query.scimGroups.findFirst({ where: eq(scimGroups.id, groupId) }),
      currentSettings(),
    ]);
    if (team === undefined || group === undefined) return error(set, 404, "Not Found");
    if (!settings.enabled) return error(set, 422, "Unprocessable Entity", "SCIM is not enabled");
    if (team.name.toLocaleLowerCase() === "owners" || settings.siteAdminGroupScimId === group.id) {
      return error(set, 422, "Unprocessable Entity", "Owners and site administrator groups cannot be mapped");
    }
    const existing = await db.query.teamScimGroupMappings.findFirst({
      where: eq(teamScimGroupMappings.teamId, team.id),
    });
    if (existing !== undefined) return error(set, 409, "Conflict", "Team already has a SCIM group mapping");
    const memberCount = (await db.select({ value: count() }).from(scimGroupMemberships)
      .where(eq(scimGroupMemberships.groupId, group.id)))[0]?.value ?? 0;
    if (memberCount > 1_000) return error(set, 413, "Payload Too Large");
    const linkCount = (await db.select({ value: count() }).from(teamScimGroupMappings)
      .where(eq(teamScimGroupMappings.scimGroupId, group.id)))[0]?.value ?? 0;
    if (linkCount >= 10_000) return error(set, 422, "Unprocessable Entity", "SCIM group mapping limit reached");

    await db.transaction(async (tx): Promise<void> => {
      await tx.insert(teamScimGroupMappings).values({
        teamId: team.id,
        scimGroupId: group.id,
        syncPaused: false,
        updatedAt: Date.now(),
      });
      await reconcileTeam(team, group.id, tx);
    });
    (set as { status: number }).status = 204;
    return;
  })
  .patch("/api/v2/admin/teams/:external_id/scim-group-mapping", async ({ params, user, body, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set, true);
    if (denied !== undefined) return denied;
    const limited = rateLimited(mappingWindows, user?.id ?? "", 10, 60_000, set);
    if (limited !== undefined) return limited;
    const input = jsonApiAttributes(body, "scim-group-mapping");
    if ("error" in input) return error(set, 422, "Unprocessable Entity", input.error);
    const paused = input.attributes["scim-sync-paused"];
    if (typeof paused !== "boolean") return error(set, 422, "Unprocessable Entity", "scim-sync-paused must be a boolean");
    const teamId = params.external_id ?? "";
    const [team, mapping] = await Promise.all([
      db.query.teams.findFirst({ where: eq(teams.id, teamId) }),
      db.query.teamScimGroupMappings.findFirst({ where: eq(teamScimGroupMappings.teamId, teamId) }),
    ]);
    if (team === undefined) return error(set, 404, "Not Found");
    if (mapping === undefined) return error(set, 409, "Conflict", "Team does not have a SCIM group mapping");
    if (mapping.syncPaused === paused) {
      (set as { status: number }).status = 204;
      return;
    }
    await db.transaction(async (tx): Promise<void> => {
      await tx.update(teamScimGroupMappings).set({
        syncPaused: paused,
        ...(paused ? {} : { updatedAt: Date.now() }),
      }).where(eq(teamScimGroupMappings.teamId, team.id));
      if (!paused) await reconcileTeam(team, mapping.scimGroupId, tx);
    });
    (set as { status: number }).status = 204;
    return;
  })
  .delete("/api/v2/admin/teams/:external_id/scim-group-mapping", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const denied = requireAdmin(user, set, true);
    if (denied !== undefined) return denied;
    const limited = rateLimited(mappingWindows, user?.id ?? "", 10, 60_000, set);
    if (limited !== undefined) return limited;
    const teamId = params.external_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined) return error(set, 404, "Not Found");
    const deleted = await db.delete(teamScimGroupMappings)
      .where(eq(teamScimGroupMappings.teamId, team.id))
      .returning({ teamId: teamScimGroupMappings.teamId });
    if (deleted.length === 0) return error(set, 409, "Conflict", "Team does not have a SCIM group mapping");
    (set as { status: number }).status = 204;
    return;
  });
