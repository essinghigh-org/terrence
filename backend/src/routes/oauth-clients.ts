import { Elysia } from "elysia";
import { db } from "../db";
import { oauthClients, oauthTokens, organizations } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrgPermission, serviceProviderDisplayName } from "../lib/utils";
import { authPlugin } from "../auth";

export const oauthClientRoutes = new Elysia({ name: "oauthClients" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/oauth-clients", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const clientList = await db.query.oauthClients.findMany({ where: eq(oauthClients.orgId, org.id) });
    return { data: clientList.map(oc => ({ id: oc.id, type: "oauth-clients", attributes: { name: oc.name, "service-provider": oc.serviceProvider, "service-provider-display-name": serviceProviderDisplayName(oc.serviceProvider), "api-url": oc.apiUrl, "http-url": oc.httpUrl, "rsa-public-key": oc.rsaPublicKey } })) };
  })
  .post("/api/v2/organizations/:org_name/oauth-clients", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `oc-${crypto.randomUUID()}`;
    await db.insert(oauthClients).values({ id, orgId: org.id, name: attributes.name, serviceProvider: attributes["service-provider"] ?? "github", apiUrl: attributes["api-url"] ?? null, httpUrl: attributes["http-url"] ?? null, key: attributes.key ?? null, secret: attributes.secret ?? null, rsaPublicKey: attributes["rsa-public-key"] ?? null, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "oauth-clients", attributes: { name: attributes.name, "service-provider": attributes["service-provider"] ?? "github", "service-provider-display-name": serviceProviderDisplayName(attributes["service-provider"] ?? "github"), "api-url": attributes["api-url"] ?? null, "http-url": attributes["http-url"] ?? null, "rsa-public-key": attributes["rsa-public-key"] ?? null } } };
  })
  .get("/api/v2/oauth-clients/:oc_id", async ({ params: { oc_id }, user, orgId: tokenOrgId, set }) => {
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: oc.id, type: "oauth-clients", attributes: { name: oc.name, "service-provider": oc.serviceProvider, "service-provider-display-name": serviceProviderDisplayName(oc.serviceProvider), "api-url": oc.apiUrl, "http-url": oc.httpUrl, "rsa-public-key": oc.rsaPublicKey } } };
  })
  .patch("/api/v2/oauth-clients/:oc_id", async ({ params: { oc_id }, body, user, orgId: tokenOrgId, set }) => {
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof oauthClients.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["service-provider"] === "string") updates.serviceProvider = attributes["service-provider"];
    if (attributes["api-url"] !== undefined) updates.apiUrl = attributes["api-url"];
    if (attributes["http-url"] !== undefined) updates.httpUrl = attributes["http-url"];
    if (attributes.key !== undefined) updates.key = attributes.key;
    if (attributes.secret !== undefined) updates.secret = attributes.secret;
    if (attributes["rsa-public-key"] !== undefined) updates.rsaPublicKey = attributes["rsa-public-key"];
    if (Object.keys(updates).length > 0) await db.update(oauthClients).set(updates).where(eq(oauthClients.id, oc_id));
    const updated = (await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) }))!;
    return { data: { id: updated.id, type: "oauth-clients", attributes: { name: updated.name, "service-provider": updated.serviceProvider, "service-provider-display-name": serviceProviderDisplayName(updated.serviceProvider), "api-url": updated.apiUrl, "http-url": updated.httpUrl, "rsa-public-key": updated.rsaPublicKey } } };
  })
  .delete("/api/v2/oauth-clients/:oc_id", async ({ params: { oc_id }, user, orgId: tokenOrgId, set }) => {
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(oauthClients).where(eq(oauthClients.id, oc_id));
    set.status = 204;
  })
  .get("/api/v2/oauth-clients/:oc_id/oauth-tokens", async ({ params: { oc_id }, user, orgId: tokenOrgId, set }) => {
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tokenList = await db.query.oauthTokens.findMany({ where: eq(oauthTokens.oauthClientId, oc_id) });
    return { data: tokenList.map(ot => ({ id: ot.id, type: "oauth-tokens", attributes: { "service-provider-user": ot.serviceProviderUser, "has-ssh-key": ot.hasSshKey, "created-at": new Date(ot.createdAt).toISOString() } })) };
  })
  .get("/api/v2/oauth-tokens/:ot_id", async ({ params: { ot_id }, user, orgId: tokenOrgId, set }) => {
    const ot = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, ot_id) });
    if (!ot) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ot.oauthClientId) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ot.id, type: "oauth-tokens", attributes: { "service-provider-user": ot.serviceProviderUser, "has-ssh-key": ot.hasSshKey, "created-at": new Date(ot.createdAt).toISOString() } } };
  })
  .delete("/api/v2/oauth-tokens/:ot_id", async ({ params: { ot_id }, user, orgId: tokenOrgId, set }) => {
    const ot = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, ot_id) });
    if (!ot) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ot.oauthClientId) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(oauthTokens).where(eq(oauthTokens.id, ot_id));
    set.status = 204;
  });
