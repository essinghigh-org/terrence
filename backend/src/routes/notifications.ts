import { Elysia } from "elysia";
import { and, asc, count, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import {
  notificationConfigurations,
  notificationConfigurationWorkspaceExclusions,
  notificationWorkspaceCounters,
  organizationMemberships,
  projects,
  teams,
  type users,
  workspaces,
} from "../db/schema";
import { isOwnershipVerified, postNotification, verifyDestinationOwnership, type NotificationDelivery } from "../lib/notifications";
import { checkOrganizationPermission, checkOrgPermission, findAuthorizedWorkspace, notFound, pageRequest, pagination } from "../lib/utils";
import { isNotificationDestination, isNotificationTrigger } from "../lib/constants";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/secrets";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  request: Readonly<{ url: string }>;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObj;
}>;

type NcItem = Readonly<
  Omit<typeof notificationConfigurations.$inferSelect, "triggers">
  & { triggers: readonly string[] }
>;
type Subscription = Readonly<{ id: string; type: "workspaces" | "projects" | "teams"; orgId: string }>;

function attributesFrom(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object") return {};
  const data = (body as Record<string, unknown>)["data"];
  if (data === null || typeof data !== "object") return {};
  const attributes = (data as Record<string, unknown>)["attributes"];
  return attributes !== null && typeof attributes === "object"
    ? attributes as Record<string, unknown>
    : {};
}

function isWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEncryptedTokenInput(value: unknown): boolean {
  return typeof value === "string" && isEncryptedSecret(value);
}

function isValidEmailAddresses(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item): item is string => typeof item === "string" && EMAIL_ADDRESS_RE.test(item));
}

function isEmailAddressArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((item): item is string => typeof item === "string" && EMAIL_ADDRESS_RE.test(item));
}

function relationshipUserIds(body: unknown): readonly string[] | false | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const data = (body as Record<string, unknown>)["data"];
  if (data === null || typeof data !== "object") return undefined;
  const relationships = (data as Record<string, unknown>)["relationships"];
  if (relationships === null || typeof relationships !== "object") return undefined;
  const usersRelationship = (relationships as Record<string, unknown>)["users"];
  if (usersRelationship === undefined) return undefined;
  if (usersRelationship === null || typeof usersRelationship !== "object") return false;
  const usersData = (usersRelationship as Record<string, unknown>)["data"];
  if (!Array.isArray(usersData)) return false;
  const ids: string[] = [];
  for (const user of usersData) {
    if (user === null || typeof user !== "object") return false;
    const resource = user as Record<string, unknown>;
    if (resource["type"] !== "users" || typeof resource["id"] !== "string" || resource["id"] === "") return false;
    ids.push(resource["id"]);
  }
  return [...new Set(ids)];
}

function notificationUserIds(body: unknown, attributes: Readonly<Record<string, unknown>>): readonly string[] | false {
  const relationshipIds = relationshipUserIds(body);
  if (relationshipIds !== undefined) return relationshipIds;
  const attributeIds = attributes["email-user-ids"];
  if (attributeIds === undefined) return [];
  return Array.isArray(attributeIds) && attributeIds.every((id: unknown): id is string => typeof id === "string" && id !== "")
    ? [...new Set(attributeIds)]
    : false;
}

async function validNotificationUsers(orgId: string, userIds: readonly string[]): Promise<boolean> {
  if (userIds.length === 0) return true;
  const rows = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.orgId, orgId),
      eq(organizationMemberships.status, "active"),
      inArray(organizationMemberships.userId, [...userIds]),
    ),
    columns: { userId: true },
  });
  return new Set(rows.map((row): string => row.userId)).size === new Set(userIds).size;
}

type FieldError = { status: string; title: string; detail: string; source: { pointer: string } };

/**
 * Field-level validation detail for notification configuration creation
 * (26.9). Returns [] when the input is valid. Each error carries a
 * JSON:API source.pointer so consumers can render per-field feedback.
 */
