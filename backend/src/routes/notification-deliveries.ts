import { Elysia } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { notificationDeliveries, organizations, type users } from "../db/schema";
import { checkOrganizationPermission } from "../lib/utils";

type SetObj = Readonly<{ status?: number | string; headers?: Readonly<Record<string, string | number>> }>;

type Ctx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
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

function deliveryResource(delivery: Readonly<typeof notificationDeliveries.$inferSelect>): Record<string, unknown> {
  return {
    id: delivery.id,
    type: "notification-deliveries",
    attributes: {
      "rule-id": delivery.ruleId,
      "destination-id": delivery.destinationId,
      "workspace-id": delivery.workspaceId,
      "event-type": delivery.eventType,
      title: delivery.title,
      body: delivery.body,
      successful: delivery.successful === true,
      error: delivery.error,
      attempts: delivery.attempts,
      "created-at": new Date(delivery.createdAt).toISOString(),
    },
  };
}

export const notificationDeliveryRoutes = new Elysia()
  .use(authPlugin)

  .get("/api/v2/organizations/:org_name/notification-deliveries", async ({ params, query, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-workspaces"))) {
      return error(set, 404, "Organization not found");
    }
    const conditions = [eq(notificationDeliveries.orgId, org.id)];
    if (typeof query?.workspace_id === "string" && query.workspace_id !== "") {
      conditions.push(eq(notificationDeliveries.workspaceId, query.workspace_id));
    }
    if (typeof query?.["event-type"] === "string" && query["event-type"] !== "") {
      conditions.push(eq(notificationDeliveries.eventType, query["event-type"]));
    }
    if (typeof query?.successful === "string" && (query.successful === "true" || query.successful === "false")) {
      conditions.push(eq(notificationDeliveries.successful, query.successful === "true"));
    }
    const pageSize = Math.min(Math.max(Number.parseInt(query?.page_size ?? "50", 10) || 50, 1), 200);
    const pageNumber = Math.max(Number.parseInt(query?.["page[number]"] ?? "1", 10) || 1, 1);

    const deliveries = await db.query.notificationDeliveries.findMany({
      where: and(...conditions),
      orderBy: [desc(notificationDeliveries.createdAt)],
      limit: pageSize,
      offset: (pageNumber - 1) * pageSize,
    });
    return { data: deliveries.map(deliveryResource) };
  })

  .get("/api/v2/organizations/:org_name/notification-deliveries/:delivery_id", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-workspaces"))) {
      return error(set, 404, "Organization not found");
    }
    const delivery = await db.query.notificationDeliveries.findFirst({
      where: eq(notificationDeliveries.id, params.delivery_id ?? ""),
    });
    if (delivery === undefined || delivery.orgId !== org.id) return error(set, 404, "Delivery not found");
    return { data: deliveryResource(delivery) };
  });
