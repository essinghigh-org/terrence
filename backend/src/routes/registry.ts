import { Elysia } from "elysia";
import { db } from "../db";
import { registryModules, registryModuleVersions, registryProviders, registryProviderVersions, registryProviderPlatforms, organizations, type users } from "../db/schema";
import { eq, and, desc, like, or } from "drizzle-orm";
import { checkOrgPermission } from "../lib/utils";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { authPlugin } from "../auth";

const CV_STORAGE_DIR = join(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../storage"), "cv");

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: DeepReadonly<typeof users.$inferSelect> | null;
  readonly orgId?: string | null;
  readonly request: Readonly<{ readonly url: string; readonly arrayBuffer: () => Promise<ArrayBuffer> }>;
  readonly set: SetObj;
}>;

type ModItem = DeepReadonly<typeof registryModules.$inferSelect>;
type ModVerItem = DeepReadonly<typeof registryModuleVersions.$inferSelect>;
type ProvItem = DeepReadonly<typeof registryProviders.$inferSelect>;
type ProvVerItem = DeepReadonly<typeof registryProviderVersions.$inferSelect>;
type PlatItem = DeepReadonly<typeof registryProviderPlatforms.$inferSelect>;

export const registryRoutes = new Elysia({ name: "registry" })
  .use(authPlugin)
  // --- Module Registry Protocol ---
  .get("/api/registry/v1/modules/:namespace/:name/:provider/versions", async ({ params, set }: ParamCtx): Promise<unknown> => {
    const namespace = params["namespace"] ?? "";
    const name = params["name"] ?? "";
    const provider = params["provider"] ?? "";
    const mod = await db.query.registryModules.findFirst({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)) });
    if (mod === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const verList = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, mod.id) });
    return { modules: [{ versions: verList.map((v: ModVerItem): Record<string, string> => ({ version: v.version })) }] };
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider/:version", async ({ params, set }: ParamCtx): Promise<unknown> => {
    const namespace = params["namespace"] ?? "";
    const name = params["name"] ?? "";
    const provider = params["provider"] ?? "";
    const version = params["version"] ?? "";
    const mod = await db.query.registryModules.findFirst({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)) });
    if (mod === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { id: `${namespace}/${name}/${provider}/${version}`, owner: namespace, namespace, name, provider, version: ver.version, status: ver.status, download_url: `/api/registry/v1/modules/${namespace}/${name}/${provider}/${version}/download` };
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider/:version/download", async ({ params, set }: ParamCtx): Promise<unknown> => {
    const namespace = params["namespace"] ?? "";
    const name = params["name"] ?? "";
    const provider = params["provider"] ?? "";
    const version = params["version"] ?? "";
    const mod = await db.query.registryModules.findFirst({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)) });
    if (mod === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    set.headers["X-Terraform-Get"] = `/api/registry/v1/modules/${namespace}/${name}/${provider}/${version}/archive`;
    (set as { status: number }).status = 204;
    return undefined;
  })
  .get("/api/registry/v1/modules/:namespace/:name", async ({ params, set }: ParamCtx): Promise<unknown> => {
    const namespace = params["namespace"] ?? "";
    const name = params["name"] ?? "";
    const mods = await db.query.registryModules.findMany({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name)) });
    if (mods.length === 0) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { modules: mods.map((m: ModItem): Record<string, unknown> => ({ id: `${namespace}/${name}/${m.provider}`, owner: namespace, namespace, name, provider: m.provider, versions: [] })) };
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider", async ({ params, set }: ParamCtx): Promise<unknown> => {
    const namespace = params["namespace"] ?? "";
    const name = params["name"] ?? "";
    const provider = params["provider"] ?? "";
    const mod = await db.query.registryModules.findFirst({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)) });
    if (mod === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const verList = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, mod.id), orderBy: [desc(registryModuleVersions.createdAt)] });
    const latestVersion = verList[0]?.version ?? "0.0.0";
    const status = verList[0]?.status ?? "pending";
    return { id: `${namespace}/${name}/${provider}/${latestVersion}`, owner: namespace, namespace, name, provider, version: latestVersion, status, versions: verList.map((v: ModVerItem): Record<string, string> => ({ version: v.version })) };
  })
  .get("/api/registry/v1/modules/:namespace", async ({ params }: ParamCtx): Promise<unknown> => {
    const namespace = params["namespace"] ?? "";
    const mods = await db.query.registryModules.findMany({ where: eq(registryModules.namespace, namespace) });
    const modules = await Promise.all(mods.map(async (m: ModItem): Promise<Record<string, unknown>> => {
      const verList = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, m.id), orderBy: [desc(registryModuleVersions.createdAt)] });
      return { id: `${m.namespace}/${m.name}/${m.provider}`, owner: m.namespace, namespace: m.namespace, name: m.name, provider: m.provider, version: verList[0]?.version ?? null, versions: verList.map((v: ModVerItem): Record<string, string> => ({ version: v.version })) };
    }));
    return { modules };
  })
  .get("/api/registry/v1/modules", async ({ query }: ParamCtx): Promise<unknown> => {
    const searchQuery = (query?.["q"] ?? "").trim();
    let mods: (typeof registryModules.$inferSelect)[];
    if (searchQuery !== "") {
      mods = await db.query.registryModules.findMany({ where: or(like(registryModules.name, `%${searchQuery}%`), like(registryModules.namespace, `%${searchQuery}%`), like(registryModules.provider, `%${searchQuery}%`)), limit: 50 });
    } else {
      mods = await db.query.registryModules.findMany({ limit: 50 });
    }
    const modules = await Promise.all(mods.map(async (m: ModItem): Promise<Record<string, unknown>> => {
      const verList = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, m.id), orderBy: [desc(registryModuleVersions.createdAt)] });
      return { id: `${m.namespace}/${m.name}/${m.provider}`, owner: m.namespace, namespace: m.namespace, name: m.name, provider: m.provider, version: verList[0]?.version ?? null, versions: verList.map((v: ModVerItem): Record<string, string> => ({ version: v.version })) };
    }));
    return { modules };
  })
  // --- Provider Registry Protocol ---
  .get("/api/registry/v1/providers/-/versions", async ({ query }: ParamCtx): Promise<unknown> => {
    const searchQuery = (query?.["q"] ?? "").trim();
    let provs: (typeof registryProviders.$inferSelect)[];
    if (searchQuery !== "") {
      provs = await db.query.registryProviders.findMany({ where: or(like(registryProviders.namespace, `%${searchQuery}%`), like(registryProviders.type, `%${searchQuery}%`)), limit: 50 });
    } else {
      provs = await db.query.registryProviders.findMany({ limit: 50 });
    }
    const versions = await Promise.all(provs.map(async (p: ProvItem): Promise<Record<string, unknown>> => {
      const verList = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, p.id), orderBy: [desc(registryProviderVersions.createdAt)] });
      return { id: `${p.namespace}/${p.type}`, namespace: p.namespace, versions: verList.map((v: ProvVerItem): Record<string, unknown> => ({ version: v.version, protocols: v.protocols ?? ["5.0"], platforms: [] })) };
    }));
    return { versions };
  })
  .get("/api/registry/v1/providers/:namespace/:type/versions", async ({ params }: ParamCtx): Promise<unknown> => {
    const namespace = params["namespace"] ?? "";
    const type = params["type"] ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.namespace, namespace), eq(registryProviders.type, type)) });
    if (prov === undefined) { return { versions: [] }; }
    const verList = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, prov.id) });
    const versions = await Promise.all(verList.map(async (v: ProvVerItem): Promise<Record<string, unknown>> => {
      const platList = await db.query.registryProviderPlatforms.findMany({ where: eq(registryProviderPlatforms.versionId, v.id) });
      return { version: v.version, protocols: v.protocols ?? ["5.0"], platforms: platList.map((p: PlatItem): Record<string, string> => ({ os: p.os, arch: p.arch })) };
    }));
    return { versions };
  })
  .get("/api/registry/v1/providers/:namespace/:type/:version/download/:os/:arch", async ({ params, set }: ParamCtx): Promise<unknown> => {
    const namespace = params["namespace"] ?? "";
    const type = params["type"] ?? "";
    const version = params["version"] ?? "";
    const os = params["os"] ?? "";
    const arch = params["arch"] ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.namespace, namespace), eq(registryProviders.type, type)) });
    if (prov === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryProviderVersions.findFirst({ where: and(eq(registryProviderVersions.providerId, prov.id), eq(registryProviderVersions.version, version)) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const plat = await db.query.registryProviderPlatforms.findFirst({ where: and(eq(registryProviderPlatforms.versionId, ver.id), eq(registryProviderPlatforms.os, os), eq(registryProviderPlatforms.arch, arch)) });
    if (plat === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { protocols: ver.protocols ?? ["5.0"], os: plat.os, arch: plat.arch, filename: plat.filename, download_url: plat.downloadUrl, shasum: plat.shasum };
  })
  // --- Module Management API (TFE v2) ---
  .get("/api/v2/organizations/:org_name/registry-modules", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const modList = await db.query.registryModules.findMany({ where: eq(registryModules.orgId, org.id) });
    return { data: modList.map((m: ModItem): Record<string, unknown> => ({ id: m.id, type: "registry-modules", attributes: { name: m.name, provider: m.provider, namespace: m.namespace, "created-at": new Date(m.createdAt).toISOString() } })) };
  })
  .post("/api/v2/organizations/:org_name/registry-modules", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    const provider = typeof attributes.provider === "string" ? attributes.provider : "";
    if (name === "" || provider === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and provider are required" }] }; }
    const id = `mod-${crypto.randomUUID()}`;
    const namespace = typeof attributes.namespace === "string" ? attributes.namespace : org.name;
    await db.insert(registryModules).values({ id, orgId: org.id, namespace, name, provider, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "registry-modules", attributes: { name, provider, namespace, "created-at": new Date().toISOString() } } };
  })
  .delete("/api/v2/registry-modules/:module_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const moduleId = params["module_id"] ?? "";
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
    if (mod === undefined || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryModules).where(eq(registryModules.id, moduleId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Provider Management API (TFE v2) ---
  .get("/api/v2/organizations/:org_name/registry-providers", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const provList = await db.query.registryProviders.findMany({ where: eq(registryProviders.orgId, org.id) });
    return { data: provList.map((p: ProvItem): Record<string, unknown> => ({ id: p.id, type: "registry-providers", attributes: { namespace: p.namespace, name: p.type, "registry-name": p.registryName, "created-at": new Date(p.createdAt).toISOString() } })) };
  })
  .post("/api/v2/organizations/:org_name/registry-providers", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name (type) is required" }] }; }
    const id = `prov-${crypto.randomUUID()}`;
    const namespace = typeof attributes.namespace === "string" ? attributes.namespace : org.name;
    const registryName = typeof attributes["registry-name"] === "string" ? attributes["registry-name"] : "private";
    await db.insert(registryProviders).values({ id, orgId: org.id, namespace, type: name, registryName, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "registry-providers", attributes: { namespace, name, "registry-name": registryName, "created-at": new Date().toISOString() } } };
  })
  .delete("/api/v2/registry-providers/:provider_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const providerId = params["provider_id"] ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, providerId) });
    if (prov === undefined || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviders).where(eq(registryProviders.id, providerId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Provider Versions ---
  .get("/api/v2/registry-providers/:provider_id/versions", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const providerId = params["provider_id"] ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, providerId) });
    if (prov === undefined || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const versions = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, providerId), orderBy: [desc(registryProviderVersions.createdAt)] });
    return { data: versions.map((v: ProvVerItem): Record<string, unknown> => ({ id: v.id, type: "registry-provider-versions", attributes: { version: v.version, protocols: v.protocols, "shasums-url": v.shasumsUrl, "shasums-signature-url": v.shasumsSignatureUrl, "created-at": new Date(v.createdAt).toISOString() } })) };
  })
  .post("/api/v2/registry-providers/:provider_id/versions", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const providerId = params["provider_id"] ?? "";
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, providerId) });
    if (prov === undefined || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const version = typeof attributes.version === "string" ? attributes.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version is required" }] }; }
    const id = `provver-${crypto.randomUUID()}`;
    const protocols = Array.isArray(attributes.protocols) ? (attributes.protocols as string[]) : ["5.0"];
    const shasumsUrl = typeof attributes["shasums-url"] === "string" ? attributes["shasums-url"] : null;
    const shasumsSignatureUrl = typeof attributes["shasums-signature-url"] === "string" ? attributes["shasums-signature-url"] : null;
    await db.insert(registryProviderVersions).values({ id, providerId, version, protocols, shasumsUrl, shasumsSignatureUrl, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "registry-provider-versions", attributes: { version, protocols, "shasums-url": shasumsUrl, "shasums-signature-url": shasumsSignatureUrl, "created-at": new Date().toISOString() } } };
  })
  .delete("/api/v2/registry-provider-versions/:version_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params["version_id"] ?? "";
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (prov === undefined || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviderVersions).where(eq(registryProviderVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Provider Version Platforms ---
  .get("/api/v2/registry-provider-versions/:version_id/platforms", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (prov === undefined || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const platforms = await db.query.registryProviderPlatforms.findMany({ where: eq(registryProviderPlatforms.versionId, versionId) });
    return { data: platforms.map((p: PlatItem): Record<string, unknown> => ({ id: p.id, type: "registry-provider-platforms", attributes: { os: p.os, arch: p.arch, filename: p.filename, "download-url": p.downloadUrl, shasum: p.shasum } })) };
  })
  .post("/api/v2/registry-provider-versions/:version_id/platforms", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (prov === undefined || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const os = typeof attributes.os === "string" ? attributes.os : "";
    const arch = typeof attributes.arch === "string" ? attributes.arch : "";
    const filename = typeof attributes.filename === "string" ? attributes.filename : "";
    const downloadUrl = typeof attributes["download-url"] === "string" ? attributes["download-url"] : "";
    const shasum = typeof attributes.shasum === "string" ? attributes.shasum : "";
    if (os === "" || arch === "" || filename === "" || downloadUrl === "" || shasum === "") {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "os, arch, filename, download-url, and shasum are required" }] };
    }
    const id = `provplat-${crypto.randomUUID()}`;
    await db.insert(registryProviderPlatforms).values({ id, versionId, os, arch, filename, downloadUrl, shasum, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "registry-provider-platforms", attributes: { os, arch, filename, "download-url": downloadUrl, shasum } } };
  })
  .delete("/api/v2/registry-provider-platforms/:platform_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const platformId = params["platform_id"] ?? "";
    const platform = await db.query.registryProviderPlatforms.findFirst({ where: eq(registryProviderPlatforms.id, platformId) });
    if (platform === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, platform.versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (prov === undefined || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviderPlatforms).where(eq(registryProviderPlatforms.id, platformId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Module Versions ---
  .get("/api/v2/registry-modules/:module_id/versions", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const moduleId = params["module_id"] ?? "";
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
    if (mod === undefined || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const versions = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, moduleId), orderBy: [desc(registryModuleVersions.createdAt)] });
    return { data: versions.map((v: ModVerItem): Record<string, unknown> => ({ id: v.id, type: "registry-module-versions", attributes: { version: v.version, status: v.status, "created-at": new Date(v.createdAt).toISOString() } })) };
  })
  .post("/api/v2/registry-modules/:module_id/versions", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const moduleId = params["module_id"] ?? "";
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, moduleId) });
    if (mod === undefined || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const version = typeof attributes.version === "string" ? attributes.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version is required" }] }; }
    const id = `modver-${crypto.randomUUID()}`;
    await db.insert(registryModuleVersions).values({ id, moduleId, version, status: "pending", createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "registry-module-versions", attributes: { version, status: "pending", "created-at": new Date().toISOString() } } };
  })
  .patch("/api/v2/registry-module-versions/:version_id", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (mod === undefined || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof registryModuleVersions.$inferInsert> = {};
    if (typeof attributes.status === "string") updates.status = attributes.status;
    if (typeof attributes.version === "string") updates.version = attributes.version;
    if (Object.keys(updates).length > 0) await db.update(registryModuleVersions).set(updates).where(eq(registryModuleVersions.id, versionId));
    const updated = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "registry-module-versions", attributes: { version: updated.version, status: updated.status, "created-at": new Date(updated.createdAt).toISOString() } } };
  })
  .delete("/api/v2/registry-module-versions/:version_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params["version_id"] ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (mod === undefined || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryModuleVersions).where(eq(registryModuleVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Module Version Upload ---
  .put("/api/v2/registry-module-versions/:version_id/upload", async ({ params, request, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionId) });
    if (ver === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (mod === undefined || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const archiveName = `registry-module-${versionId}.tar.gz`;
    const archivePath = join(CV_STORAGE_DIR, archiveName);
    await mkdir(CV_STORAGE_DIR, { recursive: true });
    const buffer = await request.arrayBuffer();
    await writeFile(archivePath, Buffer.from(buffer));
    await db.update(registryModuleVersions).set({ archivePath, status: "ok" }).where(eq(registryModuleVersions.id, versionId));
    (set as { status: number }).status = 200;
    return { data: { id: versionId, type: "registry-module-versions", attributes: { status: "ok" } } };
  });