function createValidationErrors(name: string, url: string, destinationType: string, emailAddresses: unknown, token: unknown): FieldError[] {
  const errors: FieldError[] = [];
  if (isEncryptedTokenInput(token)) errors.push({ status: "422", title: "Unprocessable Entity", detail: "token must be plaintext", source: { pointer: "/data/attributes/token" } });
  if (name === "") errors.push({ status: "422", title: "Unprocessable Entity", detail: "Name is required", source: { pointer: "/data/attributes/name" } });
  if (!isNotificationDestination(destinationType)) errors.push({ status: "422", title: "Unprocessable Entity", detail: "destination-type must be one of generic, slack, microsoft-teams, or email", source: { pointer: "/data/attributes/destination-type" } });
  if (destinationType === "email") {
    if (!isValidEmailAddresses(emailAddresses)) {
      errors.push({ status: "422", title: "Unprocessable Entity", detail: "email-addresses must contain at least one valid email address", source: { pointer: "/data/attributes/email-addresses" } });
    }
  } else if (!isWebhookUrl(url)) {
    errors.push({ status: "422", title: "Unprocessable Entity", detail: "URL must be a valid http(s) webhook", source: { pointer: "/data/attributes/url" } });
  }
  return errors;
}

function deliveryResource(delivery: Readonly<NotificationDelivery>): Record<string, unknown> {
  return {
    body: delivery.body,
    code: delivery.code,
    headers: delivery.headers,
    "sent-at": delivery.sentAt,
    successful: delivery.successful,
    url: delivery.url,
  };
}

function notificationResource(
  configuration: NcItem,
  deliveryResponses: readonly NotificationDelivery[] = [],
): Record<string, unknown> {
  const subscribable = configuration.workspaceId !== null
    ? { id: configuration.workspaceId, type: "workspaces" }
    : configuration.projectId !== null
      ? { id: configuration.projectId, type: "projects" }
      : { id: configuration.teamId, type: "teams" };
  return {
    id: configuration.id,
    type: "notification-configurations",
    attributes: {
      name: configuration.name,
      "destination-type": configuration.destinationType,
      url: configuration.url,
      "email-addresses": configuration.emailAddresses ?? [],
      triggers: configuration.triggers,
      enabled: configuration.enabled === true,
      token: null,
      "delivery-responses": deliveryResponses.map(deliveryResource),
      "email-all-members": configuration.emailAllMembers === true,
      "email-user-ids": configuration.emailUserIds ?? [],
    },
    relationships: {
      subscribable: { data: subscribable },
      "excluded-workspaces": {
        links: { related: `/api/v2/notification-configurations/${configuration.id}/relationships/workspaces` },
      },
      users: {
        data: (configuration.emailUserIds ?? []).map((id): Record<string, string> => ({ id, type: "users" })),
      },
    },
  };
}

async function subscriptionFor(configuration: NcItem): Promise<Subscription | undefined> {
  if (configuration.workspaceId !== null) {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, configuration.workspaceId) });
    return workspace === undefined
      ? undefined
      : { id: workspace.id, type: "workspaces", orgId: workspace.orgId };
  }
  if (configuration.projectId !== null) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, configuration.projectId) });
    return project === undefined
      ? undefined
      : { id: project.id, type: "projects", orgId: project.orgId };
  }
  if (configuration.teamId !== null) {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, configuration.teamId) });
    return team === undefined
      ? undefined
      : { id: team.id, type: "teams", orgId: team.orgId };
  }
  return undefined;
}

