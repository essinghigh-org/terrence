import { Elysia } from "elysia";
import { db } from "../db";
import { oauthClients, oauthTokens, organizations, type users } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrgPermission, serviceProviderDisplayName } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  set: SetObj;
}>;

type OcItem = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly serviceProvider: string;
  readonly apiUrl: string | null;
  readonly httpUrl: string | null;
  readonly rsaPublicKey: string | null;
}>;

type OtItem = Readonly<{
  readonly id: string;
  readonly serviceProviderUser: string | null;
  readonly hasSshKey: boolean;
  readonly createdAt: number;
}>;

export const oauthClientRoutes = new Elysia({ name: "oauthClients" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/oauth-clients", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const clientList = await db.query.oauthClients.findMany({ where: eq(oauthClients.orgId, org.id) });
    return { data: clientList.map((oc: OcItem): Record<string, unknown> => ({ id: oc.id, type: "oauth-clients", attributes: { name: oc.name, "service-provider": oc.serviceProvider, "service-provider-display-name": serviceProviderDisplayName(oc.serviceProvider), "api-url": oc.apiUrl, "http-url": oc.httpUrl, "rsa-public-key": oc.rsaPublicKey } })) };
  })
  .post("/api/v2/organizations/:org_name/oauth-clients", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `oc-${crypto.randomUUID()}`;
    const serviceProvider = typeof attributes["service-provider"] === "string" ? attributes["service-provider"] : "github";
    const apiUrl = typeof attributes["api-url"] === "string" ? attributes["api-url"] : null;
    const httpUrl = typeof attributes["http-url"] === "string" ? attributes["http-url"] : null;
    const key = typeof attributes.key === "string" ? attributes.key : null;
    const secret = typeof attributes.secret === "string" ? attributes.secret : null;
    const rsaPublicKey = typeof attributes["rsa-public-key"] === "string" ? attributes["rsa-public-key"] : null;
    await db.insert(oauthClients).values({ id, orgId: org.id, name, serviceProvider, apiUrl, httpUrl, key, secret, rsaPublicKey, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "oauth-clients", attributes: { name, "service-provider": serviceProvider, "service-provider-display-name": serviceProviderDisplayName(serviceProvider), "api-url": apiUrl, "http-url": httpUrl, "rsa-public-key": rsaPublicKey } } };
  })
  .get("/api/v2/oauth-clients/:oc_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const ocId = params["oc_id"] ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: oc.id, type: "oauth-clients", attributes: { name: oc.name, "service-provider": oc.serviceProvider, "service-provider-display-name": serviceProviderDisplayName(oc.serviceProvider), "api-url": oc.apiUrl, "http-url": oc.httpUrl, "rsa-public-key": oc.rsaPublicKey } } };
  })
  .patch("/api/v2/oauth-clients/:oc_id", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const ocId = params["oc_id"] ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof oauthClients.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["service-provider"] === "string") updates.serviceProvider = attributes["service-provider"];
    if (attributes["api-url"] !== undefined) updates.apiUrl = typeof attributes["api-url"] === "string" ? attributes["api-url"] : null;
    if (attributes["http-url"] !== undefined) updates.httpUrl = typeof attributes["http-url"] === "string" ? attributes["http-url"] : null;
    if (attributes.key !== undefined) updates.key = typeof attributes.key === "string" ? attributes.key : null;
    if (attributes.secret !== undefined) updates.secret = typeof attributes.secret === "string" ? attributes.secret : null;
    if (attributes["rsa-public-key"] !== undefined) updates.rsaPublicKey = typeof attributes["rsa-public-key"] === "string" ? attributes["rsa-public-key"] : null;
    if (Object.keys(updates).length > 0) await db.update(oauthClients).set(updates).where(eq(oauthClients.id, ocId));
    const updated = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "oauth-clients", attributes: { name: updated.name, "service-provider": updated.serviceProvider, "service-provider-display-name": serviceProviderDisplayName(updated.serviceProvider), "api-url": updated.apiUrl, "http-url": updated.httpUrl, "rsa-public-key": updated.rsaPublicKey } } };
  })
  .delete("/api/v2/oauth-clients/:oc_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const ocId = params["oc_id"] ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(oauthClients).where(eq(oauthClients.id, ocId));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/oauth-clients/:oc_id/oauth-tokens", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const ocId = params["oc_id"] ?? "";
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ocId) });
    if (oc === undefined || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tokenList = await db.query.oauthTokens.findMany({ where: eq(oauthTokens.oauthClientId, ocId) });
    return { data: tokenList.map((ot: OtItem): Record<string, unknown> => ({ id: ot.id, type: "oauth-tokens", attributes: { "service-provider-user": ot.serviceProviderUser, "has-ssh-key": ot.hasSshKey, "created-at": new Date(ot.createdAt).toISOString() } })) };
  })
  .get("/api/v2/oauth-tokens/:ot_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const otId = params["ot_id"] ?? "";
    const ot = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, otId) });
    if (ot === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ot.oauthClientId) });
    if (oc === undefined || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ot.id, type: "oauth-tokens", attributes: { "service-provider-user": ot.serviceProviderUser, "has-ssh-key": ot.hasSshKey, "created-at": new Date(ot.createdAt).toISOString() } } };
  })
  .delete("/api/v2/oauth-tokens/:ot_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const otId = params["ot_id"] ?? "";
    const ot = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, otId) });
    if (ot === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ot.oauthClientId) });
    if (oc === undefined || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(oauthTokens).where(eq(oauthTokens.id, otId));
    (set as { status: number }).status = 204;
    return {};
  });
