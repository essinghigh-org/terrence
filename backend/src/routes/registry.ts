// @ts-nocheck
import { Elysia } from "elysia";
import { db } from "../db";
import { registryModules, registryModuleVersions, registryProviders, registryProviderVersions, registryProviderPlatforms, organizations } from "../db/schema";
import { eq, and, desc, like, or } from "drizzle-orm";
import { checkOrgPermission } from "../lib/utils";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";

const CV_STORAGE_DIR = join(process.env.STORAGE_DIR || join(import.meta.dir, "../storage"), "cv");

export const registryRoutes = new Elysia({ name: "registry" })
  // --- Module Registry Protocol ---
  .get("/api/registry/v1/modules/:namespace/:name/:provider/versions", async ({ params: { namespace, name, provider }, set }) => {
    const mod = await db.query.registryModules.findFirst({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)) });
    if (!mod) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const verList = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, mod.id) });
    return { modules: [{ versions: verList.map(v => ({ version: v.version })) }] };
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider/:version", async ({ params: { namespace, name, provider, version }, set }) => {
    const mod = await db.query.registryModules.findFirst({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)) });
    if (!mod) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { id: `${namespace}/${name}/${provider}/${version}`, owner: namespace, namespace, name, provider, version: ver.version, status: ver.status, download_url: `/api/registry/v1/modules/${namespace}/${name}/${provider}/${version}/download` };
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider/:version/download", async ({ params: { namespace, name, provider, version }, set }) => {
    const mod = await db.query.registryModules.findFirst({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)) });
    if (!mod) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryModuleVersions.findFirst({ where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    set.headers["X-Terraform-Get"] = `/api/registry/v1/modules/${namespace}/${name}/${provider}/${version}/archive`;
    set.status = 204;
  })
  .get("/api/registry/v1/modules/:namespace/:name", async ({ params: { namespace, name }, set }) => {
    const mods = await db.query.registryModules.findMany({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name)) });
    if (mods.length === 0) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { modules: mods.map(m => ({ id: `${namespace}/${name}/${m.provider}`, owner: namespace, namespace, name, provider: m.provider, versions: [] })) };
  })
  .get("/api/registry/v1/modules/:namespace/:name/:provider", async ({ params: { namespace, name, provider }, set }) => {
    const mod = await db.query.registryModules.findFirst({ where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)) });
    if (!mod) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const verList = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, mod.id), orderBy: [desc(registryModuleVersions.createdAt)] });
    const latestVersion = verList[0]?.version || "0.0.0";
    return { id: `${namespace}/${name}/${provider}/${latestVersion}`, owner: namespace, namespace, name, provider, version: latestVersion, status: verList[0]?.status || "pending", versions: verList.map(v => ({ version: v.version })) };
  })
  .get("/api/registry/v1/modules/:namespace", async ({ params: { namespace } }) => {
    const mods = await db.query.registryModules.findMany({ where: eq(registryModules.namespace, namespace) });
    return { modules: await Promise.all(mods.map(async m => { const verList = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, m.id), orderBy: [desc(registryModuleVersions.createdAt)] }); return { id: `${m.namespace}/${m.name}/${m.provider}`, owner: m.namespace, namespace: m.namespace, name: m.name, provider: m.provider, version: verList[0]?.version || null, versions: verList.map(v => ({ version: v.version })) }; })) };
  })
  .get("/api/registry/v1/modules", async ({ query }) => {
    const searchQuery = ((query as any)?.q || "").trim();
    let mods: (typeof registryModules.$inferSelect)[];
    if (searchQuery) { mods = await db.query.registryModules.findMany({ where: or(like(registryModules.name, `%${searchQuery}%`), like(registryModules.namespace, `%${searchQuery}%`), like(registryModules.provider, `%${searchQuery}%`)), limit: 50 }); }
    else { mods = await db.query.registryModules.findMany({ limit: 50 }); }
    return { modules: await Promise.all(mods.map(async m => { const verList = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, m.id), orderBy: [desc(registryModuleVersions.createdAt)] }); return { id: `${m.namespace}/${m.name}/${m.provider}`, owner: m.namespace, namespace: m.namespace, name: m.name, provider: m.provider, version: verList[0]?.version || null, versions: verList.map(v => ({ version: v.version })) }; })) };
  })
  // --- Provider Registry Protocol ---
  .get("/api/registry/v1/providers/-/versions", async ({ query }) => {
    const searchQuery = ((query as any)?.q || "").trim();
    let provs: (typeof registryProviders.$inferSelect)[];
    if (searchQuery) { provs = await db.query.registryProviders.findMany({ where: or(like(registryProviders.namespace, `%${searchQuery}%`), like(registryProviders.type, `%${searchQuery}%`)), limit: 50 }); }
    else { provs = await db.query.registryProviders.findMany({ limit: 50 }); }
    const versions = await Promise.all(provs.map(async p => { const verList = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, p.id), orderBy: [desc(registryProviderVersions.createdAt)] }); return { id: `${p.namespace}/${p.type}`, namespace: p.namespace, versions: verList.map(v => ({ version: v.version, protocols: v.protocols ?? ["5.0"], platforms: [] })) }; }));
    return { versions };
  })
  .get("/api/registry/v1/providers/:namespace/:type/versions", async ({ params: { namespace, type } }) => {
    const prov = await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.namespace, namespace), eq(registryProviders.type, type)) });
    if (!prov) { return { versions: [] }; }
    const verList = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, prov.id) });
    const versions = await Promise.all(verList.map(async v => { const platList = await db.query.registryProviderPlatforms.findMany({ where: eq(registryProviderPlatforms.versionId, v.id) }); return { version: v.version, protocols: v.protocols ?? ["5.0"], platforms: platList.map(p => ({ os: p.os, arch: p.arch })) }; }));
    return { versions };
  })
  .get("/api/registry/v1/providers/:namespace/:type/:version/download/:os/:arch", async ({ params: { namespace, type, version, os, arch }, set }) => {
    const prov = await db.query.registryProviders.findFirst({ where: and(eq(registryProviders.namespace, namespace), eq(registryProviders.type, type)) });
    if (!prov) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryProviderVersions.findFirst({ where: and(eq(registryProviderVersions.providerId, prov.id), eq(registryProviderVersions.version, version)) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const plat = await db.query.registryProviderPlatforms.findFirst({ where: and(eq(registryProviderPlatforms.versionId, ver.id), eq(registryProviderPlatforms.os, os), eq(registryProviderPlatforms.arch, arch)) });
    if (!plat) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { protocols: ver.protocols ?? ["5.0"], os: plat.os, arch: plat.arch, filename: plat.filename, download_url: plat.downloadUrl, shasum: plat.shasum };
  })
  // --- Module Management API (TFE v2) ---
  .get("/api/v2/organizations/:org_name/registry-modules", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const modList = await db.query.registryModules.findMany({ where: eq(registryModules.orgId, org.id) });
    return { data: modList.map(m => ({ id: m.id, type: "registry-modules", attributes: { name: m.name, provider: m.provider, namespace: m.namespace, "created-at": new Date(m.createdAt).toISOString() } })) };
  })
  .post("/api/v2/organizations/:org_name/registry-modules", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || !attributes.provider) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and provider are required" }] }; }
    const id = `mod-${crypto.randomUUID()}`;
    const namespace = attributes.namespace ?? org.name;
    await db.insert(registryModules).values({ id, orgId: org.id, namespace, name: attributes.name, provider: attributes.provider, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "registry-modules", attributes: { name: attributes.name, provider: attributes.provider, namespace, "created-at": new Date().toISOString() } } };
  })
  .delete("/api/v2/registry-modules/:module_id", async ({ params: { module_id }, user, orgId: tokenOrgId, set }) => {
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, module_id) });
    if (!mod || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryModules).where(eq(registryModules.id, module_id));
    set.status = 204;
  })
  // --- Provider Management API (TFE v2) ---
  .get("/api/v2/organizations/:org_name/registry-providers", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const provList = await db.query.registryProviders.findMany({ where: eq(registryProviders.orgId, org.id) });
    return { data: provList.map(p => ({ id: p.id, type: "registry-providers", attributes: { namespace: p.namespace, name: p.type, "registry-name": p.registryName, "created-at": new Date(p.createdAt).toISOString() } })) };
  })
  .post("/api/v2/organizations/:org_name/registry-providers", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name (type) is required" }] }; }
    const id = `prov-${crypto.randomUUID()}`;
    const namespace = attributes.namespace ?? org.name;
    await db.insert(registryProviders).values({ id, orgId: org.id, namespace, type: attributes.name, registryName: attributes["registry-name"] ?? "private", createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "registry-providers", attributes: { namespace, name: attributes.name, "registry-name": attributes["registry-name"] ?? "private", "created-at": new Date().toISOString() } } };
  })
  .delete("/api/v2/registry-providers/:provider_id", async ({ params: { provider_id }, user, orgId: tokenOrgId, set }) => {
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, provider_id) });
    if (!prov || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviders).where(eq(registryProviders.id, provider_id));
    set.status = 204;
  })
  // --- Provider Versions ---
  .get("/api/v2/registry-providers/:provider_id/versions", async ({ params: { provider_id }, user, orgId: tokenOrgId, set }) => {
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, provider_id) });
    if (!prov || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const versions = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, provider_id), orderBy: [desc(registryProviderVersions.createdAt)] });
    return { data: versions.map(v => ({ id: v.id, type: "registry-provider-versions", attributes: { version: v.version, protocols: v.protocols, "shasums-url": v.shasumsUrl, "shasums-signature-url": v.shasumsSignatureUrl, "created-at": new Date(v.createdAt).toISOString() } })) };
  })
  .post("/api/v2/registry-providers/:provider_id/versions", async ({ params: { provider_id }, body, user, orgId: tokenOrgId, set }) => {
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, provider_id) });
    if (!prov || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.version) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version is required" }] }; }
    const id = `provver-${crypto.randomUUID()}`;
    await db.insert(registryProviderVersions).values({ id, providerId: provider_id, version: attributes.version, protocols: attributes.protocols ?? ["5.0"], shasumsUrl: attributes["shasums-url"] ?? null, shasumsSignatureUrl: attributes["shasums-signature-url"] ?? null, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "registry-provider-versions", attributes: { version: attributes.version, protocols: attributes.protocols ?? ["5.0"], "shasums-url": attributes["shasums-url"] ?? null, "shasums-signature-url": attributes["shasums-signature-url"] ?? null, "created-at": new Date().toISOString() } } };
  })
  .delete("/api/v2/registry-provider-versions/:version_id", async ({ params: { version_id }, user, orgId: tokenOrgId, set }) => {
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, version_id) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (!prov || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviderVersions).where(eq(registryProviderVersions.id, version_id));
    set.status = 204;
  })
  // --- Provider Version Platforms ---
  .get("/api/v2/registry-provider-versions/:version_id/platforms", async ({ params: { version_id }, user, orgId: tokenOrgId, set }) => {
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, version_id) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (!prov || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const platforms = await db.query.registryProviderPlatforms.findMany({ where: eq(registryProviderPlatforms.versionId, version_id) });
    return { data: platforms.map(p => ({ id: p.id, type: "registry-provider-platforms", attributes: { os: p.os, arch: p.arch, filename: p.filename, "download-url": p.downloadUrl, shasum: p.shasum } })) };
  })
  .post("/api/v2/registry-provider-versions/:version_id/platforms", async ({ params: { version_id }, body, user, orgId: tokenOrgId, set }) => {
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, version_id) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (!prov || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.os || !attributes.arch || !attributes.filename || !attributes["download-url"] || !attributes.shasum) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "os, arch, filename, download-url, and shasum are required" }] }; }
    const id = `provplat-${crypto.randomUUID()}`;
    await db.insert(registryProviderPlatforms).values({ id, versionId: version_id, os: attributes.os, arch: attributes.arch, filename: attributes.filename, downloadUrl: attributes["download-url"], shasum: attributes.shasum, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "registry-provider-platforms", attributes: { os: attributes.os, arch: attributes.arch, filename: attributes.filename, "download-url": attributes["download-url"], shasum: attributes.shasum } } };
  })
  .delete("/api/v2/registry-provider-platforms/:platform_id", async ({ params: { platform_id }, user, orgId: tokenOrgId, set }) => {
    const platform = await db.query.registryProviderPlatforms.findFirst({ where: eq(registryProviderPlatforms.id, platform_id) });
    if (!platform) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ver = await db.query.registryProviderVersions.findFirst({ where: eq(registryProviderVersions.id, platform.versionId) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, ver.providerId) });
    if (!prov || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryProviderPlatforms).where(eq(registryProviderPlatforms.id, platform_id));
    set.status = 204;
  })
  // --- Module Versions ---
  .get("/api/v2/registry-modules/:module_id/versions", async ({ params: { module_id }, user, orgId: tokenOrgId, set }) => {
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, module_id) });
    if (!mod || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const versions = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, module_id), orderBy: [desc(registryModuleVersions.createdAt)] });
    return { data: versions.map(v => ({ id: v.id, type: "registry-module-versions", attributes: { version: v.version, status: v.status, "created-at": new Date(v.createdAt).toISOString() } })) };
  })
  .post("/api/v2/registry-modules/:module_id/versions", async ({ params: { module_id }, body, user, orgId: tokenOrgId, set }) => {
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, module_id) });
    if (!mod || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.version) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version is required" }] }; }
    const id = `modver-${crypto.randomUUID()}`;
    await db.insert(registryModuleVersions).values({ id, moduleId: module_id, version: attributes.version, status: "pending", createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "registry-module-versions", attributes: { version: attributes.version, status: "pending", "created-at": new Date().toISOString() } } };
  })
  .patch("/api/v2/registry-module-versions/:version_id", async ({ params: { version_id }, body, user, orgId: tokenOrgId, set }) => {
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, version_id) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (!mod || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof registryModuleVersions.$inferInsert> = {};
    if (attributes.status !== undefined) updates.status = attributes.status;
    if (attributes.version !== undefined) updates.version = attributes.version;
    if (Object.keys(updates).length > 0) await db.update(registryModuleVersions).set(updates).where(eq(registryModuleVersions.id, version_id));
    const updated = (await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, version_id) }))!;
    return { data: { id: updated.id, type: "registry-module-versions", attributes: { version: updated.version, status: updated.status, "created-at": new Date(updated.createdAt).toISOString() } } };
  })
  .delete("/api/v2/registry-module-versions/:version_id", async ({ params: { version_id }, user, orgId: tokenOrgId, set }) => {
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, version_id) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (!mod || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryModuleVersions).where(eq(registryModuleVersions.id, version_id));
    set.status = 204;
  })
  // --- Module Version Upload ---
  .put("/api/v2/registry-module-versions/:version_id/upload", async ({ params: { version_id }, request, user, orgId: tokenOrgId, set }) => {
    const ver = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, version_id) });
    if (!ver) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, ver.moduleId) });
    if (!mod || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const archiveName = `registry-module-${version_id}.tar.gz`;
    const archivePath = join(CV_STORAGE_DIR, archiveName);
    await mkdir(CV_STORAGE_DIR, { recursive: true });
    const buffer = await request.arrayBuffer();
    await writeFile(archivePath, Buffer.from(buffer));
    await db.update(registryModuleVersions).set({ archivePath, status: "ok" }).where(eq(registryModuleVersions.id, version_id));
    set.status = 200;
    return { data: { id: version_id, type: "registry-module-versions", attributes: { status: "ok" } } };
  });