async function authorizedConfiguration(
  id: string,
  userId: string | undefined,
  tokenOrgId: string | null | undefined,
  tokenTeamId: string | null | undefined,
  required: "read" | "manage",
): Promise<NcItem | undefined> {
  const configuration = await db.query.notificationConfigurations.findFirst({
    where: eq(notificationConfigurations.id, id),
  });
  if (configuration === undefined) return undefined;
  const subscription = await subscriptionFor(configuration);
  if (subscription === undefined) return undefined;
  const authorized = subscription.type === "workspaces"
    ? (await findAuthorizedWorkspace(
        subscription.id,
        userId,
        tokenOrgId ?? null,
        tokenTeamId ?? null,
        required === "read" ? "read" : "admin",
      )) !== undefined
    : subscription.type === "projects"
      ? await checkOrganizationPermission(
          subscription.orgId,
          userId,
          tokenOrgId ?? null,
          tokenTeamId ?? null,
          required === "read" ? "read-projects" : "manage-projects",
        )
      : required === "read"
        ? await checkOrgPermission(userId, subscription.orgId, "member", tokenOrgId, tokenTeamId ?? null)
        : await checkOrganizationPermission(subscription.orgId, userId, tokenOrgId ?? null, tokenTeamId ?? null, "manage-teams");
  if (!authorized) return undefined;
  return configuration;
}

function createValues(
  body: unknown,
  scope: Readonly<{ workspaceId?: string; projectId?: string; teamId?: string }>,
): typeof notificationConfigurations.$inferInsert | undefined {
  const data = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["data"] : undefined;
  if (data === null || typeof data !== "object" || (data as Record<string, unknown>)["type"] !== "notification-configurations") return undefined;
  const attributes = attributesFrom(body);
  const name = typeof attributes["name"] === "string" ? attributes["name"].trim() : "";
  const url = typeof attributes["url"] === "string" ? attributes["url"] : "";
  const destinationType = typeof attributes["destination-type"] === "string"
    ? attributes["destination-type"]
    : "";
  const emailAddresses = attributes["email-addresses"];
  if (isEncryptedTokenInput(attributes["token"])) return undefined;
  const emailUserIds = notificationUserIds(body, attributes);
  if (emailUserIds === false) return undefined;
  const emailAllMembers = typeof attributes["email-all-members"] === "boolean"
    ? attributes["email-all-members"]
    : (scope.projectId !== undefined || scope.teamId !== undefined) && emailUserIds.length === 0;
  const triggers = attributes["triggers"] === undefined
    ? []
    : Array.isArray(attributes["triggers"]) && attributes["triggers"].every(isNotificationTrigger)
      ? [...attributes["triggers"]]
      : null;
  const valid = name !== ""
    && isNotificationDestination(destinationType)
    && triggers !== null
    && (destinationType === "email"
      ? isValidEmailAddresses(emailAddresses) || emailAllMembers || emailUserIds.length > 0
      : isWebhookUrl(url));
  if (!valid) return undefined;

  return {
    id: `nc-${crypto.randomUUID()}`,
    workspaceId: scope.workspaceId ?? null,
    projectId: scope.projectId ?? null,
    teamId: scope.teamId ?? null,
    name,
    destinationType,
    url: destinationType === "email" ? "" : url,
    emailAddresses: destinationType === "email" && isEmailAddressArray(emailAddresses) ? [...emailAddresses] : null,
    emailAllMembers: destinationType === "email" && emailAllMembers,
    emailUserIds: destinationType === "email" ? [...emailUserIds] : [],
    triggers: triggers ?? [],
    enabled: typeof attributes["enabled"] === "boolean" ? attributes["enabled"] : true,
    token: typeof attributes["token"] === "string" ? attributes["token"] : null,
    createdAt: Date.now(),
  };
}

async function insertConfiguration(values: typeof notificationConfigurations.$inferInsert): Promise<boolean> {
  return db.transaction(async (tx: unknown): Promise<boolean> => {
    const t = tx as typeof db;
    if (values.workspaceId !== null && values.workspaceId !== undefined) {
      const rows = await t.select({ total: count() }).from(notificationConfigurations).where(eq(notificationConfigurations.workspaceId, values.workspaceId));
      const currentCount = rows[0]?.total ?? 0;
      await t.insert(notificationWorkspaceCounters).values({
        workspaceId: values.workspaceId,
        configurationCount: currentCount,
        updatedAt: Date.now(),
      }).onConflictDoNothing();
      await t.update(notificationWorkspaceCounters).set({
        configurationCount: currentCount,
        updatedAt: Date.now(),
      }).where(and(
        eq(notificationWorkspaceCounters.workspaceId, values.workspaceId),
        lt(notificationWorkspaceCounters.configurationCount, currentCount),
      ));
      const reserved = await t.update(notificationWorkspaceCounters).set({
        configurationCount: sql`${notificationWorkspaceCounters.configurationCount} + 1`,
        updatedAt: Date.now(),
      }).where(and(
        eq(notificationWorkspaceCounters.workspaceId, values.workspaceId),
        lt(notificationWorkspaceCounters.configurationCount, 20),
      )).returning({ workspaceId: notificationWorkspaceCounters.workspaceId });
      if (reserved.length === 0) return false;
    }
    await t.insert(notificationConfigurations).values({ ...values, token: await encryptNotificationToken(values.token) });
    return true;
  });
}

