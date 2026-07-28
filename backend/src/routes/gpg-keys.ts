import { Elysia } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import {
  organizations,
  registryGpgKeys,
  registryModules,
  registryModuleVersions,
  registryProviders,
  registryProviderVersions,
  type users,
} from "../db/schema";
import { inspectGpgPublicKey } from "../lib/gpg-keys";
import {
  checkOrganizationPermission,
  checkRegistryReadPermission,
  pageRequest,
  pagination,
} from "../lib/utils";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  teamId?: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;
type GpgKeyItem = Readonly<typeof registryGpgKeys.$inferSelect>;
type GpgKeyInput = Readonly<{ namespace: string; asciiArmor?: string }>;

function gpgKeyResource(key: GpgKeyItem): Record<string, unknown> {
  return {
    id: key.id,
    type: "gpg-keys",
    attributes: {
      "ascii-armor": key.asciiArmor,
      "created-at": new Date(key.createdAt).toISOString(),
      "key-id": key.keyId,
      namespace: key.namespace,
      source: key.source,
      "source-url": key.sourceUrl,
      "trust-signature": key.trustSignature,
      "updated-at": new Date(key.updatedAt).toISOString(),
    },
    links: {
      self: `/api/registry/private/v2/gpg-keys/${encodeURIComponent(key.namespace)}/${encodeURIComponent(key.keyId)}`,
    },
  };
}

function gpgKeyInput(body: unknown, requireArmor: boolean): GpgKeyInput | Readonly<{ error: string }> {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const rawData = payload["data"];
  if (rawData === null || typeof rawData !== "object") return { error: "data is required" };
  const data = rawData as Record<string, unknown>;
  if (data["type"] !== "gpg-keys") return { error: "data.type must be gpg-keys" };
  const rawAttributes = data["attributes"];
  if (rawAttributes === null || typeof rawAttributes !== "object") return { error: "data.attributes is required" };
  const attributes = rawAttributes as Record<string, unknown>;
  const namespace = attributes["namespace"];
  const asciiArmor = attributes["ascii-armor"];
  if (typeof namespace !== "string" || namespace.trim() === "") return { error: "namespace is required" };
  if (requireArmor && (typeof asciiArmor !== "string" || asciiArmor === "")) return { error: "ascii-armor is required" };
  if (!requireArmor && asciiArmor !== undefined) return { error: "Only namespace can be updated" };
  return {
    namespace: namespace.trim(),
    ...(typeof asciiArmor === "string" ? { asciiArmor } : {}),
  };
}

async function canManageGpgKeys(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  teamId: string | null,
): Promise<boolean> {
  return await checkOrganizationPermission(orgId, userId, tokenOrgId, teamId, "manage-providers")
    || await checkOrganizationPermission(orgId, userId, tokenOrgId, teamId, "manage-modules");
}

async function canReadGpgKeys(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  teamId: string | null,
): Promise<boolean> {
  if (
    await checkRegistryReadPermission(userId, orgId, "providers", tokenOrgId)
    || await checkRegistryReadPermission(userId, orgId, "modules", tokenOrgId)
  ) return true;
  if (teamId === null) return false;
  return canManageGpgKeys(orgId, userId, tokenOrgId, teamId);
}

async function gpgKeyInUse(key: GpgKeyItem): Promise<boolean> {
  const [providerUse, moduleUse] = await Promise.all([
    db.select({ id: registryProviderVersions.id })
      .from(registryProviderVersions)
      .innerJoin(registryProviders, eq(registryProviderVersions.providerId, registryProviders.id))
      .where(and(
        eq(registryProviders.orgId, key.orgId),
        eq(registryProviders.namespace, key.namespace),
        eq(registryProviderVersions.keyId, key.keyId),
      ))
      .limit(1),
    db.select({ id: registryModuleVersions.id })
      .from(registryModuleVersions)
      .innerJoin(registryModules, eq(registryModuleVersions.moduleId, registryModules.id))
      .where(and(
        eq(registryModules.orgId, key.orgId),
        eq(registryModules.namespace, key.namespace),
        eq(registryModuleVersions.keyId, key.keyId),
      ))
      .limit(1),
  ]);
  return providerUse.length > 0 || moduleUse.length > 0;
}

