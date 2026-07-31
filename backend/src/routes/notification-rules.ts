import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { notificationDestinations, notificationRules, notificationTemplates, organizations, type users } from "../db/schema";
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

type TagFilter = { key: string; value: string };

function ruleResource(rule: Readonly<typeof notificationRules.$inferSelect>): Record<string, unknown> {
  return {
    id: rule.id,
    type: "notification-rules",
    attributes: {
      name: rule.name,
      "event-type": rule.eventType,
      "workspace-tag-filters": rule.workspaceTagFilters,
      "destination-id": rule.destinationId,
      "template-id": rule.templateId,
      enabled: rule.enabled === true,
      "created-at": new Date(rule.createdAt).toISOString(),
    },
  };
}

function parseTagFilters(value: unknown): TagFilter[] | null {
  if (!Array.isArray(value)) return null;
  const filters: TagFilter[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") return null;
    const key = (item as Record<string, unknown>).key;
    const val = (item as Record<string, unknown>).value;
    if (typeof key !== "string" || key === "" || typeof val !== "string") return null;
    filters.push({ key, value: val });
  }
  return filters;
}

export const notificationRuleRoutes = new Elysia()
  .use(authPlugin)

  .get("/api/v2/organizations/:org_name/notification-rules", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-workspaces"))) {
      return error(set, 404, "Organization not found");
    }
    const rules = await db.query.notificationRules.findMany({
      where: eq(notificationRules.orgId, org.id),
      orderBy: (table, { asc }) => [asc(table.name)],
    });
    return { data: rules.map(ruleResource) };
  })

  .post("/api/v2/organizations/:org_name/notification-rules", async ({ params, body, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const attributes = attributesFrom(body);
    const name = typeof attributes.name === "string" && attributes.name.trim() !== "" ? attributes.name.trim() : null;
    const eventType = typeof attributes["event-type"] === "string" ? attributes["event-type"] : "";
    const destinationId = typeof attributes["destination-id"] === "string" ? attributes["destination-id"] : "";
    const templateId = typeof attributes["template-id"] === "string" && attributes["template-id"] !== "" ? attributes["template-id"] : null;
    if (name === null || !isNotificationEventType(eventType) || destinationId === "") {
      return error(set, 422, `name, a valid event-type (${NOTIFICATION_EVENTS.join(", ")}), and destination-id are required`);
    }
    const destination = await db.query.notificationDestinations.findFirst({ where: eq(notificationDestinations.id, destinationId) });
    if (destination === undefined || destination.orgId !== org.id) {
      return error(set, 422, "destination-id must reference a destination in this organization");
    }
    if (templateId !== null) {
      const template = await db.query.notificationTemplates.findFirst({ where: eq(notificationTemplates.id, templateId) });
      if (template === undefined || template.orgId !== org.id) {
        return error(set, 422, "template-id must reference a template in this organization");
      }
    }
    const tagFilters = parseTagFilters(attributes["workspace-tag-filters"] ?? []);
    if (tagFilters === null) {
      return error(set, 422, "workspace-tag-filters must be an array of {key, value} objects");
    }
    const enabled = typeof attributes.enabled === "boolean" ? attributes.enabled : true;

    const id = `nr-${crypto.randomUUID()}`;
    await db.insert(notificationRules).values({
      id,
      orgId: org.id,
      name,
      eventType,
      workspaceTagFilters: tagFilters,
      destinationId,
      templateId,
      enabled,
      createdAt: Date.now(),
    });
    const created = await db.query.notificationRules.findFirst({ where: eq(notificationRules.id, id) });
    if (created === undefined) return error(set, 500);
    (set as { status?: number | string }).status = 201;
    return { data: ruleResource(created) };
  })

  .get("/api/v2/organizations/:org_name/notification-rules/:rule_id", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-workspaces"))) {
      return error(set, 404, "Organization not found");
    }
    const rule = await db.query.notificationRules.findFirst({ where: eq(notificationRules.id, params.rule_id ?? "") });
    if (rule === undefined || rule.orgId !== org.id) return error(set, 404, "Rule not found");
    return { data: ruleResource(rule) };
  })

  .patch("/api/v2/organizations/:org_name/notification-rules/:rule_id", async ({ params, body, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const rule = await db.query.notificationRules.findFirst({ where: eq(notificationRules.id, params.rule_id ?? "") });
    if (rule === undefined || rule.orgId !== org.id) return error(set, 404, "Rule not found");

    const attributes = attributesFrom(body);
    const updates: Partial<typeof notificationRules.$inferInsert> = {};
    if (typeof attributes.name === "string" && attributes.name.trim() !== "") updates.name = attributes.name.trim();
    if (typeof attributes["event-type"] === "string") {
      const eventType = attributes["event-type"];
      if (!isNotificationEventType(eventType)) {
        return error(set, 422, `event-type must be one of ${NOTIFICATION_EVENTS.join(", ")}`);
      }
      updates.eventType = eventType;
    }
    if (typeof attributes["destination-id"] === "string") {
      const destinationId = attributes["destination-id"];
      const destination = await db.query.notificationDestinations.findFirst({ where: eq(notificationDestinations.id, destinationId) });
      if (destination === undefined || destination.orgId !== org.id) {
        return error(set, 422, "destination-id must reference a destination in this organization");
      }
      updates.destinationId = destinationId;
    }
    if (attributes["template-id"] !== undefined && attributes["template-id"] !== null) {
      if (typeof attributes["template-id"] !== "string") {
        return error(set, 422, "template-id must be a string or null");
      }
      const templateId = attributes["template-id"];
      const template = await db.query.notificationTemplates.findFirst({ where: eq(notificationTemplates.id, templateId) });
      if (template === undefined || template.orgId !== org.id) {
        return error(set, 422, "template-id must reference a template in this organization");
      }
      updates.templateId = templateId;
    } else if (attributes["template-id"] === null) {
      updates.templateId = null;
    }
    if (attributes["workspace-tag-filters"] !== undefined) {
      const tagFilters = parseTagFilters(attributes["workspace-tag-filters"]);
      if (tagFilters === null) return error(set, 422, "workspace-tag-filters must be an array of {key, value} objects");
      updates.workspaceTagFilters = tagFilters;
    }
    if (typeof attributes.enabled === "boolean") updates.enabled = attributes.enabled;

    await db.update(notificationRules).set(updates).where(eq(notificationRules.id, rule.id));
    const updated = await db.query.notificationRules.findFirst({ where: eq(notificationRules.id, rule.id) });
    if (updated === undefined) return error(set, 500);
    return { data: ruleResource(updated) };
  })

  .delete("/api/v2/organizations/:org_name/notification-rules/:rule_id", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-policies"))) {
      return error(set, 404, "Organization not found");
    }
    const rule = await db.query.notificationRules.findFirst({ where: eq(notificationRules.id, params.rule_id ?? "") });
    if (rule === undefined || rule.orgId !== org.id) return error(set, 404, "Rule not found");
    await db.delete(notificationRules).where(eq(notificationRules.id, rule.id));
    (set as { status?: number | string }).status = 204;
    return {};
  });
