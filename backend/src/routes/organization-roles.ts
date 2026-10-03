import { newResourceId } from "../lib/resource-id";
import { Elysia } from "elysia";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  organizationMembershipRoles,
  organizationMemberships,
  organizationRoles,
  organizations,
  type users,
} from "../db/schema";
import { authPlugin } from "../auth";
import { checkOrganizationPermission } from "../lib/utils";

type Ctx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  teamId?: string | null;
  set: { status?: number | string };
}>;
const error = (set: { status?: number | string }, status: number, detail: string): Record<string, unknown> => {
  set.status = status;
  return { errors: [{ status: String(status), title: status === 404 ? "Not Found" : "Unprocessable Entity", detail }] };
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const resource = (role: typeof organizationRoles.$inferSelect): Record<string, unknown> => ({
  id: role.id,
  type: "organization-roles",
  attributes: {
    name: role.name,
    description: role.description,
    permissions: role.permissions,
    "created-at": new Date(role.createdAt).toISOString(),
    "updated-at": new Date(role.updatedAt).toISOString(),
  },
});
type RoleInput = {
  name: string;
  description: string | null;
  permissions: Record<string, boolean>;
};

function parsePermissions(value: unknown): Record<string, boolean> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const permissions: Record<string, boolean> = {};
  for (const [key, permission] of Object.entries(value as Record<string, unknown>)) {
    if (typeof permission !== "boolean") return null;
    permissions[key] = permission;
  }
  return permissions;
}

function createInput(body: unknown): RoleInput | null {
  const attrs = object(object(object(body)["data"])["attributes"]);
  if (typeof attrs["name"] !== "string" || attrs["name"].trim() === "") return null;
  const permissions = attrs["permissions"] === undefined ? {} : parsePermissions(attrs["permissions"]);
  if (permissions === null) return null;
  const description = attrs["description"];
  if (description !== undefined && description !== null && typeof description !== "string") return null;
  return {
    name: attrs["name"].trim(),
    description: typeof description === "string" ? description.trim() || null : null,
    permissions,
  };
}

function patchInput(body: unknown): Partial<RoleInput> | null {
  const attrs = object(object(object(body)["data"])["attributes"]);
  const updates: Partial<RoleInput> = {};
  if (attrs["name"] !== undefined) {
    if (typeof attrs["name"] !== "string" || attrs["name"].trim() === "") return null;
    updates.name = attrs["name"].trim();
  }
  if (attrs["description"] !== undefined) {
    const description = attrs["description"];
    if (description !== null && typeof description !== "string") return null;
    updates.description = typeof description === "string" ? description.trim() || null : null;
  }
  if (attrs["permissions"] !== undefined) {
    const permissions = parsePermissions(attrs["permissions"]);
    if (permissions === null) return null;
    updates.permissions = permissions;
  }
  return updates;
}

export const organizationRoleRoutes = new Elysia({ name: "organization-roles" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/roles", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "read-workspaces")))
      return error(set, 404, "Organization not found");
    const roles = await db.query.organizationRoles.findMany({
      where: eq(organizationRoles.orgId, org.id),
      orderBy: [asc(organizationRoles.name)],
    });
    return { data: roles.map(resource) };
  })
  .post(
    "/api/v2/organizations/:org_name/roles",
    async ({ params, body, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
      const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
      if (
        org === undefined ||
        !(await checkOrganizationPermission(org.id, user?.id, orgId, teamId, "manage-organization-access"))
      )
        return error(set, 404, "Organization not found");
      const parsed = createInput(body);
      if (parsed === null) return error(set, 422, "name and boolean permissions are required");
      const role = {
        id: newResourceId("role"),
        orgId: org.id,
        ...parsed,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } satisfies typeof organizationRoles.$inferInsert;
      try {
        await db.insert(organizationRoles).values(role);
      } catch {
        return error(set, 409, "A role with this name already exists");
      }
      set.status = 201;
      return { data: resource(role) };
    },
  )
  .patch(
    "/api/v2/organization-roles/:id",
    async ({ params, body, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
      const role = await db.query.organizationRoles.findFirst({ where: eq(organizationRoles.id, params["id"] ?? "") });
      if (
        role === undefined ||
        !(await checkOrganizationPermission(role.orgId, user?.id, orgId, teamId, "manage-organization-access"))
      )
        return error(set, 404, "Role not found");
      const parsed = patchInput(body);
      if (parsed === null) return error(set, 422, "supplied role fields are invalid");
      const updated = { ...role, ...parsed, updatedAt: Date.now() };
      await db
        .update(organizationRoles)
        .set({ ...parsed, updatedAt: updated.updatedAt })
        .where(eq(organizationRoles.id, role.id));
      return { data: resource(updated) };
    },
  )
  .delete("/api/v2/organization-roles/:id", async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
    const role = await db.query.organizationRoles.findFirst({ where: eq(organizationRoles.id, params["id"] ?? "") });
    if (
      role === undefined ||
      !(await checkOrganizationPermission(role.orgId, user?.id, orgId, teamId, "manage-organization-access"))
    )
      return error(set, 404, "Role not found");
    await db.delete(organizationRoles).where(eq(organizationRoles.id, role.id));
    set.status = 204;
    return {};
  })
  .get(
    "/api/v2/organization-memberships/:id/roles",
    async ({ params, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
      const membership = await db.query.organizationMemberships.findFirst({
        where: eq(organizationMemberships.id, params["id"] ?? ""),
      });
      if (
        membership === undefined ||
        !(await checkOrganizationPermission(membership.orgId, user?.id, orgId, teamId, "read-workspaces"))
      )
        return error(set, 404, "Membership not found");
      const links = await db.query.organizationMembershipRoles.findMany({
        where: eq(organizationMembershipRoles.membershipId, membership.id),
      });
      const roles =
        links.length === 0
          ? []
          : await db.query.organizationRoles.findMany({
              where: inArray(
                organizationRoles.id,
                links.map((link) => link.roleId),
              ),
            });
      return { data: roles.map(resource) };
    },
  )
  .put(
    "/api/v2/organization-memberships/:id/roles",
    async ({ params, body, user, orgId, teamId, set }: Ctx): Promise<unknown> => {
      const membership = await db.query.organizationMemberships.findFirst({
        where: eq(organizationMemberships.id, params["id"] ?? ""),
      });
      if (
        membership === undefined ||
        !(await checkOrganizationPermission(membership.orgId, user?.id, orgId, teamId, "manage-membership"))
      )
        return error(set, 404, "Membership not found");
      const ids = Array.isArray(object(body)["data"]) ? (object(body)["data"] as unknown[]) : [];
      const roleIds = ids
        .map((item): string => {
          if (typeof item === "string") return item;
          const rawId = object(item)["id"];
          return typeof rawId === "string" ? rawId : "";
        })
        .filter((id): id is string => typeof id === "string");
      const roles =
        roleIds.length === 0
          ? []
          : await db.query.organizationRoles.findMany({
              where: and(eq(organizationRoles.orgId, membership.orgId), inArray(organizationRoles.id, roleIds)),
            });
      if (roles.length !== new Set(roleIds).size) return error(set, 422, "All roles must belong to this organization");
      await db.transaction(async (tx) => {
        await tx.delete(organizationMembershipRoles).where(eq(organizationMembershipRoles.membershipId, membership.id));
        if (roles.length > 0)
          await tx
            .insert(organizationMembershipRoles)
            .values(roles.map((role) => ({ membershipId: membership.id, roleId: role.id, createdAt: Date.now() })));
      });
      return { data: roles.map(resource) };
    },
  );
