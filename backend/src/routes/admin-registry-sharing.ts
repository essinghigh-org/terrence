import { Elysia } from "elysia";
import { and, eq, inArray, or } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { organizations, registryPartnerships, type users } from "../db/schema";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  user?: DeepReadonly<typeof users.$inferSelect> | null;
  set: Readonly<{ status?: number | string }>;
}>;

type Organization = DeepReadonly<typeof organizations.$inferSelect>;
type Partnership = DeepReadonly<typeof registryPartnerships.$inferSelect>;

function error(set: ParamCtx["set"], status: number, title: string, detail?: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  return { errors: [{ status: String(status), title, ...(detail === undefined ? {} : { detail }) }] };
}

function dataObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object") return {};
  const data = (body as Record<string, unknown>).data;
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

function attributes(body: unknown): Record<string, unknown> {
  const value = dataObject(body).attributes;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item): boolean => typeof item !== "string" || item.trim() === "")) return null;
  return [...new Set(value.map((item): string => String(item).trim()))];
}

function organizationResource(org: Organization): Record<string, unknown> {
  return {
    id: org.id,
    type: "organizations",
    attributes: {
      name: org.name,
      "global-module-sharing": org.globalModuleSharing,
      "global-provider-sharing": org.globalProviderSharing,
    },
    links: { self: `/api/v2/admin/organizations/${org.name}` },
  };
}

function partnershipResource(partnership: Partnership, producer: Organization, consumer: Organization): Record<string, unknown> {
  return {
    id: partnership.id,
    type: "module-partnerships",
    attributes: {
      "consuming-organization-id": consumer.id,
      "consuming-organization-name": consumer.name,
      "producing-organization-id": producer.id,
      "producing-organization-name": producer.name,
    },
  };
}

async function findOrganization(identifier: string): Promise<Organization | undefined> {
  return db.query.organizations.findFirst({
    where: or(eq(organizations.id, identifier), eq(organizations.name, identifier)),
  });
}

async function findOrganizationByName(name: string): Promise<Organization | undefined> {
  return db.query.organizations.findFirst({ where: eq(organizations.name, name) });
}

async function resolveOrganizations(identifiers: readonly string[]): Promise<readonly Organization[] | null> {
  if (identifiers.length === 0) return [];
  const rows = await db.query.organizations.findMany({
    where: inArray(organizations.name, identifiers),
  });
  const byName = new Map(rows.map((org): [string, Organization] => [org.name, org]));
  const missingNames = identifiers.filter((identifier): boolean => !byName.has(identifier));
  if (missingNames.length === 0) {
    return identifiers.flatMap((identifier): Organization[] => {
      const org = byName.get(identifier);
      return org === undefined ? [] : [org];
    });
  }

  const idRows = await db.query.organizations.findMany({
    where: inArray(organizations.id, missingNames),
  });
  const byId = new Map(idRows.map((org): [string, Organization] => [org.id, org]));
  if (!missingNames.every((identifier): boolean => byId.has(identifier))) return null;
  return identifiers.flatMap((identifier): Organization[] => {
    const org = byName.get(identifier) ?? byId.get(identifier);
    return org === undefined ? [] : [org];
  });
}

async function replaceConsumers(
  producer: Organization,
  kind: "modules" | "providers",
  consumers: readonly Organization[],
): Promise<void> {
  const existing = await db.query.registryPartnerships.findMany({
    where: eq(registryPartnerships.producerOrgId, producer.id),
  });
  const desiredIds = new Set(consumers.map((consumer): string => consumer.id));
  const now = Date.now();
  await db.transaction(async (tx: unknown): Promise<void> => {
    const t = tx as typeof db;
    for (const partnership of existing) {
      const desired = desiredIds.has(partnership.consumerOrgId);
      const otherEnabled = kind === "modules" ? partnership.providers : partnership.modules;
      if (!desired && !otherEnabled) {
        await t.delete(registryPartnerships).where(eq(registryPartnerships.id, partnership.id));
      } else if ((kind === "modules" ? partnership.modules : partnership.providers) !== desired) {
        await t.update(registryPartnerships)
          .set(kind === "modules" ? { modules: desired } : { providers: desired })
          .where(eq(registryPartnerships.id, partnership.id));
      }
      desiredIds.delete(partnership.consumerOrgId);
    }
    for (const consumerOrgId of desiredIds) {
      await t.insert(registryPartnerships).values({
        id: `rp-${crypto.randomUUID()}`,
        producerOrgId: producer.id,
        consumerOrgId,
        modules: kind === "modules",
        providers: kind === "providers",
        createdAt: now,
      });
    }
    await t.update(organizations)
      .set(kind === "modules" ? { globalModuleSharing: false } : { globalProviderSharing: false })
      .where(eq(organizations.id, producer.id));
  });
}

