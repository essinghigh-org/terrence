import { Elysia } from "elysia";
import { db } from "../db";
import { hyokConfigurations, hyokCustomerKeyVersions, organizations, type users } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { checkOrganizationPermission, notFound } from "../lib/utils";
import { authPlugin } from "../auth";
import { cachedOrgByName } from "../lib/cached-lookups";

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: { status?: number | string; headers: Readonly<Record<string, string | number>> };
}>;

type HyokRow = typeof hyokConfigurations.$inferSelect;

// go-tfe HYOKConfiguration's model reads Organization.Name, AgentPool.ID and the
// polymorphic oidc-configuration relationship (type-tagged). Key versions are
// loaded per config (create auto-generates one, like the reference format's KMS key pair).
async function hyokResource(
  row: HyokRow,
  orgName: string,
  keyVersionsByConfig?: ReadonlyMap<string, readonly (typeof hyokCustomerKeyVersions.$inferSelect)[]>,
): Promise<Record<string, unknown>> {
  const keyVersions = keyVersionsByConfig?.get(row.id) ?? await db.query.hyokCustomerKeyVersions.findMany({
    where: eq(hyokCustomerKeyVersions.hyokConfigId, row.id),
  });
  return {
    id: row.id,
    type: "hyok-configurations",
    attributes: {
      name: row.name,
      "kek-id": row.kekId,
      "kms-options": row.kmsOptions ?? null,
      primary: row.isPrimary === true,
      status: row.status,
      error: row.error ?? null,
    },
    relationships: {
      organization: { data: { id: orgName, type: "organizations" } },
      "agent-pool": row.agentPoolId !== null ? { data: { id: row.agentPoolId, type: "agent-pools" } } : { data: null },
      "oidc-configuration": { data: row.oidcConfigId !== "" ? { id: row.oidcConfigId, type: row.oidcConfigType } : null },
      "hyok-customer-key-versions": {
        data: keyVersions.map((keyVersion): Record<string, string> => ({ id: keyVersion.id, type: "hyok-customer-key-versions" })),
      },
    },
  };
}

function hyokKeyVersionResource(row: Readonly<typeof hyokCustomerKeyVersions.$inferSelect>): Record<string, unknown> {
  return {
    id: row.id,
    type: "hyok-customer-key-versions",
    attributes: {
      "key-version": row.keyVersion,
      status: row.status,
      "workspaces-secured": row.workspacesSecured,
      error: row.error ?? "",
      "created-at": new Date(row.createdAt).toISOString(),
    },
    relationships: {
      "hyok-configuration": { data: { id: row.hyokConfigId, type: "hyok-configurations" } },
    },
  };
}

