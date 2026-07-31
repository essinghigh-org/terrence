import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { notificationTemplates, organizations, type users } from "../db/schema";
import { isNotificationEventType, NOTIFICATION_EVENTS } from "../lib/events";
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

function templateResource(template: Readonly<typeof notificationTemplates.$inferSelect>): Record<string, unknown> {
  return {
    id: template.id,
    type: "notification-templates",
    attributes: {
      name: template.name,
      "event-type": template.eventType,
      "title-template": template.titleTemplate,
      "body-template": template.bodyTemplate,
      "created-at": new Date(template.createdAt).toISOString(),
    },
  };
}

export const notificationTemplateRoutes = new Elysia()
  .use(authPlugin)

  .get("/api/v2/organizations/:org_name/notification-templates", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-workspaces"))) {
      return error(set, 404, "Organization not found");
    }
    const templates = await db.query.notificationTemplates.findMany({
      where: eq(notificationTemplates.orgId, org.id),
      orderBy: (table, { asc }) => [asc(table.name)],
    });
    return { data: templates.map(templateResource) };
  })

  .post("/api/v2/organizations/:org_name/notification-templates", async ({ params, body, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const attributes = attributesFrom(body);
    const name = typeof attributes.name === "string" && attributes.name.trim() !== "" ? attributes.name.trim() : null;
    const eventType = typeof attributes["event-type"] === "string" ? attributes["event-type"] : "";
    const titleTemplate = typeof attributes["title-template"] === "string" ? attributes["title-template"] : "";
    const bodyTemplate = typeof attributes["body-template"] === "string" ? attributes["body-template"] : "";
    if (name === null || !isNotificationEventType(eventType)) {
      return error(set, 422, `name and a valid event-type (${NOTIFICATION_EVENTS.join(", ")}) are required`);
    }
    if (titleTemplate === "" || bodyTemplate === "") {
      return error(set, 422, "title-template and body-template are required");
    }
    const id = `nt-${crypto.randomUUID()}`;
    await db.insert(notificationTemplates).values({
      id,
      orgId: org.id,
      name,
      eventType,
      titleTemplate,
      bodyTemplate,
      createdAt: Date.now(),
    });
    const created = await db.query.notificationTemplates.findFirst({ where: eq(notificationTemplates.id, id) });
    if (created === undefined) return error(set, 500);
    (set as { status?: number | string }).status = 201;
    return { data: templateResource(created) };
  })

  .get("/api/v2/organizations/:org_name/notification-templates/:template_id", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-workspaces"))) {
      return error(set, 404, "Organization not found");
    }
    const template = await db.query.notificationTemplates.findFirst({ where: eq(notificationTemplates.id, params.template_id ?? "") });
    if (template === undefined || template.orgId !== org.id) return error(set, 404, "Template not found");
    return { data: templateResource(template) };
  })

  .patch("/api/v2/organizations/:org_name/notification-templates/:template_id", async ({ params, body, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const template = await db.query.notificationTemplates.findFirst({ where: eq(notificationTemplates.id, params.template_id ?? "") });
    if (template === undefined || template.orgId !== org.id) return error(set, 404, "Template not found");

    const attributes = attributesFrom(body);
    const updates: Partial<typeof notificationTemplates.$inferInsert> = {};
    if (typeof attributes.name === "string" && attributes.name.trim() !== "") updates.name = attributes.name.trim();
    // Mirror the POST guard: title/body must stay non-empty (an empty value
    // would silently produce empty notifications on every delivery).
    if (typeof attributes["title-template"] === "string" && attributes["title-template"].trim() !== "") updates.titleTemplate = attributes["title-template"];
    if (typeof attributes["body-template"] === "string" && attributes["body-template"].trim() !== "") updates.bodyTemplate = attributes["body-template"];
    if (typeof attributes["event-type"] === "string") {
      const eventType = attributes["event-type"];
      if (!isNotificationEventType(eventType)) {
        return error(set, 422, `event-type must be one of ${NOTIFICATION_EVENTS.join(", ")}`);
      }
      updates.eventType = eventType;
    }
    if (Object.keys(updates).length > 0) {
      await db.update(notificationTemplates).set(updates).where(eq(notificationTemplates.id, template.id));
    }
    const updated = await db.query.notificationTemplates.findFirst({ where: eq(notificationTemplates.id, template.id) });
    if (updated === undefined) return error(set, 500);
    return { data: templateResource(updated) };
  })

  .delete("/api/v2/organizations/:org_name/notification-templates/:template_id", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const template = await db.query.notificationTemplates.findFirst({ where: eq(notificationTemplates.id, params.template_id ?? "") });
    if (template === undefined || template.orgId !== org.id) return error(set, 404, "Template not found");
    await db.delete(notificationTemplates).where(eq(notificationTemplates.id, template.id));
    (set as { status?: number | string }).status = 204;
    return {};
  });
