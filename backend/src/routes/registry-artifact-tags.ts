import { parseBindings, replaceBindings, type Binding } from "../lib/registry-artifact-tags";
import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { organizations, registryModules, registryProviders, registryComponents } from "../db/schema";
import { authPlugin } from "../auth";
import { checkOrganizationPermission, checkOrgPermission } from "../lib/utils";
import { checkRegistryManagementRead, registryModuleResource, registryProviderResource } from "./registry";
import { componentResource } from "./registry-components";

type Kind = "modules" | "providers" | "components";
type Context = {
  params: Record<string, string>;
  body?: unknown;
  user?: { id: string } | null;
  orgId?: string | null;
  teamId?: string | null;
  set: { status?: number | string };
};
const notFound = { errors: [{ status: "404", title: "Not Found" }] };

async function artifact(kind: Kind, params: Record<string, string>) {
  const org = params["org_name"]
    ? await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"]) })
    : undefined;
  if (params["org_name"] && !org) return undefined;
  if (kind === "modules") {
    const row = await db.query.registryModules.findFirst({
      where: eq(registryModules.id, params["module_id"] ?? ""),
    });
    if (!row) return undefined;
    return {
      ...row,
      save: async (tags: string) => {
        await db.update(registryModules).set({ tagBindings: tags }).where(eq(registryModules.id, row.id));
      },
      resource: async () => registryModuleResource(row, org?.name ?? row.orgId, true),
    };
  }
  if (kind === "providers") {
    const row = await db.query.registryProviders.findFirst({
      where: org
        ? and(
            eq(registryProviders.orgId, org.id),
            eq(registryProviders.namespace, params["namespace"] ?? ""),
            eq(registryProviders.type, params["name"] ?? ""),
            eq(registryProviders.registryName, params["registry_name"] ?? ""),
          )
        : eq(registryProviders.id, params["provider_id"] ?? ""),
    });
    if (!row) return undefined;
    return {
      ...row,
      save: async (tags: string) => {
        await db.update(registryProviders).set({ tagBindings: tags }).where(eq(registryProviders.id, row.id));
      },
      resource: async () => registryProviderResource(row, org?.name ?? row.orgId),
    };
  }
  const row = await db.query.registryComponents.findFirst({
    where: eq(registryComponents.id, params["id"] ?? ""),
  });
  if (!row) return undefined;
  return {
    ...row,
    save: async (tags: string) => {
      await db.update(registryComponents).set({ tagBindings: tags }).where(eq(registryComponents.id, row.id));
    },
    resource: async () => componentResource(row),
  };
}

function handle(kind: Kind, write: boolean) {
  return async ({ params, body, user, orgId, teamId, set }: Context): Promise<unknown> => {
    const row = await artifact(kind, params);
    const permitted =
      row &&
      (write
        ? await checkOrganizationPermission(
            row.orgId,
            user?.id,
            orgId,
            teamId ?? null,
            kind === "providers" ? "manage-providers" : "manage-modules",
          )
        : kind === "components"
          ? await checkOrgPermission(user?.id, row.orgId, "member", orgId ?? null, teamId ?? null, "registry:read")
          : await checkRegistryManagementRead(user?.id, row.orgId, kind, orgId, teamId ?? null));
    if (!row || !permitted) {
      set.status = 404;
      return notFound;
    }
    const existing = JSON.parse(row.tagBindings) as Binding[];
    if (!write)
      return { data: existing.map(({ id, key, value }) => ({ id, type: "tag-bindings", attributes: { key, value } })) };
    const input = parseBindings(body, kind);
    if (!input) {
      set.status = 422;
      return {
        errors: [
          {
            status: "422",
            title: "Invalid tag bindings",
            detail: "Provide tag-bindings with unique, nonempty keys and string values.",
          },
        ],
      };
    }
    await row.save(replaceBindings(row.tagBindings, input));
    return { data: await row.resource() };
  };
}

export const registryArtifactTagsRoutes = new Elysia()
  .use(authPlugin)
  .get("/api/v2/registry-modules/:module_id/tag-bindings", handle("modules", false))
  .get("/api/v2/registry-providers/:provider_id/tag-bindings", handle("providers", false))
  .get("/api/v2/registry-components/:id/tag-bindings", handle("components", false))
  .patch(
    "/api/v2/organizations/:org_name/registry-providers/:registry_name/:namespace/:name",
    handle("providers", true),
  )
  .patch("/api/v2/registry-components/:id", handle("components", true));
