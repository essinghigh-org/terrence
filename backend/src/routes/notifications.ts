import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import {
  notificationConfigurations,
  projects,
  teams,
  type users,
  workspaces,
} from "../db/schema";
import { postNotification, type NotificationDelivery } from "../lib/notifications";
import { checkOrganizationPermission, checkOrgPermission, findAuthorizedWorkspace } from "../lib/utils";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
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
  const data = (body as Record<string, unknown>).data;
  if (data === null || typeof data !== "object") return {};
  const attributes = (data as Record<string, unknown>).attributes;
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
      triggers: configuration.triggers,
      enabled: configuration.enabled === true,
      token: null,
      "delivery-responses": deliveryResponses.map(deliveryResource),
    },
    relationships: { subscribable: { data: subscribable } },
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
  scope: Readonly<{ workspaceId?: string; projectId?: string }>,
): typeof notificationConfigurations.$inferInsert | undefined {
  const attributes = attributesFrom(body);
  const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
  const url = typeof attributes.url === "string" ? attributes.url : "";
  const destinationType = typeof attributes["destination-type"] === "string"
    ? attributes["destination-type"]
    : "";
  if (
    name === ""
    || !isWebhookUrl(url)
    || !["generic", "slack", "microsoft-teams"].includes(destinationType)
  ) return undefined;

  return {
    id: `nc-${crypto.randomUUID()}`,
    workspaceId: scope.workspaceId ?? null,
    projectId: scope.projectId ?? null,
    teamId: null,
    name,
    destinationType,
    url,
    triggers: Array.isArray(attributes.triggers)
      ? attributes.triggers.filter((trigger: unknown): trigger is string => typeof trigger === "string")
      : ["run:created", "run:completed"],
    enabled: typeof attributes.enabled === "boolean" ? attributes.enabled : true,
    token: typeof attributes.token === "string" ? attributes.token : null,
    createdAt: Date.now(),
  };
}

function notFound(set: SetObj): { errors: { status: string; title: string }[] } {
  (set as { status: number }).status = 404;
  return { errors: [{ status: "404", title: "Not Found" }] };
}