async function consumerResources(producerId: string, kind: "modules" | "providers"): Promise<Record<string, unknown>[]> {
  const partnerships = await db.query.registryPartnerships.findMany({
    where: and(
      eq(registryPartnerships.producerOrgId, producerId),
      eq(kind === "modules" ? registryPartnerships.modules : registryPartnerships.providers, true),
    ),
  });
  if (partnerships.length === 0) return [];
  const consumers = await db.query.organizations.findMany({
    where: inArray(organizations.id, partnerships.map((partnership): string => partnership.consumerOrgId)),
  });
  return consumers.map(organizationResource);
}

function relationshipIdentifiers(body: unknown): string[] | null {
  if (body === null || typeof body !== "object") return null;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  const identifiers: string[] = [];
  for (const item of data) {
    if (item === null || typeof item !== "object") return null;
    const resource = item as Record<string, unknown>;
    if (resource.type !== "organizations" || typeof resource.id !== "string" || resource.id === "") return null;
    identifiers.push(resource.id);
  }
  return [...new Set(identifiers)];
}

function explicitSharingIdentifiers(body: unknown): Readonly<{ producer: string; consumer: string }> | null {
  const attrs = attributes(body);
  const data = dataObject(body);
  const relationships = data.relationships !== null && typeof data.relationships === "object"
    ? data.relationships as Record<string, unknown>
    : {};
  const relationshipId = (name: string): string | undefined => {
    const relationship = relationships[name];
    if (relationship === null || typeof relationship !== "object") return undefined;
    const resource = (relationship as Record<string, unknown>).data;
    if (resource === null || typeof resource !== "object") return undefined;
    const id = (resource as Record<string, unknown>).id;
    return typeof id === "string" ? id : undefined;
  };
  const producer = attrs["producing-organization-id"] ?? attrs["producer-organization-id"] ?? relationshipId("producer");
  const consumer = attrs["consuming-organization-id"] ?? attrs["consumer-organization-id"] ?? relationshipId("consumer");
  return typeof producer === "string" && producer !== "" && typeof consumer === "string" && consumer !== ""
    ? { producer, consumer }
    : null;
}

