import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { notificationDestinations, organizations, type users } from "../db/schema";
import { appriseUrlFor, invokeApprise, type NotificationDestination } from "../lib/notify";
import { checkOrganizationPermission } from "../lib/utils";

type SetObj = Readonly<{ status?: number | string; headers?: Readonly<Record<string, string | number>> }>;

type Ctx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObj;
}>;

const DESTINATION_TYPES = ["slack", "discord", "sendgrid", "apprise-custom"] as const;
type DestinationType = (typeof DESTINATION_TYPES)[number];

function error(set: SetObj, status: number, detail?: string): { errors: { status: string; title: string; detail?: string }[] } {
  (set as { status?: number | string }).status = status;
  const err: { status: string; title: string; detail?: string } = { status: String(status), title: status === 404 ? "Not Found" : "Unprocessable Entity" };
  if (detail !== undefined) err.detail = detail;
  return { errors: [err] };
}

function attributesFrom(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object") return {};
  const data = (body as Record<string, unknown>).data;
  if (data === null || typeof data !== "object") return {};
  const attributes = (data as Record<string, unknown>).attributes;
  return attributes !== null && typeof attributes === "object" ? attributes as Record<string, unknown> : {};
}

function destinationResource(destination: Readonly<typeof notificationDestinations.$inferSelect>): Record<string, unknown> {
  const publicConfig: Record<string, unknown> = { ...destination.config };
  for (const key of ["token", "apiKey", "webhookUrl"]) {
    if (key in publicConfig) publicConfig[key] = null;
  }
  return {
    id: destination.id,
    type: "notification-destinations",
    attributes: {
      name: destination.name,
      type: destination.type,
      config: publicConfig,
      enabled: destination.enabled === true,
      "created-at": new Date(destination.createdAt).toISOString(),
    },
  };
}

function isDestinationType(value: unknown): value is DestinationType {
  return typeof value === "string" && (DESTINATION_TYPES as readonly string[]).includes(value);
}

/** Validate + normalize config for a destination type. */
function validateConfig(type: DestinationType, config: unknown): { ok: true; config: Record<string, string> } | { ok: false; detail: string } {
  if (config === null || typeof config !== "object") return { ok: false, detail: "config must be an object" };
  const raw = config as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  switch (type) {
    case "slack": {
      const token = str(raw.token);
      const channel = str(raw.channel);
      if (token === "" || channel === "") return { ok: false, detail: "Slack destinations require token and channel" };
      return { ok: true, config: { token, channel } };
    }
    case "discord": {
      const webhookUrl = str(raw.webhookUrl);
      if (webhookUrl === "" || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/.+/.test(webhookUrl)) {
        return { ok: false, detail: "Discord destinations require a valid Discord webhook URL" };
      }
      return { ok: true, config: { webhookUrl } };
    }
    case "sendgrid": {
      const apiKey = str(raw.apiKey);
      const fromEmail = str(raw.fromEmail);
      const toEmail = str(raw.toEmail);
      if (apiKey === "" || fromEmail === "" || toEmail === "") {
        return { ok: false, detail: "SendGrid destinations require apiKey, fromEmail and toEmail" };
      }
      return { ok: true, config: { apiKey, fromEmail, toEmail } };
    }
    case "apprise-custom": {
      const url = str(raw.url);
      if (url === "" || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
        return { ok: false, detail: "Apprise custom destinations require a valid apprise URL (scheme://...)" };
      }
      return { ok: true, config: { url } };
    }
  }
}

