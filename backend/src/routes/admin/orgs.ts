import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { organizations } from "../../db/schema";
import { eq } from "drizzle-orm";
import { cachedOrgByName, invalidateOrgLookup } from "../../lib/cached-lookups";
import type { ParamCtx } from "./types";
import { adminOrganizationResource, clearSpecificRegistrySharing } from "./helpers";
export const orgsRoutes = new Elysia({ name: "admin-orgs" })
  .use(authPlugin)
  .get("/api/v2/admin/organizations", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const allOrgs = await db.query.organizations.findMany();
    return { data: allOrgs.map(adminOrganizationResource) };
  })
  .get("/api/v2/admin/organizations/:org_name", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminOrganizationResource(org) };
  })
  .patch("/api/v2/admin/organizations/:org_name", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof organizations.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    for (const key of ["global-module-sharing", "global-provider-sharing"] as const) {
      if (attributes[key] !== undefined && typeof attributes[key] !== "boolean") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `${key} must be a boolean` }] };
      }
    }
    if (typeof attributes["global-module-sharing"] === "boolean") updates.globalModuleSharing = attributes["global-module-sharing"];
    if (typeof attributes["global-provider-sharing"] === "boolean") updates.globalProviderSharing = attributes["global-provider-sharing"];
    if (typeof attributes["access-beta-tools"] === "boolean") updates.accessBetaTools = attributes["access-beta-tools"];
    if (attributes["workspace-limit"] !== undefined) {
      if (attributes["workspace-limit"] !== null && (typeof attributes["workspace-limit"] !== "number" || !Number.isInteger(attributes["workspace-limit"]))) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "workspace-limit must be an integer or null" }] };
      }
      updates.workspaceLimit = typeof attributes["workspace-limit"] === "number" ? attributes["workspace-limit"] : null;
    }
    if (attributes["owners-team-saml-role-id"] !== undefined) {
      if (attributes["owners-team-saml-role-id"] !== null && typeof attributes["owners-team-saml-role-id"] !== "string") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "owners-team-saml-role-id must be a string or null" }] };
      }
      const roleId = typeof attributes["owners-team-saml-role-id"] === "string"
        ? attributes["owners-team-saml-role-id"].trim()
        : "";
      updates.ownersTeamSamlRoleId = roleId === "" ? null : roleId;
    }
    if (Object.keys(updates).length > 0) await db.update(organizations).set(updates).where(eq(organizations.id, org.id));
    if (updates.globalModuleSharing === true) await clearSpecificRegistrySharing(org.id, "modules");
    if (updates.globalProviderSharing === true) await clearSpecificRegistrySharing(org.id, "providers");
    // The org may have been renamed; drop both cache keys so any later
    // lookup in this request re-reads the database.
    invalidateOrgLookup(orgName, org.id);
    const updated = await db.query.organizations.findFirst({ where: eq(organizations.id, org.id) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminOrganizationResource(updated) };
  })
  .delete("/api/v2/admin/organizations/:org_name", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params.org_name ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(organizations).where(eq(organizations.id, org.id));
    invalidateOrgLookup(orgName, org.id);
    (set as { status: number }).status = 204;
    return {};
  });