export const gpgKeyRoutes = new Elysia({ name: "registry-gpg-keys" })
  .use(authPlugin)
  .get("/api/registry/:registry_name/v2/gpg-keys", async ({ params, request, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params["registry_name"] !== "private") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    const namespaceFilter = new URL(request.url).searchParams.get("filter[namespace]");
    const namespaces = namespaceFilter === null
      ? []
      : [...new Set(namespaceFilter.split(",").map((entry): string => entry.trim()).filter((entry): boolean => entry !== ""))];
    if (namespaces.length === 0 || namespaces.length > 100) {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "filter[namespace] must contain between 1 and 100 namespaces" }] };
    }

    const authorized = await Promise.all(namespaces.map(async (namespace): Promise<string | undefined> => {
      const org = await db.query.organizations.findFirst({ where: eq(organizations.name, namespace) });
      return org !== undefined && await canReadGpgKeys(org.id, user?.id, tokenOrgId ?? null, teamId ?? null)
        ? namespace
        : undefined;
    }));
    const authorizedNamespaces = new Set(authorized.filter((namespace): namespace is string => namespace !== undefined));
    if (authorizedNamespaces.size === 0) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const allKeys = await db.query.registryGpgKeys.findMany({ orderBy: [desc(registryGpgKeys.createdAt)] });
    const matching = allKeys.filter((key): boolean => authorizedNamespaces.has(key.namespace));
    const page = pageRequest(request);
    const offset = (page.number - 1) * page.size;
    return {
      data: matching.slice(offset, offset + page.size).map(gpgKeyResource),
      ...pagination(request, page.number, page.size, matching.length),
    };
  })
  .post("/api/registry/:registry_name/v2/gpg-keys", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params["registry_name"] !== "private") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    const input = gpgKeyInput(body, true);
    if ("error" in input || input.asciiArmor === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "error" in input ? input.error : "ascii-armor is required" }] };
    }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, input.namespace) });
    if (org === undefined || !(await canManageGpgKeys(org.id, user?.id, tokenOrgId ?? null, teamId ?? null))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const inspected = await inspectGpgPublicKey(input.asciiArmor);
    if ("error" in inspected) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: inspected.error }] };
    }
    const existing = await db.query.registryGpgKeys.findFirst({
      where: and(eq(registryGpgKeys.namespace, input.namespace), eq(registryGpgKeys.keyId, inspected.keyId)),
    });
    if (existing !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "This GPG key already exists in the namespace" }] };
    }
    const now = Date.now();
    const key = {
      id: `gpg-${crypto.randomUUID()}`,
      orgId: org.id,
      namespace: input.namespace,
      keyId: inspected.keyId,
      fingerprint: inspected.fingerprint,
      asciiArmor: input.asciiArmor,
      source: "",
      sourceUrl: null,
      trustSignature: "",
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(registryGpgKeys).values(key);
    (set as { status: number }).status = 201;
    return { data: gpgKeyResource(key) };
  })
  .get("/api/registry/:registry_name/v2/gpg-keys/:namespace/:key_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params["registry_name"] !== "private") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    const key = await db.query.registryGpgKeys.findFirst({
      where: and(
        eq(registryGpgKeys.namespace, params["namespace"] ?? ""),
        eq(registryGpgKeys.keyId, (params["key_id"] ?? "").toUpperCase()),
      ),
    });
    if (key === undefined || !(await canReadGpgKeys(key.orgId, user?.id, tokenOrgId ?? null, teamId ?? null))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: gpgKeyResource(key) };
  })
  .patch("/api/registry/:registry_name/v2/gpg-keys/:namespace/:key_id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params["registry_name"] !== "private") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    const key = await db.query.registryGpgKeys.findFirst({
      where: and(
        eq(registryGpgKeys.namespace, params["namespace"] ?? ""),
        eq(registryGpgKeys.keyId, (params["key_id"] ?? "").toUpperCase()),
      ),
    });
    if (key === undefined || !(await canManageGpgKeys(key.orgId, user?.id, tokenOrgId ?? null, teamId ?? null))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const input = gpgKeyInput(body, false);
    if ("error" in input) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: input.error }] };
    }
    const targetOrg = await db.query.organizations.findFirst({ where: eq(organizations.name, input.namespace) });
    if (targetOrg === undefined || !(await canManageGpgKeys(targetOrg.id, user?.id, tokenOrgId ?? null, teamId ?? null))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const duplicate = await db.query.registryGpgKeys.findFirst({
      where: and(eq(registryGpgKeys.namespace, input.namespace), eq(registryGpgKeys.keyId, key.keyId)),
    });
    if (duplicate !== undefined && duplicate.id !== key.id) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "This GPG key already exists in the namespace" }] };
    }
    if (input.namespace !== key.namespace && await gpgKeyInUse(key)) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "The GPG key is in use by a registry version" }] };
    }
    const updated = { ...key, orgId: targetOrg.id, namespace: input.namespace, updatedAt: Date.now() };
    await db.update(registryGpgKeys)
      .set({ orgId: targetOrg.id, namespace: input.namespace, updatedAt: updated.updatedAt })
      .where(eq(registryGpgKeys.id, key.id));
    (set as { status: number }).status = 201;
    return { data: gpgKeyResource(updated) };
  })
  .delete("/api/registry/:registry_name/v2/gpg-keys/:namespace/:key_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if (params["registry_name"] !== "private") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    const key = await db.query.registryGpgKeys.findFirst({
      where: and(
        eq(registryGpgKeys.namespace, params["namespace"] ?? ""),
        eq(registryGpgKeys.keyId, (params["key_id"] ?? "").toUpperCase()),
      ),
    });
    if (key === undefined || !(await canManageGpgKeys(key.orgId, user?.id, tokenOrgId ?? null, teamId ?? null))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (await gpgKeyInUse(key)) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "The GPG key is in use by a registry version" }] };
    }
    await db.delete(registryGpgKeys).where(eq(registryGpgKeys.id, key.id));
    (set as { status: number }).status = 204;
    return {};
  });