export const adminRegistrySharingRoutes = new Elysia({ name: "admin-registry-sharing" })
  .use(authPlugin)
  .get("/api/v2/admin/module-sharing", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 403, "Forbidden");
    const rows = await db.query.registryPartnerships.findMany({ where: eq(registryPartnerships.modules, true) });
    const orgs = await db.query.organizations.findMany();
    const byId = new Map(orgs.map((org): [string, Organization] => [org.id, org]));
    return {
      data: rows.flatMap((partnership): Record<string, unknown>[] => {
        const producer = byId.get(partnership.producerOrgId);
        const consumer = byId.get(partnership.consumerOrgId);
        return producer === undefined || consumer === undefined ? [] : [partnershipResource(partnership, producer, consumer)];
      }),
    };
  })
  .post("/api/v2/admin/module-sharing", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 403, "Forbidden");
    const identifiers = explicitSharingIdentifiers(body);
    if (identifiers === null) return error(set, 422, "Unprocessable Entity", "Producing and consuming organization IDs are required");
    const [producer, consumer] = await Promise.all([
      findOrganization(identifiers.producer),
      findOrganization(identifiers.consumer),
    ]);
    if (producer === undefined || consumer === undefined || producer.id === consumer.id) {
      return error(set, 422, "Unprocessable Entity", "Sharing organizations must exist and be different");
    }
    const existing = await db.query.registryPartnerships.findFirst({
      where: and(eq(registryPartnerships.producerOrgId, producer.id), eq(registryPartnerships.consumerOrgId, consumer.id)),
    });
    const partnership = existing ?? {
      id: `rp-${crypto.randomUUID()}`,
      producerOrgId: producer.id,
      consumerOrgId: consumer.id,
      modules: true,
      providers: false,
      createdAt: Date.now(),
    };
    if (existing === undefined) await db.insert(registryPartnerships).values(partnership);
    else await db.update(registryPartnerships).set({ modules: true }).where(eq(registryPartnerships.id, existing.id));
    await db.update(organizations).set({ globalModuleSharing: false }).where(eq(organizations.id, producer.id));
    (set as { status: number }).status = 201;
    return { data: partnershipResource({ ...partnership, modules: true }, producer, consumer) };
  })
  .delete("/api/v2/admin/module-sharing/:id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 403, "Forbidden");
    const partnership = await db.query.registryPartnerships.findFirst({ where: eq(registryPartnerships.id, params.id ?? "") });
    if (partnership === undefined) return error(set, 404, "Not Found");
    if (!partnership.modules) return error(set, 404, "Not Found");
    if (partnership.providers) {
      await db.update(registryPartnerships).set({ modules: false }).where(eq(registryPartnerships.id, partnership.id));
    } else {
      await db.delete(registryPartnerships).where(eq(registryPartnerships.id, partnership.id));
    }
    (set as { status: number }).status = 204;
    return undefined;
  })
  .get("/api/v2/admin/organizations/:org_name/relationships/:kind", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    const kind = params.kind;
    if (kind !== "module-consumers" && kind !== "provider-consumers") return error(set, 404, "Not Found");
    const producer = await findOrganizationByName(params.org_name ?? "");
    if (producer === undefined) return error(set, 404, "Not Found");
    return { data: await consumerResources(producer.id, kind === "module-consumers" ? "modules" : "providers") };
  })
  .patch("/api/v2/admin/organizations/:org_name/relationships/module-consumers", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    const producer = await findOrganizationByName(params.org_name ?? "");
    const identifiers = relationshipIdentifiers(body);
    if (producer === undefined) return error(set, 404, "Not Found");
    if (identifiers === null) return error(set, 422, "Unprocessable Entity", "data must contain organization resource identifiers");
    const consumers = await resolveOrganizations(identifiers);
    if (consumers === null || consumers.some((consumer): boolean => consumer.id === producer.id)) {
      return error(set, 422, "Unprocessable Entity", "Module consumers must identify other organizations");
    }
    await replaceConsumers(producer, "modules", consumers);
    (set as { status: number }).status = 204;
    return undefined;
  })
  .patch("/api/v2/admin/organizations/:org_name/module-consumers", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    const producer = await findOrganizationByName(params.org_name ?? "");
    const attrs = attributes(body);
    const identifiers = stringArray(attrs["module-consuming-organization-ids"]);
    if (producer === undefined) return error(set, 404, "Not Found");
    if (dataObject(body).type !== "module-partnerships" || identifiers === null) {
      return error(set, 422, "Unprocessable Entity", "A module-partnerships payload with consumer IDs is required");
    }
    const consumers = await resolveOrganizations(identifiers);
    if (consumers === null || consumers.some((consumer): boolean => consumer.id === producer.id)) {
      return error(set, 422, "Unprocessable Entity", "Module consumers must identify other organizations");
    }
    await replaceConsumers(producer, "modules", consumers);
    const rows = await db.query.registryPartnerships.findMany({
      where: and(eq(registryPartnerships.producerOrgId, producer.id), eq(registryPartnerships.modules, true)),
    });
    const byId = new Map(consumers.map((consumer): [string, Organization] => [consumer.id, consumer]));
    return {
      data: rows.flatMap((row): Record<string, unknown>[] => {
        const consumer = byId.get(row.consumerOrgId);
        return consumer === undefined ? [] : [partnershipResource(row, producer, consumer)];
      }),
    };
  })
  .put("/api/v2/admin/organizations/:org_name/registry-partnerships", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    const producer = await findOrganizationByName(params.org_name ?? "");
    const attrs = attributes(body);
    const moduleIdentifiers = stringArray(attrs["module-consumers"] ?? attrs.module_consumers);
    const providerIdentifiers = stringArray(attrs["provider-consumers"] ?? attrs.provider_consumers);
    if (producer === undefined) return error(set, 404, "Not Found");
    if (dataObject(body).type !== "registry-partnerships" || moduleIdentifiers === null || providerIdentifiers === null) {
      return error(set, 422, "Unprocessable Entity", "A registry-partnerships payload with module and provider consumers is required");
    }
    const [moduleConsumers, providerConsumers] = await Promise.all([
      resolveOrganizations(moduleIdentifiers),
      resolveOrganizations(providerIdentifiers),
    ]);
    if (
      moduleConsumers === null
      || providerConsumers === null
      || [...moduleConsumers, ...providerConsumers].some((consumer): boolean => consumer.id === producer.id)
    ) {
      return error(set, 422, "Unprocessable Entity", "Registry consumers must identify other organizations");
    }
    await replaceConsumers(producer, "modules", moduleConsumers);
    await replaceConsumers(producer, "providers", providerConsumers);
    (set as { status: number }).status = 204;
    return undefined;
  });