export const notificationRoutes = new Elysia({ name: "notifications" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    if ((await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null)) === undefined) return notFound(set);
    const configurations = await db.query.notificationConfigurations.findMany({
      where: eq(notificationConfigurations.workspaceId, workspaceId),
    });
    return { data: configurations.map((configuration: NcItem): Record<string, unknown> => notificationResource(configuration)) };
  })
  .post("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    if ((await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null, "admin")) === undefined) return notFound(set);
    const values = createValues(body, { workspaceId });
    if (values === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Valid name, url, and destination-type are required" }] };
    }
    await db.insert(notificationConfigurations).values(values);
    const created = await db.query.notificationConfigurations.findFirst({
      where: eq(notificationConfigurations.id, values.id),
    });
    (set as { status: number }).status = 201;
    return { data: notificationResource(created ?? values as NcItem) };
  })
  .get("/api/v2/projects/:project_id/notification-configurations", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-projects"))) return notFound(set);
    const configurations = await db.query.notificationConfigurations.findMany({
      where: eq(notificationConfigurations.projectId, projectId),
    });
    return { data: configurations.map((configuration: NcItem): Record<string, unknown> => notificationResource(configuration)) };
  })
  .post("/api/v2/projects/:project_id/notification-configurations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const projectId = params.project_id ?? "";
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-projects"))) return notFound(set);
    const values = createValues(body, { projectId });
    if (values === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Valid name, url, and destination-type are required" }] };
    }
    await db.insert(notificationConfigurations).values(values);
    const created = await db.query.notificationConfigurations.findFirst({
      where: eq(notificationConfigurations.id, values.id),
    });
    (set as { status: number }).status = 201;
    return { data: notificationResource(created ?? values as NcItem) };
  })
  .get("/api/v2/teams/:team_id/notification-configurations", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId, tokenTeamId ?? null))) return notFound(set);
    const configurations = await db.query.notificationConfigurations.findMany({
      where: eq(notificationConfigurations.teamId, teamId),
    });
    return { data: configurations.map((configuration: NcItem): Record<string, unknown> => notificationResource(configuration)) };
  })
  .post("/api/v2/teams/:team_id/notification-configurations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId, tokenTeamId ?? null))) return notFound(set);
    const attributes = attributesFrom(body);
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    const url = typeof attributes.url === "string" ? attributes.url : "";
    const destinationType = typeof attributes["destination-type"] === "string" ? attributes["destination-type"] : "";
    if (name === "" || !isWebhookUrl(url) || !["generic", "slack", "microsoft-teams"].includes(destinationType)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Valid name, url, and destination-type are required" }] };
    }
    const values = {
      id: `nc-${crypto.randomUUID()}`,
      workspaceId: null,
      projectId: null,
      teamId,
      name,
      destinationType,
      url,
      triggers: Array.isArray(attributes.triggers)
        ? attributes.triggers.filter((trigger: unknown): trigger is string => typeof trigger === "string")
        : ["run:created", "run:completed"],
      enabled: typeof attributes.enabled === "boolean" ? attributes.enabled : true,
      token: typeof attributes.token === "string" ? attributes.token : null,
      createdAt: Date.now(),
    };
    await db.insert(notificationConfigurations).values(values);
    const created = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, values.id) });
    (set as { status: number }).status = 201;
    return { data: notificationResource(created ?? values as NcItem) };
  })
  .get("/api/v2/notification-configurations/:nc_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const configuration = await authorizedConfiguration(params.nc_id ?? "", user?.id, tokenOrgId, tokenTeamId, "read");
    return configuration === undefined ? notFound(set) : { data: notificationResource(configuration) };
  })
  .patch("/api/v2/notification-configurations/:nc_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.nc_id ?? "";
    const configuration = await authorizedConfiguration(id, user?.id, tokenOrgId, tokenTeamId, "manage");
    if (configuration === undefined) return notFound(set);

    const attributes = attributesFrom(body);
    const updates: Partial<typeof notificationConfigurations.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (
      typeof attributes["destination-type"] === "string"
      && ["generic", "slack", "microsoft-teams"].includes(attributes["destination-type"])
    ) updates.destinationType = attributes["destination-type"];
    if (typeof attributes.url === "string" && isWebhookUrl(attributes.url)) updates.url = attributes.url;
    if (Array.isArray(attributes.triggers)) {
      updates.triggers = attributes.triggers.filter((trigger: unknown): trigger is string => typeof trigger === "string");
    }
    if (typeof attributes.enabled === "boolean") updates.enabled = attributes.enabled;
    if (attributes.token !== undefined) updates.token = typeof attributes.token === "string" ? attributes.token : null;
    if (Object.keys(updates).length > 0) {
      await db.update(notificationConfigurations).set(updates).where(eq(notificationConfigurations.id, id));
    }
    const updated = await db.query.notificationConfigurations.findFirst({
      where: eq(notificationConfigurations.id, id),
    });
    return updated === undefined ? notFound(set) : { data: notificationResource(updated) };
  })
  .delete("/api/v2/notification-configurations/:nc_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.nc_id ?? "";
    if ((await authorizedConfiguration(id, user?.id, tokenOrgId, tokenTeamId, "manage")) === undefined) return notFound(set);
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, id));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/notification-configurations/:nc_id/actions/verify", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const configuration = await authorizedConfiguration(params.nc_id ?? "", user?.id, tokenOrgId, tokenTeamId, "manage");
    if (configuration === undefined) return notFound(set);
    const delivery = await postNotification(configuration, {
      payload_version: 1,
      notification_configuration_id: configuration.id,
      notifications: [{ message: "Verification of notification configuration", trigger: "verification" }],
    });
    if (!delivery.successful) {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: `Notification verification returned HTTP ${delivery.code}` }] };
    }
    return {
      status: "verification_sent",
      data: notificationResource(configuration, [delivery]),
    };
  });