function bodyData(body: unknown): { attributes?: Record<string, unknown> | undefined; relationships?: Record<string, unknown> | undefined } {
  if (body === null || typeof body !== "object") return {};
  const data = (body as Record<string, unknown>).data;
  if (data === null || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  return {
    attributes: d.attributes !== null && typeof d.attributes === "object" ? d.attributes as Record<string, unknown> : undefined,
    relationships: d.relationships !== null && typeof d.relationships === "object" ? d.relationships as Record<string, unknown> : undefined,
  };
}

function relId(relationship: unknown): { id: string; type: string } | null {
  if (relationship === null || typeof relationship !== "object") return null;
  const data = (relationship as Record<string, unknown>).data;
  if (data === null || typeof data !== "object") return null;
  const d = data as { id?: unknown; type?: unknown };
  return typeof d.id === "string" ? { id: d.id, type: typeof d.type === "string" ? d.type : "" } : null;
}

export const hyokRoutes = new Elysia({ name: "hyok" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/hyok-configurations", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const rows = await db.query.hyokConfigurations.findMany({ where: eq(hyokConfigurations.orgId, org.id) });
    // One query for every config's key versions instead of one per row.
    // An empty rows list must not run an unfiltered findMany (that would
    // return every key version in the database).
    const keyVersions = rows.length === 0
      ? []
      : await db.query.hyokCustomerKeyVersions.findMany({
          where: inArray(hyokCustomerKeyVersions.hyokConfigId, rows.map((row) => row.id)),
        });
    const keyVersionsByConfig = new Map<string, readonly (typeof hyokCustomerKeyVersions.$inferSelect)[]>();
    for (const kv of keyVersions) {
      const bucket = keyVersionsByConfig.get(kv.hyokConfigId);
      if (bucket === undefined) keyVersionsByConfig.set(kv.hyokConfigId, [kv]);
      else (bucket as (typeof hyokCustomerKeyVersions.$inferSelect)[]).push(kv);
    }
    return { data: await Promise.all(rows.map(async (row) => hyokResource(row, org.name, keyVersionsByConfig))) };
  })
  .post("/api/v2/organizations/:org_name/hyok-configurations", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const { attributes, relationships } = bodyData(body);
    const name = typeof attributes?.name === "string" ? attributes.name : "";
    const kekId = typeof attributes?.["kek-id"] === "string" ? attributes["kek-id"] : "";
    const agentPoolRef = relId(relationships?.["agent-pool"] ?? null);
    const oidcRef = relId(relationships?.["oidc-configuration"] ?? null);
    if (name === "" || kekId === "" || oidcRef === null || oidcRef.id === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "HYOK configuration requires name, kek-id and an oidc-configuration relationship" }] };
    }
    const kms = attributes?.["kms-options"] !== null && typeof attributes?.["kms-options"] === "object"
      ? attributes["kms-options"] as Record<string, string>
      : null;
    const id = `hyok-${crypto.randomUUID()}`;
    const now = Date.now();
    const row: HyokRow = {
      id, orgId: org.id, name, kekId, kmsOptions: kms, agentPoolId: agentPoolRef?.id ?? null,
      oidcConfigId: oidcRef.id, oidcConfigType: oidcRef.type, isPrimary: false, status: "ok", error: null,
      createdAt: now, updatedAt: now,
    };
    await db.insert(hyokConfigurations).values(row);
    // the reference format auto-generates a customer key version (and encrypted data key) when a
    // HYOK configuration is created — the KMS key pair. Mirror that so the
    // hyok key-version data sources have something to read.
    const keyVersionId = `hyokcv-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(hyokCustomerKeyVersions).values({
      id: keyVersionId,
      hyokConfigId: id,
      keyVersion: "1",
      encryptedDek: "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      customerKeyName: kekId,
      status: "active",
      workspacesSecured: 0,
      error: null,
      createdAt: now,
    });
    (set as { status: number }).status = 201;
    return { data: await hyokResource(row, org.name) };
  })
  .get("/api/v2/hyok-configurations/:hyok_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.hyok_id ?? "";
    const row = await db.query.hyokConfigurations.findFirst({ where: eq(hyokConfigurations.id, id) });
    if (row === undefined) return notFound(set);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, row.orgId) });
    if (org === undefined || !(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    return { data: await hyokResource(row, org.name) };
  })
  .patch("/api/v2/hyok-configurations/:id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.id ?? "";
    const row = await db.query.hyokConfigurations.findFirst({ where: eq(hyokConfigurations.id, id) });
    if (row === undefined) return notFound(set);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, row.orgId) });
    if (org === undefined || !(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const { attributes } = bodyData(body);
    const updates: Partial<typeof hyokConfigurations.$inferInsert> = {};
    if (typeof attributes?.name === "string") updates.name = attributes.name;
    if (typeof attributes?.["kek-id"] === "string") updates.kekId = attributes["kek-id"];
    if (attributes?.["kms-options"] !== undefined) updates.kmsOptions = attributes["kms-options"] !== null && typeof attributes["kms-options"] === "object" ? attributes["kms-options"] as Record<string, string> : null;
    if (Object.keys(updates).length > 0) await db.update(hyokConfigurations).set({ ...updates, updatedAt: Date.now() }).where(eq(hyokConfigurations.id, id));
    const updated = await db.query.hyokConfigurations.findFirst({ where: eq(hyokConfigurations.id, id) });
    if (updated === undefined) return notFound(set);
    return { data: await hyokResource(updated, org.name) };
  })
  .delete("/api/v2/hyok-configurations/:id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const id = params.id ?? "";
    const row = await db.query.hyokConfigurations.findFirst({ where: eq(hyokConfigurations.id, id) });
    if (row === undefined) return notFound(set);
    if (!(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    await db.delete(hyokConfigurations).where(eq(hyokConfigurations.id, id));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/hyok-customer-key-versions/:key_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    // go-tfe HYOKCustomerKeyVersions.Read — the tfe_hyok_customer_key_version data source.
    const keyVersion = await db.query.hyokCustomerKeyVersions.findFirst({ where: eq(hyokCustomerKeyVersions.id, params.key_id ?? "") });
    if (keyVersion === undefined) return notFound(set);
    const hyok = await db.query.hyokConfigurations.findFirst({ where: eq(hyokConfigurations.id, keyVersion.hyokConfigId) });
    if (hyok === undefined || !(await checkOrganizationPermission(hyok.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    return { data: hyokKeyVersionResource(keyVersion) };
  })
  .get("/api/v2/hyok-encrypted-data-keys/:key_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    // go-tfe HYOKEncryptedDataKeys.Read — the tfe_hyok_encrypted_data_key data source.
    const keyVersion = await db.query.hyokCustomerKeyVersions.findFirst({ where: eq(hyokCustomerKeyVersions.id, params.key_id ?? "") });
    if (keyVersion === undefined) return notFound(set);
    const hyok = await db.query.hyokConfigurations.findFirst({ where: eq(hyokConfigurations.id, keyVersion.hyokConfigId) });
    if (hyok === undefined || !(await checkOrganizationPermission(hyok.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    return {
      data: {
        id: keyVersion.id,
        type: "hyok-encrypted-data-keys",
        attributes: {
          "encrypted-dek": keyVersion.encryptedDek,
          "customer-key-name": keyVersion.customerKeyName,
          "created-at": new Date(keyVersion.createdAt).toISOString(),
        },
        relationships: {
          "hyok-customer-key-versions": { data: { id: keyVersion.id, type: "hyok-customer-key-versions" } },
        },
      },
    };
  });
;