export const notificationDestinationRoutes = new Elysia()
  .use(authPlugin)

  .get("/api/v2/organizations/:org_name/notification-destinations", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-workspaces"))) {
      return error(set, 404, "Organization not found");
    }
    const destinations = await db.query.notificationDestinations.findMany({
      where: eq(notificationDestinations.orgId, org.id),
      orderBy: (table, { asc }) => [asc(table.name)],
    });
    return { data: destinations.map(destinationResource) };
  })

  .post("/api/v2/organizations/:org_name/notification-destinations", async ({ params, body, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const attributes = attributesFrom(body);
    const name = typeof attributes.name === "string" && attributes.name.trim() !== "" ? attributes.name.trim() : null;
    const type = attributes.type;
    if (name === null || !isDestinationType(type)) {
      return error(set, 422, "name and a valid type (slack, discord, sendgrid, apprise-custom) are required");
    }
    const validated = validateConfig(type, attributes.config);
    if (!validated.ok) return error(set, 422, validated.detail);
    const enabled = typeof attributes.enabled === "boolean" ? attributes.enabled : true;

    const id = `nd-${crypto.randomUUID()}`;
    await db.insert(notificationDestinations).values({
      id,
      orgId: org.id,
      name,
      type,
      config: validated.config,
      enabled,
      createdAt: Date.now(),
    });
    const created = await db.query.notificationDestinations.findFirst({ where: eq(notificationDestinations.id, id) });
    if (created === undefined) return error(set, 500);
    (set as { status?: number | string }).status = 201;
    return { data: destinationResource(created) };
  })

  .get("/api/v2/organizations/:org_name/notification-destinations/:destination_id", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-workspaces"))) {
      return error(set, 404, "Organization not found");
    }
    const destination = await db.query.notificationDestinations.findFirst({
      where: eq(notificationDestinations.id, params.destination_id ?? ""),
    });
    if (destination === undefined || destination.orgId !== org.id) return error(set, 404, "Destination not found");
    return { data: destinationResource(destination) };
  })

  .patch("/api/v2/organizations/:org_name/notification-destinations/:destination_id", async ({ params, body, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const destination = await db.query.notificationDestinations.findFirst({
      where: eq(notificationDestinations.id, params.destination_id ?? ""),
    });
    if (destination === undefined || destination.orgId !== org.id) return error(set, 404, "Destination not found");

    const attributes = attributesFrom(body);
    const updates: Partial<typeof notificationDestinations.$inferInsert> = {};
    if (typeof attributes.name === "string" && attributes.name.trim() !== "") updates.name = attributes.name.trim();
    if (typeof attributes.enabled === "boolean") updates.enabled = attributes.enabled;
    if (attributes.config !== undefined) {
      const validated = validateConfig(destination.type as DestinationType, attributes.config);
      if (!validated.ok) return error(set, 422, validated.detail);
      updates.config = validated.config;
    }
    await db.update(notificationDestinations).set(updates).where(eq(notificationDestinations.id, destination.id));
    const updated = await db.query.notificationDestinations.findFirst({ where: eq(notificationDestinations.id, destination.id) });
    if (updated === undefined) return error(set, 500);
    return { data: destinationResource(updated) };
  })

  .delete("/api/v2/organizations/:org_name/notification-destinations/:destination_id", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const destination = await db.query.notificationDestinations.findFirst({
      where: eq(notificationDestinations.id, params.destination_id ?? ""),
    });
    if (destination === undefined || destination.orgId !== org.id) return error(set, 404, "Destination not found");
    await db.delete(notificationDestinations).where(eq(notificationDestinations.id, destination.id));
    (set as { status?: number | string }).status = 204;
    return {};
  })

  .post("/api/v2/organizations/:org_name/notification-destinations/:destination_id/test", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const destination = await db.query.notificationDestinations.findFirst({
      where: eq(notificationDestinations.id, params.destination_id ?? ""),
    });
    if (destination === undefined || destination.orgId !== org.id) return error(set, 404, "Destination not found");

    const typed: NotificationDestination = {
      id: destination.id,
      orgId: destination.orgId,
      name: destination.name,
      type: destination.type as NotificationDestination["type"],
      config: destination.config,
      enabled: destination.enabled === true,
    };
    const delivery = await invokeApprise(typed, "Terrence Test Notification", "This is a test notification from Terrence.", "info");

    return {
      data: {
        id: `test-${crypto.randomUUID()}`,
        type: "notification-destination-tests",
        attributes: {
          successful: delivery.ok,
          error: delivery.error,
          attempts: delivery.attempts,
          url: appriseUrlFor(typed),
        },
      },
    };
  });