async function encryptNotificationToken(token: string | null | undefined): Promise<string | null | undefined> {
  return token === null || token === undefined ? token : encryptSecret(token);
}

async function verifyDestinationBeforeUpdate(values: typeof notificationConfigurations.$inferInsert): Promise<boolean> {
  if (values.enabled !== true || values.destinationType === "email") return true;
  const delivery = await postNotification(await decryptedNotification(values as NcItem), {
    payload_version: 1,
    notification_configuration_id: values.id,
    message: "Terrence notification verification",
  });
  return delivery.successful;
}

async function decryptedNotification(configuration: NcItem): Promise<NcItem> {
  return configuration.token === null
    ? configuration
    : { ...configuration, token: isEncryptedSecret(configuration.token) ? await decryptSecret(configuration.token) : configuration.token };
}

export const notificationRoutes = new Elysia({ name: "notifications" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    if ((await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null)) === undefined) return notFound(set);
    const where = eq(notificationConfigurations.workspaceId, workspaceId);
    const { number, size } = pageRequest(request);
    const [configurations, countRows] = await Promise.all([
      db.query.notificationConfigurations.findMany({ where, orderBy: [asc(notificationConfigurations.createdAt), asc(notificationConfigurations.id)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(notificationConfigurations).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: configurations.map((configuration: NcItem): Record<string, unknown> => notificationResource(configuration)), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null, "admin");
    if (workspace === undefined) return notFound(set);
    const values = createValues(body, { workspaceId });
    if (values === undefined) {
      const attributes = attributesFrom(body);
      const errors = createValidationErrors(
        typeof attributes["name"] === "string" ? attributes["name"].trim() : "",
        typeof attributes["url"] === "string" ? attributes["url"] : "",
        typeof attributes["destination-type"] === "string" ? attributes["destination-type"] : "",
        attributes["email-addresses"],
        attributes["token"],
      );
      (set as { status: number }).status = 422;
      return { errors: errors.length > 0 ? errors : [{ status: "422", title: "Unprocessable Entity", detail: "Valid name, url or email-addresses, and destination-type are required" }] };
    }
    if (!(await validNotificationUsers(workspace.orgId, values.emailUserIds ?? []))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "All notification users must be active organization members" }] };
    }
    if (!(await insertConfiguration(values))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A workspace can have at most 20 notification configurations" }] };
    }
    const created = await db.query.notificationConfigurations.findFirst({
      where: eq(notificationConfigurations.id, values.id),
    });
    (set as { status: number }).status = 201;
    return { data: notificationResource(created ?? values as NcItem) };
  })
  .get("/api/v2/projects/:project_id/notification-configurations", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params["project_id"] ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-projects"))) return notFound(set);
    const where = eq(notificationConfigurations.projectId, projectId);
    const { number, size } = pageRequest(request);
    const [configurations, countRows] = await Promise.all([
      db.query.notificationConfigurations.findMany({ where, orderBy: [asc(notificationConfigurations.createdAt), asc(notificationConfigurations.id)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(notificationConfigurations).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: configurations.map((configuration: NcItem): Record<string, unknown> => notificationResource(configuration)), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/projects/:project_id/notification-configurations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params["project_id"] ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) return notFound(set);
    const values = createValues(body, { projectId });
    if (values === undefined) {
      const attributes = attributesFrom(body);
      const errors = createValidationErrors(
        typeof attributes["name"] === "string" ? attributes["name"].trim() : "",
        typeof attributes["url"] === "string" ? attributes["url"] : "",
        typeof attributes["destination-type"] === "string" ? attributes["destination-type"] : "",
        attributes["email-addresses"],
        attributes["token"],
      );
      (set as { status: number }).status = 422;
      return { errors: errors.length > 0 ? errors : [{ status: "422", title: "Unprocessable Entity", detail: "Valid name, url or email-addresses, and destination-type are required" }] };
    }
    if (!(await validNotificationUsers(project.orgId, values.emailUserIds ?? []))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "All notification users must be active organization members" }] };
    }
    if (!(await insertConfiguration(values))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A workspace can have at most 20 notification configurations" }] };
    }
    const created = await db.query.notificationConfigurations.findFirst({
      where: eq(notificationConfigurations.id, values.id),
    });
    (set as { status: number }).status = 201;
    return { data: notificationResource(created ?? values as NcItem) };
  })
  .get("/api/v2/teams/:team_id/notification-configurations", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId, tokenTeamId ?? null))) return notFound(set);
    const where = eq(notificationConfigurations.teamId, teamId);
    const { number, size } = pageRequest(request);
    const [configurations, countRows] = await Promise.all([
      db.query.notificationConfigurations.findMany({ where, orderBy: [asc(notificationConfigurations.createdAt), asc(notificationConfigurations.id)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(notificationConfigurations).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: configurations.map((configuration: NcItem): Record<string, unknown> => notificationResource(configuration)), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/teams/:team_id/notification-configurations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) return notFound(set);
    const values = createValues(body, { teamId });
    if (values === undefined) {
      const attributes = attributesFrom(body);
      const errors = createValidationErrors(
        typeof attributes["name"] === "string" ? attributes["name"].trim() : "",
        typeof attributes["url"] === "string" ? attributes["url"] : "",
        typeof attributes["destination-type"] === "string" ? attributes["destination-type"] : "",
        attributes["email-addresses"],
        attributes["token"],
      );
      (set as { status: number }).status = 422;
      return { errors: errors.length > 0 ? errors : [{ status: "422", title: "Unprocessable Entity", detail: "Valid name, url or email-addresses, and destination-type are required" }] };
    }
    if (!(await validNotificationUsers(team.orgId, values.emailUserIds ?? []))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "All notification users must be active organization members" }] };
    }
    await db.insert(notificationConfigurations).values({
      ...values,
      token: await encryptNotificationToken(values.token),
    });
    const created = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, values.id) });
    (set as { status: number }).status = 201;
    return { data: notificationResource(created ?? values as NcItem) };
  })
  .get("/api/v2/notification-configurations/:nc_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const configuration = await authorizedConfiguration(params["nc_id"] ?? "", user?.id, tokenOrgId, tokenTeamId, "read");
    return configuration === undefined ? notFound(set) : { data: notificationResource(configuration) };
  })
  .get("/api/v2/notification-configurations/:nc_id/relationships/workspaces", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const configuration = await authorizedConfiguration(params["nc_id"] ?? "", user?.id, tokenOrgId, tokenTeamId, "read");
    if (configuration === undefined || configuration.projectId === null) return notFound(set);
    const rows = await db.query.notificationConfigurationWorkspaceExclusions.findMany({
      where: eq(notificationConfigurationWorkspaceExclusions.notificationConfigurationId, configuration.id),
    });
    return { data: rows.map((row): Record<string, string> => ({ id: row.workspaceId, type: "workspaces" })) };
  })
  .post("/api/v2/notification-configurations/:nc_id/relationships/workspaces", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const configuration = await authorizedConfiguration(params["nc_id"] ?? "", user?.id, tokenOrgId, tokenTeamId, "manage");
    if (configuration === undefined || configuration.projectId === null) return notFound(set);
    const project = await db.query.projects.findFirst({ where: eq(projects.id, configuration.projectId) });
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const raw = Array.isArray(payload["data"]) ? payload["data"] : [];
    const validResources = raw.every((item): boolean => item !== null && typeof item === "object"
      && (item as Record<string, unknown>)["type"] === "workspaces"
      && typeof (item as Record<string, unknown>)["id"] === "string");
    const ids = validResources ? raw.map((item): string => (item as Record<string, string>)["id"] ?? "") : [];
    if (project === undefined || ids.length === 0 || !validResources) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data must contain workspace resources" }] };
    }
    const workspacesInProject = await db.query.workspaces.findMany({ where: and(eq(workspaces.projectId, project.id), inArray(workspaces.id, ids)), columns: { id: true } });
    if (workspacesInProject.length !== new Set(ids).size) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "All excluded workspaces must belong to the notification project" }] };
    }
    await db.insert(notificationConfigurationWorkspaceExclusions).values([...new Set(ids)].map((workspaceId): typeof notificationConfigurationWorkspaceExclusions.$inferInsert => ({
      id: `nce-${crypto.randomUUID()}`,
      notificationConfigurationId: configuration.id,
      workspaceId,
      createdAt: Date.now(),
    }))).onConflictDoNothing();
    return { data: [...new Set(ids)].map((id): Record<string, string> => ({ id, type: "workspaces" })) };
  })
  .delete("/api/v2/notification-configurations/:nc_id/relationships/workspaces", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const configuration = await authorizedConfiguration(params["nc_id"] ?? "", user?.id, tokenOrgId, tokenTeamId, "manage");
    if (configuration === undefined || configuration.projectId === null) return notFound(set);
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const raw = Array.isArray(payload["data"]) ? payload["data"] : [];
    const validResources = raw.every((item): boolean => item !== null && typeof item === "object"
      && (item as Record<string, unknown>)["type"] === "workspaces"
      && typeof (item as Record<string, unknown>)["id"] === "string");
    const ids = validResources ? raw.map((item): string => (item as Record<string, string>)["id"] ?? "") : [];
    if (ids.length === 0 || !validResources) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    await db.delete(notificationConfigurationWorkspaceExclusions).where(and(eq(notificationConfigurationWorkspaceExclusions.notificationConfigurationId, configuration.id), inArray(notificationConfigurationWorkspaceExclusions.workspaceId, [...new Set(ids)])));
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .patch("/api/v2/notification-configurations/:nc_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const id = params["nc_id"] ?? "";
    const configuration = await authorizedConfiguration(id, user?.id, tokenOrgId, tokenTeamId, "manage");
    if (configuration === undefined) return notFound(set);

    const attributes = attributesFrom(body);
    const data = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["data"] : undefined;
    if (data === null || typeof data !== "object" || (data as Record<string, unknown>)["type"] !== "notification-configurations") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be notification-configurations" }] };
    }
    const updates: Partial<typeof notificationConfigurations.$inferInsert> = {};
    if (attributes["name"] !== undefined) {
      if (typeof attributes["name"] !== "string" || attributes["name"].trim() === "") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "name must be a non-empty string" }] };
      }
      updates.name = attributes["name"].trim();
    }
    if (attributes["destination-type"] !== undefined) {
      if (typeof attributes["destination-type"] !== "string" || !isNotificationDestination(attributes["destination-type"])) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "destination-type is invalid" }] };
      }
      updates.destinationType = attributes["destination-type"];
    }
    if (attributes["url"] !== undefined) {
      if (typeof attributes["url"] !== "string") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "url must be a string" }] };
      }
      updates.url = attributes["url"];
    }
    if (attributes["email-addresses"] !== undefined) {
      if (!isEmailAddressArray(attributes["email-addresses"])) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "email-addresses must contain only valid email addresses", source: { pointer: "/data/attributes/email-addresses" } }] };
      }
      updates.emailAddresses = [...attributes["email-addresses"]];
    }
    if (attributes["triggers"] !== undefined) {
      if (!Array.isArray(attributes["triggers"]) || !attributes["triggers"].every(isNotificationTrigger)) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "triggers contains an unsupported notification trigger" }] };
      }
      updates.triggers = [...attributes["triggers"]];
    }
    if (typeof attributes["enabled"] === "boolean") updates.enabled = attributes["enabled"];
    if (attributes["token"] !== undefined) {
      if (isEncryptedTokenInput(attributes["token"])) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "token must be plaintext" }] };
      }
      updates.token = typeof attributes["token"] === "string" ? attributes["token"] : null;
    }
    if (typeof attributes["email-all-members"] === "boolean") updates.emailAllMembers = attributes["email-all-members"];
    const relationshipIds = relationshipUserIds(body);
    const recipientIds = relationshipIds ?? (
      attributes["email-user-ids"] === undefined
        ? undefined
        : notificationUserIds(body, attributes)
    );
    if (recipientIds === false) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "users must contain valid user resource identifiers" }] };
    }
    if (recipientIds !== undefined) {
      const subscription = await subscriptionFor(configuration);
      if (subscription === undefined || !(await validNotificationUsers(subscription.orgId, recipientIds))) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "All notification users must be active organization members" }] };
      }
      updates.emailUserIds = [...recipientIds];
      if (recipientIds.length === 0 && configuration.workspaceId === null && attributes["email-all-members"] === undefined) {
        updates.emailAllMembers = true;
      }
    }
    if (Object.keys(updates).length > 0) {
      // destinationChanged must reflect what the CALLER actually changed, so
      // compute it from the raw request attributes before normalization. The
      // non-email branch below always back-fills email fields into `updates`,
      // so a check against `updates` would be permanently true and would send
      // a live verification POST for any unrelated PATCH (e.g. a rename).
      const destinationChanged = [
        "destination-type",
        "url",
        "email-addresses",
        "token",
      ].some((key): boolean => attributes[key] !== undefined);
      const candidate = { ...configuration, ...updates } as typeof notificationConfigurations.$inferInsert;
      if (candidate.destinationType === "email") {
        if ((candidate.emailAddresses?.length ?? 0) === 0 && (candidate.emailUserIds?.length ?? 0) === 0 && candidate.emailAllMembers !== true) {
          (set as { status: number }).status = 422;
          return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email notifications require users, email-all-members, or email-addresses" }] };
        }
        updates.url = "";
      } else {
        if (!isWebhookUrl(candidate.url)) {
          (set as { status: number }).status = 422;
          return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "URL must be a valid http(s) webhook" }] };
        }
        updates.emailAddresses = null;
        updates.emailAllMembers = false;
        updates.emailUserIds = [];
      }
      if (candidate.enabled === true && (updates.enabled === true || destinationChanged) && !(await verifyDestinationBeforeUpdate(candidate))) {
        (set as { status: number }).status = 400;
        return { errors: [{ status: "400", title: "Bad Request", detail: "Notification verification did not return a successful response" }] };
      }
      const persistedUpdates = { ...updates };
      if (attributes["token"] !== undefined) persistedUpdates.token = await encryptNotificationToken(persistedUpdates.token);
      await db.update(notificationConfigurations).set(persistedUpdates).where(eq(notificationConfigurations.id, id));
    }
    const updated = await db.query.notificationConfigurations.findFirst({
      where: eq(notificationConfigurations.id, id),
    });
    return updated === undefined ? notFound(set) : { data: notificationResource(updated) };
  })
  .delete("/api/v2/notification-configurations/:nc_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const id = params["nc_id"] ?? "";
    const configuration = await authorizedConfiguration(id, user?.id, tokenOrgId, tokenTeamId, "manage");
    if (configuration === undefined) return notFound(set);
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.delete(notificationConfigurations).where(eq(notificationConfigurations.id, id));
      if (configuration.workspaceId !== null) {
        await t.update(notificationWorkspaceCounters).set({
          configurationCount: sql`${notificationWorkspaceCounters.configurationCount} - 1`,
          updatedAt: Date.now(),
        }).where(and(
          eq(notificationWorkspaceCounters.workspaceId, configuration.workspaceId),
          gt(notificationWorkspaceCounters.configurationCount, 0),
        ));
      }
    });
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/notification-configurations/:nc_id/actions/verify", async ({ params, query, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx & { query: Record<string, string | undefined> }): Promise<unknown> => {
    const configuration = await authorizedConfiguration(params["nc_id"] ?? "", user?.id, tokenOrgId, tokenTeamId, "manage");
    if (configuration === undefined) return notFound(set);
    // Send a realistic run sample (7.5) mirroring the production payload
    // shape so a mis-configured adapter surfaces immediately. The sample body
    // is shared with the preview path (7.10) so what you see is what is sent.
    const configuredUrl = process.env["PUBLIC_URL"] ?? "";
    const baseUrl = URL.canParse(configuredUrl) ? configuredUrl : "http://localhost";
    const samplePayload: Record<string, unknown> = {
      payload_version: 1,
      notification_configuration_id: configuration.id,
      run_url: new URL("/app/demo/workspaces/demo/runs/test-notification", baseUrl).toString(),
      run_id: "test-notification",
      run_message: "This is a sample notification from Terrence.",
      run_created_at: new Date().toISOString(),
      run_created_by: "admin",
      workspace_id: "demo",
      workspace_name: "sample-workspace",
      organization_name: "sample-org",
      notifications: [{
        message: "Run Errored",
        trigger: "run:errored",
        run_status: "errored",
        run_updated_at: new Date().toISOString(),
        run_updated_by: "admin",
      }],
    };

    // Template preview (7.10): when ?preview=true, return the exact body that
    // would be POSTed without sending it, so the caller can render the webhook
    // template before enabling the destination.
    if (query?.["preview"] === "true") {
      return {
        data: notificationResource(configuration),
        meta: { status: "preview", preview: samplePayload },
      };
    }

    const delivery = await postNotification(await decryptedNotification(configuration), samplePayload);
    if (!delivery.successful) {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: `Notification verification returned HTTP ${delivery.code}` }] };
    }
    return {
      // Diagnostics (request/response details) surface even on success so
      // the caller can confirm the destination received the right payload.
      data: notificationResource(configuration, [delivery]),
      meta: { status: "verification_sent", verification: deliveryResource(delivery) },
    };
  })
  .post("/api/v2/notification-configurations/:nc_id/actions/verify-ownership", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const configuration = await authorizedConfiguration(params["nc_id"] ?? "", user?.id, tokenOrgId, tokenTeamId, "manage");
    if (configuration === undefined) return notFound(set);

    // Ownership verification (7.7): POST a one-time challenge token and require
    // the destination to echo it back (response body or header) as proof that
    // the operator controls the endpoint. Optional — it never gates delivery.
    const outcome = await verifyDestinationOwnership(await decryptedNotification(configuration));
    if (!outcome.successful) {
      (set as { status: number }).status = 400;
      const detail = outcome.echoed === null
        ? "Destination did not respond to the ownership challenge (unreachable)."
        : "Destination did not echo the ownership challenge token. Confirm the webhook handler returns the `ownership_challenge` value in its response body or the `X-Terrence-Ownership-Challenge` header.";
      return {
        errors: [{
          status: "400",
          title: "Ownership Not Verified",
          detail,
          meta: {
            "ownership-verified": false,
            "response-preview": outcome.echoed,
          },
        }],
      };
    }
    return {
      data: {
        ...notificationResource(configuration),
        attributes: {
          ...(notificationResource(configuration)["attributes"] as Record<string, unknown>),
          "ownership-verified": true,
        },
      },
    };
  })
  .get("/api/v2/notification-configurations/:nc_id/ownership-verified", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const configuration = await authorizedConfiguration(params["nc_id"] ?? "", user?.id, tokenOrgId, tokenTeamId, "read");
    if (configuration === undefined) return notFound(set);
    const resource = notificationResource(configuration);
    return {
      data: {
        ...resource,
        attributes: {
          ...(resource["attributes"] as Record<string, unknown>),
          "ownership-verified": isOwnershipVerified(configuration.id),
        },
      },
    };
  });
