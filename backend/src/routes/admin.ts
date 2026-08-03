import { Elysia } from "elysia";
import { db } from "../db";
import { users, organizations, workspaces, runs, adminTerraformVersions, adminSentinelVersions, adminOpaVersions, registryPartnerships, samlSettings, adminSettings, apiTokens } from "../db/schema";
import type { SQL } from "drizzle-orm";
import { eq, and, or, desc, count, notInArray, like } from "drizzle-orm";
import { runResource } from "../lib/response";
import { getSettings, type Settings } from "../lib/settings";
import { ldapSettings } from "../lib/sso";
import { apiURL, FINAL_RUN_STATUSES, pageRequest, pagination } from "../lib/utils";
import { isUniqueConstraintError } from "../lib/validation";
import { authPlugin } from "../auth";
import * as bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { invalidatePingSsoCache } from "./health";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: Readonly<typeof users.$inferSelect> | null;
  readonly token?: Readonly<{ id: string }> | null;
  readonly request: Readonly<{ url: string }>;
  readonly set: SetObj;
}>;

type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type UserItem = DeepReadonly<typeof users.$inferSelect>;
type OrgItem = DeepReadonly<typeof organizations.$inferSelect>;
type WsItem = DeepReadonly<typeof workspaces.$inferSelect>;
type RunItem = DeepReadonly<typeof runs.$inferSelect>;
type VerItem = Readonly<{
  readonly id: string;
  readonly version: string;
  readonly url: string | null;
  readonly sha: string | null;
  readonly isDefault: boolean | null;
  readonly deprecated: boolean | null;
}>;
type SamlSettings = Readonly<typeof samlSettings.$inferSelect>;

const SAML_SETTINGS_ID = "saml";
const OIDC_SIGNING_ALGORITHMS = new Set([
  "HS256", "HS384", "HS512",
  "RS256", "RS384", "RS512",
  "ES256", "ES384", "ES512",
  "PS256", "PS384", "PS512",
]);
const SAML_DEFAULTS = {
  id: SAML_SETTINGS_ID,
  enabled: false,
  debug: false,
  oldIdpCert: null,
  idpCert: null,
  idpEntityId: null,
  sloEndpointUrl: null,
  ssoEndpointUrl: null,
  attrUsername: "Username",
  attrEmail: "email",
  attrGroups: "MemberOf",
  attrSiteAdmin: "SiteAdmin",
  siteAdminRole: "site-admins",
  ssoApiTokenSessionTimeout: 1_209_600,
  updatedAt: 0,
} satisfies typeof samlSettings.$inferInsert;

// ponytail: one Bun process is the deployment model; use a database row lock if horizontal scaling is added.
let authSettingsQueue = Promise.resolve();

async function withAuthSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = authSettingsQueue;
  let release!: () => void;
  authSettingsQueue = new Promise<void>((resolve): void => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function updateSettings(group: string, attrs: Settings): Promise<Settings> {
  const current = await getSettings(group);
  const values = { ...current };
  for (const key of Object.keys(attrs)) if (key in current) values[key] = attrs[key];
  await db.insert(adminSettings).values({ id: group, values, updatedAt: Date.now() }).onConflictDoUpdate({ target: adminSettings.id, set: { values, updatedAt: Date.now() } });
  return values;
}

function settingResource(id: string, values: Settings): Record<string, unknown> {
  return { data: { id, type: id === "settings" ? "settings" : id, attributes: values } };
}

function oidcSettingsResource(values: Settings): Record<string, unknown> {
  const safe = { ...values };
  const clientSecret = safe["client-secret"];
  delete safe["client-secret"];
  return settingResource("oidc-settings", {
    ...safe,
    "client-secret-set": typeof clientSecret === "string" && clientSecret !== "",
  });
}

async function currentSamlSettings(): Promise<SamlSettings> {
  const existing = await db.query.samlSettings.findFirst({ where: eq(samlSettings.id, SAML_SETTINGS_ID) });
  if (existing !== undefined) return existing;
  await db.insert(samlSettings).values(SAML_DEFAULTS).onConflictDoNothing();
  const settings = await db.query.samlSettings.findFirst({ where: eq(samlSettings.id, SAML_SETTINGS_ID) });
  if (settings === undefined) throw new Error("SAML settings are unavailable");
  return settings;
}

async function authLockoutResponse(
  set: SetObj,
  methods: Readonly<{ saml: boolean; oidc: boolean; ldap: boolean }>,
  localAuthEnabled?: boolean,
): Promise<{ errors: { status: string; title: string; detail: string }[] } | null> {
  const localAuth = localAuthEnabled ?? (await getSettings("general"))["local-auth-enabled"] !== false;
  if (localAuth || methods.saml || methods.oidc || methods.ldap) return null;
  (set as { status: number }).status = 422;
  return {
    errors: [{
      status: "422",
      title: "Unprocessable Entity",
      detail: "At least one authentication method must remain enabled",
    }],
  };
}

function samlSettingsResource(
  settings: SamlSettings,
  request: Readonly<{ url: string }>,
  linkByEmail = false,
): Record<string, unknown> {
  return {
    id: SAML_SETTINGS_ID,
    type: "saml-settings",
    attributes: {
      enabled: settings.enabled,
      debug: settings.debug,
      "old-idp-cert": settings.oldIdpCert,
      "idp-cert": settings.idpCert,
      "idp-entity-id": settings.idpEntityId,
      "slo-endpoint-url": settings.sloEndpointUrl,
      "sso-endpoint-url": settings.ssoEndpointUrl,
      "attr-username": settings.attrUsername,
      "attr-email": settings.attrEmail,
      "attr-groups": settings.attrGroups,
      "attr-site-admin": settings.attrSiteAdmin,
      "site-admin-role": settings.siteAdminRole,
      "sso-api-token-session-timeout": settings.ssoApiTokenSessionTimeout,
      "link-by-email": linkByEmail,
      "acs-consumer-url": apiURL(request, "/users/saml/auth"),
      "metadata-url": apiURL(request, "/users/saml/metadata"),
    },
  };
}

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function validOidcIssuer(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function normalizeIssuer(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value.trim();
  }
}

function samlInput(
  attributes: Readonly<Record<string, unknown>>,
  current: SamlSettings,
): Readonly<{ values: typeof samlSettings.$inferInsert }> | Readonly<{ error: string }> {
  for (const key of ["enabled", "debug"] as const) {
    if (attributes[key] !== undefined && typeof attributes[key] !== "boolean") {
      return { error: `${key} must be a boolean` };
    }
  }
  for (const key of [
    "idp-cert",
    "idp-entity-id",
    "slo-endpoint-url",
    "sso-endpoint-url",
    "attr-username",
    "attr-email",
    "attr-groups",
    "attr-site-admin",
    "site-admin-role",
  ] as const) {
    if (attributes[key] !== undefined && attributes[key] !== null && typeof attributes[key] !== "string") {
      return { error: `${key} must be a string or null` };
    }
  }
  const timeout = attributes["sso-api-token-session-timeout"];
  if (timeout !== undefined && !(typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout >= 0)) {
    return { error: "sso-api-token-session-timeout must be a non-negative integer" };
  }

  const nullableString = (key: "idp-cert" | "idp-entity-id" | "slo-endpoint-url" | "sso-endpoint-url", fallback: string | null): string | null =>
    attributes[key] === undefined ? fallback : typeof attributes[key] === "string" ? attributes[key].trim() : null;
  const requiredString = (
    key: "attr-username" | "attr-email" | "attr-groups" | "attr-site-admin" | "site-admin-role",
    fallback: string,
  ): string => attributes[key] === undefined ? fallback : typeof attributes[key] === "string" ? attributes[key].trim() : "";

  const idpCert = nullableString("idp-cert", current.idpCert);
  const idpEntityId = nullableString("idp-entity-id", current.idpEntityId);
  const sloEndpointUrl = nullableString("slo-endpoint-url", current.sloEndpointUrl);
  const ssoEndpointUrl = nullableString("sso-endpoint-url", current.ssoEndpointUrl);
  const attrUsername = requiredString("attr-username", current.attrUsername);
  const attrEmail = requiredString("attr-email", current.attrEmail);
  const attrGroups = requiredString("attr-groups", current.attrGroups);
  const attrSiteAdmin = requiredString("attr-site-admin", current.attrSiteAdmin);
  const siteAdminRole = requiredString("site-admin-role", current.siteAdminRole);
  const enabled = typeof attributes.enabled === "boolean" ? attributes.enabled : current.enabled;

  if (idpCert !== null && (
    !idpCert.includes("-----BEGIN CERTIFICATE-----")
    || !idpCert.includes("-----END CERTIFICATE-----")
  )) return { error: "idp-cert must be a PEM encoded X.509 certificate" };
  if (sloEndpointUrl !== null && !validHttpsUrl(sloEndpointUrl)) return { error: "slo-endpoint-url must be an HTTPS URL" };
  if (ssoEndpointUrl !== null && !validHttpsUrl(ssoEndpointUrl)) return { error: "sso-endpoint-url must be an HTTPS URL" };
  if (attrUsername === "" || attrEmail === "" || attrGroups === "" || attrSiteAdmin === "" || siteAdminRole === "") {
    return { error: "attr-username, attr-email, attr-groups, attr-site-admin, and site-admin-role must not be empty" };
  }
  if (enabled && (idpCert === null || idpEntityId === null || idpEntityId === "" || ssoEndpointUrl === null)) {
    return { error: "idp-cert, idp-entity-id, and sso-endpoint-url are required when SAML is enabled" };
  }

  return {
    values: {
      id: SAML_SETTINGS_ID,
      enabled,
      debug: typeof attributes.debug === "boolean" ? attributes.debug : current.debug,
      oldIdpCert: idpCert !== null && idpCert !== current.idpCert && current.idpCert !== null
        ? current.idpCert
        : current.oldIdpCert,
      idpCert,
      idpEntityId,
      sloEndpointUrl,
      ssoEndpointUrl,
      attrUsername,
      attrEmail,
      attrGroups,
      attrSiteAdmin,
      siteAdminRole,
      ssoApiTokenSessionTimeout: typeof timeout === "number" ? timeout : current.ssoApiTokenSessionTimeout,
      updatedAt: Date.now(),
    },
  };
}

function gravatarUrl(email: string | null | undefined): string {
  const addr = (email ?? "").trim().toLowerCase();
  // Use a simple hash via built-in SHA-256 if available, otherwise fall back to a deterministic placeholder
  const hash = addr === "" ? "00000000000000000000000000000000" : Array.from(
    new Uint8Array(
      // Synchronous fallback: encode manually
      // We use a btoa-based digest approximation; for correctness we compute MD5-style hex of email
      // Since we cannot do crypto.subtle synchronously here, use a djb2 hex stretch
      ((): ArrayBuffer => {
        let h = 5381;
        for (let i = 0; i < addr.length; i++) h = ((h * 33) ^ addr.charCodeAt(i)) >>> 0;
        const buf = new Uint8Array(16);
        for (let i = 0; i < 16; i++) { buf[i] = (h >> (i % 4 * 8)) & 0xff; }
        return buf.buffer;
      })()
    )
  ).map((b: number): string => b.toString(16).padStart(2, "0")).join("");
  return `https://www.gravatar.com/avatar/${hash}?s=80&d=identicon`;
}

function adminUserResource(u: UserItem): Record<string, unknown> {
  return {
    id: u.id,
    type: "users",
    attributes: {
      username: u.username,
      email: u.email,
      "is-site-admin": u.isSiteAdmin === true,
      "is-admin": u.isSiteAdmin === true,
      "is-site-auditor": (u as Record<string, unknown>).isSiteAuditor === true,
      "is-suspended": (u as Record<string, unknown>).isSuspended === true,
      "avatar-url": gravatarUrl(u.email),
    },
  };
}

function adminOrganizationResource(org: OrgItem): Record<string, unknown> {
  return {
    id: org.id,
    type: "organizations",
    attributes: {
      name: org.name,
      "global-module-sharing": org.globalModuleSharing,
      "global-provider-sharing": org.globalProviderSharing,
      "saml-enabled": org.samlEnabled,
      "owners-team-saml-role-id": org.ownersTeamSamlRoleId,
    },
  };
}

async function clearSpecificRegistrySharing(orgId: string, kind: "modules" | "providers"): Promise<void> {
  const rows = await db.query.registryPartnerships.findMany({ where: eq(registryPartnerships.producerOrgId, orgId) });
  for (const row of rows) {
    const otherEnabled = kind === "modules" ? row.providers : row.modules;
    if (otherEnabled) {
      await db.update(registryPartnerships)
        .set(kind === "modules" ? { modules: false } : { providers: false })
        .where(eq(registryPartnerships.id, row.id));
    } else {
      await db.delete(registryPartnerships).where(eq(registryPartnerships.id, row.id));
    }
  }
}

export const adminRoutes = new Elysia({ name: "admin" })
  .use(authPlugin)
  .get("/api/v2/admin/users", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const url = new URL(request.url);
    const filterAdmin = url.searchParams.get("filter[admin]");
    const filterSuspended = url.searchParams.get("filter[suspended]");
    const q = url.searchParams.get("q") ?? "";
    const { number, size } = pageRequest(request);
    const conditions: SQL[] = [];
    if (filterAdmin === "true") conditions.push(eq(users.isSiteAdmin, true));
    if (filterAdmin === "false") conditions.push(eq(users.isSiteAdmin, false));
    if (filterSuspended === "true") conditions.push(eq((users as unknown as Record<string, unknown>).isSuspended as Parameters<typeof eq>[0], true));
    if (filterSuspended === "false") conditions.push(eq((users as unknown as Record<string, unknown>).isSuspended as Parameters<typeof eq>[0], false));
    if (q !== "") {
      const pattern = `%${q}%`;
      conditions.push(or(like(users.username, pattern), like(users.email ?? users.username, pattern)) as SQL); // eslint-disable-line @typescript-eslint/non-nullable-type-assertion-style
    }
    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
    const [allUsers, countRows] = await Promise.all([
      db.query.users.findMany({ where, limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(users).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: allUsers.map((u: UserItem) => adminUserResource(u)), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/admin/users", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const username = typeof attrs.username === "string" ? attrs.username.trim() : "";
    const email = typeof attrs.email === "string" ? attrs.email.trim() : null;
    const password = typeof attrs.password === "string" ? attrs.password : "";
    const isSiteAdmin = attrs["is-site-admin"] === true;

    if (username === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username is required" }] };
    }
    if (password.length < 10) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Password must be at least 10 characters" }] };
    }

    const existing = await db.query.users.findFirst({ where: eq(users.username, username) });
    if (existing !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = `user-${crypto.randomUUID()}`;

    try {
      await db.insert(users).values({ id, username, email, passwordHash, isSiteAdmin });
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
      }
      throw e;
    }

    const created = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (created === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    (set as { status: number }).status = 201;
    return { data: adminUserResource(created) };
  })
  .get("/api/v2/admin/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params.user_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminUserResource(targetUser) };
  })
  .patch("/api/v2/admin/users/:user_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params.user_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof users.$inferInsert> = {};
    if (typeof attributes.username === "string") updates.username = attributes.username;
    if (typeof attributes.email === "string") updates.email = attributes.email;
    if (Object.keys(updates).length > 0) await db.update(users).set(updates).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminUserResource(updated) };
  })
  .delete("/api/v2/admin/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const userId = params.user_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(users).where(eq(users.id, userId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- User Actions ---
  .post("/api/v2/admin/users/:user_id/actions/suspend", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>).isSuspended === true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is already suspended" }] }; }
    await db.update(users).set({ isSuspended: true }).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/unsuspend", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>).isSuspended !== true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is not suspended" }] }; }
    await db.update(users).set({ isSuspended: false }).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/grant_admin", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.isSiteAdmin === true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is already a site admin" }] }; }
    await db.update(users).set({ isSiteAdmin: true }).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/revoke_admin", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.isSiteAdmin !== true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is not a site admin" }] }; }
    await db.update(users).set({ isSiteAdmin: false }).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/grant_site_auditor", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>).isSiteAuditor === true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is already a site auditor" }] }; }
    await db.update(users).set({ isSiteAuditor: true }).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/revoke_site_auditor", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>).isSiteAuditor !== true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is not a site auditor" }] }; }
    await db.update(users).set({ isSiteAuditor: false }).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/impersonate", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.id === user.id || target.isSiteAdmin === true) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "This user cannot be impersonated" }] };
    }
    if ((target as Record<string, unknown>).isSuspended === true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "User not found" }] };
    }
    const rawToken = `imp-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    await db.insert(apiTokens).values({
      id: `token-${crypto.randomUUID()}`,
      token: createHash("sha256").update(rawToken).digest("hex"),
      userId: target.id,
      description: `Impersonation by ${user.username}`,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    return { data: { type: "authentication-tokens", attributes: { token: rawToken, "expires-at": new Date(Date.now() + 15 * 60 * 1000).toISOString(), "user-id": target.id } } };
  })
  .get("/api/v2/admin/organizations", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allOrgs = await db.query.organizations.findMany();
    return { data: allOrgs.map(adminOrganizationResource) };
  })
  .get("/api/v2/admin/organizations/:org_name", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminOrganizationResource(org) };
  })
  .patch("/api/v2/admin/organizations/:org_name", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
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
    const updated = await db.query.organizations.findFirst({ where: eq(organizations.id, org.id) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminOrganizationResource(updated) };
  })
  .delete("/api/v2/admin/organizations/:org_name", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params.org_name ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(organizations).where(eq(organizations.id, org.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/admin/workspaces", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allWs = await db.query.workspaces.findMany();
    return { data: allWs.map((w: WsItem): Record<string, unknown> => ({ id: w.id, type: "workspaces", attributes: { name: w.name, "terraform-version": w.terraformVersion, locked: w.locked } })) };
  })
  .get("/api/v2/admin/workspaces/:ws_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const wsId = params.ws_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ws.id, type: "workspaces", attributes: { name: ws.name, "terraform-version": ws.terraformVersion, locked: ws.locked } } };
  })
  .patch("/api/v2/admin/workspaces/:ws_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const wsId = params.ws_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof workspaces.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["terraform-version"] === "string") updates.terraformVersion = attributes["terraform-version"];
    if (typeof attributes.locked === "boolean") updates.locked = attributes.locked;
    if (Object.keys(updates).length > 0) await db.update(workspaces).set(updates).where(eq(workspaces.id, wsId));
    const updated = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "workspaces", attributes: { name: updated.name, "terraform-version": updated.terraformVersion, locked: updated.locked } } };
  })
  .delete("/api/v2/admin/workspaces/:ws_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const wsId = params.ws_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/admin/runs", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const activeRuns = await db.query.runs.findMany({
      where: notInArray(runs.status, FINAL_RUN_STATUSES),
      orderBy: [desc(runs.createdAt)],
    });
    return {
      data: activeRuns.map((r: RunItem): Record<string, unknown> => ({
        id: r.id,
        type: "runs",
        attributes: {
          status: r.status,
          message: r.message,
          "created-at": new Date(r.createdAt).toISOString(),
          actions: {
            "is-cancelable": true,
            "is-force-cancelable": true,
          },
        },
      })),
    };
  })
  .get("/api/v2/admin/runs/:run_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: runResource(run, true) };
  })
  .post("/api/v2/admin/runs/:run_id/actions/cancel", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, FINAL_RUN_STATUSES))).returning();
    if (updated.length === 0 || updated[0] === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] }; }
    return { data: runResource(updated[0], true) };
  })
  .post("/api/v2/admin/runs/:run_id/actions/force-cancel", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "force_canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, FINAL_RUN_STATUSES))).returning();
    if (updated.length === 0 || updated[0] === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] }; }
    return { data: runResource(updated[0], true) };
  })
  // --- Terraform Versions ---
  .get("/api/v2/admin/terraform-versions", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, countRows] = await Promise.all([
      db.query.adminTerraformVersions.findMany({ orderBy: [desc(adminTerraformVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminTerraformVersions),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: versions.map((v: VerItem): Record<string, unknown> => ({ id: v.id, type: "terraform-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } })), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/admin/terraform-versions", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const version = typeof attrs.version === "string" ? attrs.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version is required" }] }; }
    const id = `tfver-${crypto.randomUUID()}`;
    const url = typeof attrs.url === "string" ? attrs.url : null;
    const sha = typeof attrs.sha === "string" ? attrs.sha : null;
    const deprecated = typeof attrs.deprecated === "boolean" ? attrs.deprecated : false;
    const isDefault = typeof attrs.default === "boolean" ? attrs.default : false;
    await db.insert(adminTerraformVersions).values({ id, version, url, sha, deprecated, isDefault, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "terraform-versions", attributes: { version, url, sha, default: isDefault, deprecated } } };
  })
  .get("/api/v2/admin/terraform-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: v.id, type: "terraform-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } } };
  })
  .patch("/api/v2/admin/terraform-versions/:version_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof adminTerraformVersions.$inferInsert> = {};
    if (typeof attrs.version === "string") updates.version = attrs.version;
    if (attrs.url !== undefined) updates.url = typeof attrs.url === "string" ? attrs.url : null;
    if (attrs.sha !== undefined) updates.sha = typeof attrs.sha === "string" ? attrs.sha : null;
    if (typeof attrs.deprecated === "boolean") updates.deprecated = attrs.deprecated;
    if (typeof attrs.default === "boolean") updates.isDefault = attrs.default;
    if (Object.keys(updates).length > 0) await db.update(adminTerraformVersions).set(updates).where(eq(adminTerraformVersions.id, versionId));
    const updated = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "terraform-versions", attributes: { version: updated.version, url: updated.url, sha: updated.sha, default: updated.isDefault, deprecated: updated.deprecated } } };
  })
  .delete("/api/v2/admin/terraform-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminTerraformVersions).where(eq(adminTerraformVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Sentinel Versions ---
  .get("/api/v2/admin/sentinel-versions", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, countRows] = await Promise.all([
      db.query.adminSentinelVersions.findMany({ orderBy: [desc(adminSentinelVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminSentinelVersions),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: versions.map((v: VerItem): Record<string, unknown> => ({ id: v.id, type: "sentinel-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } })), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/admin/sentinel-versions", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const version = typeof attrs.version === "string" ? attrs.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `sver-${crypto.randomUUID()}`;
    const url = typeof attrs.url === "string" ? attrs.url : null;
    const sha = typeof attrs.sha === "string" ? attrs.sha : null;
    const deprecated = typeof attrs.deprecated === "boolean" ? attrs.deprecated : false;
    const isDefault = typeof attrs.default === "boolean" ? attrs.default : false;
    await db.insert(adminSentinelVersions).values({ id, version, url, sha, deprecated, isDefault, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "sentinel-versions", attributes: { version, url, sha, default: isDefault, deprecated } } };
  })
  .get("/api/v2/admin/sentinel-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: v.id, type: "sentinel-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } } };
  })
  .patch("/api/v2/admin/sentinel-versions/:version_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof adminSentinelVersions.$inferInsert> = {};
    if (typeof attrs.version === "string") updates.version = attrs.version;
    if (attrs.url !== undefined) updates.url = typeof attrs.url === "string" ? attrs.url : null;
    if (attrs.sha !== undefined) updates.sha = typeof attrs.sha === "string" ? attrs.sha : null;
    if (typeof attrs.deprecated === "boolean") updates.deprecated = attrs.deprecated;
    if (typeof attrs.default === "boolean") updates.isDefault = attrs.default;
    if (Object.keys(updates).length > 0) await db.update(adminSentinelVersions).set(updates).where(eq(adminSentinelVersions.id, versionId));
    const updated = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "sentinel-versions", attributes: { version: updated.version, url: updated.url, sha: updated.sha, default: updated.isDefault, deprecated: updated.deprecated } } };
  })
  .delete("/api/v2/admin/sentinel-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminSentinelVersions).where(eq(adminSentinelVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- OPA Versions ---
  .get("/api/v2/admin/opa-versions", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, countRows] = await Promise.all([
      db.query.adminOpaVersions.findMany({ orderBy: [desc(adminOpaVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminOpaVersions),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: versions.map((v: VerItem): Record<string, unknown> => ({ id: v.id, type: "opa-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } })), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/admin/opa-versions", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const version = typeof attrs.version === "string" ? attrs.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `opa-${crypto.randomUUID()}`;
    const url = typeof attrs.url === "string" ? attrs.url : null;
    const sha = typeof attrs.sha === "string" ? attrs.sha : null;
    const deprecated = typeof attrs.deprecated === "boolean" ? attrs.deprecated : false;
    const isDefault = typeof attrs.default === "boolean" ? attrs.default : false;
    await db.insert(adminOpaVersions).values({ id, version, url, sha, deprecated, isDefault, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "opa-versions", attributes: { version, url, sha, default: isDefault, deprecated } } };
  })
  .get("/api/v2/admin/opa-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: v.id, type: "opa-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } } };
  })
  .patch("/api/v2/admin/opa-versions/:version_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof adminOpaVersions.$inferInsert> = {};
    if (typeof attrs.version === "string") updates.version = attrs.version;
    if (attrs.url !== undefined) updates.url = typeof attrs.url === "string" ? attrs.url : null;
    if (attrs.sha !== undefined) updates.sha = typeof attrs.sha === "string" ? attrs.sha : null;
    if (typeof attrs.deprecated === "boolean") updates.deprecated = attrs.deprecated;
    if (typeof attrs.default === "boolean") updates.isDefault = attrs.default;
    if (Object.keys(updates).length > 0) await db.update(adminOpaVersions).set(updates).where(eq(adminOpaVersions.id, versionId));
    const updated = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "opa-versions", attributes: { version: updated.version, url: updated.url, sha: updated.sha, default: updated.isDefault, deprecated: updated.deprecated } } };
  })
  .delete("/api/v2/admin/opa-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminOpaVersions).where(eq(adminOpaVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- SAML Settings ---
  .get("/api/v2/admin/saml-settings", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const [settings, linkSettings] = await Promise.all([currentSamlSettings(), getSettings("saml")]);
    return { data: samlSettingsResource(settings, request, linkSettings["link-by-email"] === true) };
  })
  .patch("/api/v2/admin/saml-settings", async ({ user, body, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return withAuthSettingsLock(async (): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object"
      ? payload.data as Record<string, unknown>
      : {};
    if (data.type !== undefined && data.type !== "saml-settings") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be saml-settings" }] };
    }
    const attributes = data.attributes !== null && typeof data.attributes === "object"
      ? data.attributes as Record<string, unknown>
      : {};
    const current = await currentSamlSettings();
    const currentLinkSettings = await getSettings("saml");
    if (attributes["link-by-email"] !== undefined && typeof attributes["link-by-email"] !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "link-by-email must be a boolean" }] };
    }
    const linkByEmail = attributes["link-by-email"] === undefined
      ? currentLinkSettings["link-by-email"] === true
      : attributes["link-by-email"] === true;
    const input = samlInput(attributes, current);
    if ("error" in input) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: input.error }] };
    }
    const authError = await authLockoutResponse(set, {
      saml: input.values.enabled === true,
      oidc: (await getSettings("oidc")).enabled === true,
      ldap: (await ldapSettings()).enabled,
    });
    if (authError !== null) return authError;
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.update(samlSettings).set(input.values).where(eq(samlSettings.id, SAML_SETTINGS_ID));
      if (input.values.enabled !== current.enabled) {
        await t.update(organizations).set({ samlEnabled: input.values.enabled });
      }
    });
    await updateSettings("saml", { "link-by-email": linkByEmail });
    invalidatePingSsoCache();
    return { data: samlSettingsResource(await currentSamlSettings(), request, linkByEmail) };
    });
  })
  .post("/api/v2/admin/saml-settings/actions/revoke-old-certificate", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await currentSamlSettings();
    await db.update(samlSettings).set({ oldIdpCert: null, updatedAt: Date.now() })
      .where(eq(samlSettings.id, SAML_SETTINGS_ID));
    const [settings, linkSettings] = await Promise.all([currentSamlSettings(), getSettings("saml")]);
    return { data: samlSettingsResource(settings, request, linkSettings["link-by-email"] === true) };
  })
  // --- Admin Settings ---
  .get("/api/v2/admin/settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return settingResource("settings", await getSettings("site"));
  })
  .patch("/api/v2/admin/settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    return settingResource("settings", await updateSettings("site", attrs));
  })
  // --- B.1 General Settings ---
  .get("/api/v2/admin/general-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return settingResource("general-settings", await getSettings("general"));
  })
  .patch("/api/v2/admin/general-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return withAuthSettingsLock(async (): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const current = await getSettings("general");
    if (attrs["local-auth-enabled"] !== undefined && typeof attrs["local-auth-enabled"] !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "local-auth-enabled must be a boolean" }] };
    }
    const localAuthEnabled = typeof attrs["local-auth-enabled"] === "boolean"
      ? attrs["local-auth-enabled"]
      : current["local-auth-enabled"] !== false;
    const [saml, oidc, ldap] = await Promise.all([
      currentSamlSettings(),
      getSettings("oidc"),
      ldapSettings(),
    ]);
    const authError = await authLockoutResponse(set, {
      saml: saml.enabled === true,
      oidc: oidc.enabled === true,
      ldap: ldap.enabled,
    }, localAuthEnabled);
    if (authError !== null) return authError;
    const updated = await updateSettings("general", attrs);
    invalidatePingSsoCache();
    return settingResource("general-settings", updated);
    });
  })
  // --- B.2 Data Retention Policy Settings ---
  .get("/api/v2/admin/data-retention-policy-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const values = await getSettings("retention");
    if (values["delete-older-than-n-days"] === null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return settingResource("data-retention-policy-settings", values);
  })
  .post("/api/v2/admin/data-retention-policy-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const days = typeof attrs["delete-older-than-n-days"] === "number" ? attrs["delete-older-than-n-days"] : null;
    const values = await updateSettings("retention", { "delete-older-than-n-days": days });
    (set as { status: number }).status = 201;
    return settingResource("data-retention-policy-settings", values);
  })
  .delete("/api/v2/admin/data-retention-policy-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    await updateSettings("retention", { "delete-older-than-n-days": null });
    (set as { status: number }).status = 204;
    return {};
  })
  // --- B.3 Cost Estimation Settings ---
  .get("/api/v2/admin/cost-estimation-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return settingResource("cost-estimation-settings", await getSettings("cost"));
  })
  .patch("/api/v2/admin/cost-estimation-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    return settingResource("cost-estimation-settings", await updateSettings("cost", attrs));
  })
  // --- B.5 SMTP Settings ---
  .get("/api/v2/admin/smtp-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return settingResource("smtp-settings", await getSettings("smtp"));
  })
  .patch("/api/v2/admin/smtp-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    return settingResource("smtp-settings", await updateSettings("smtp", attrs));
  })
  // --- B.6 Twilio Settings ---
  .get("/api/v2/admin/twilio-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return settingResource("twilio-settings", await getSettings("twilio"));
  })
  .patch("/api/v2/admin/twilio-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    return settingResource("twilio-settings", await updateSettings("twilio", attrs));
  })
  // --- B.7 Customization Settings ---
  .get("/api/v2/admin/customization-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return settingResource("customization-settings", await getSettings("customization"));
  })
  .patch("/api/v2/admin/customization-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    return settingResource("customization-settings", await updateSettings("customization", attrs));
  })
  // --- B.8 OIDC Settings ---
  .get("/api/v2/admin/oidc-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return oidcSettingsResource(await getSettings("oidc"));
  })
  .patch("/api/v2/admin/oidc-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return withAuthSettingsLock(async (): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};

    const current = await getSettings("oidc");
    if (attrs.enabled !== undefined && typeof attrs.enabled !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "enabled must be a boolean" }] };
    }
    if (attrs["link-by-email"] !== undefined && typeof attrs["link-by-email"] !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "link-by-email must be a boolean" }] };
    }
    for (const key of ["issuer", "client-id", "client-secret", "scopes", "pkce-method", "signing-alg"] as const) {
      if (attrs[key] !== undefined && attrs[key] !== null && typeof attrs[key] !== "string") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `${key} must be a string or null` }] };
      }
    }
    const enabled = typeof attrs.enabled === "boolean" ? attrs.enabled : current.enabled === true;
    const issuerValue = attrs.issuer === undefined
      ? current.issuer
      : typeof attrs.issuer === "string" ? attrs.issuer.trim() : null;
    const clientId = attrs["client-id"] === undefined
      ? current["client-id"]
      : typeof attrs["client-id"] === "string" ? attrs["client-id"].trim() : null;
    const issuer = typeof issuerValue === "string" && issuerValue !== "" ? normalizeIssuer(issuerValue) : issuerValue;
    if (enabled && (typeof issuer !== "string" || issuer === "" || typeof clientId !== "string" || clientId === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "issuer and client-id are required when OIDC is enabled" }] };
    }
    if (typeof issuer === "string" && issuer !== "") {
      if (!validOidcIssuer(issuer)) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "issuer must be a valid URL" }] };
      }
    }
    const pkce = attrs["pkce-method"] === undefined ? current["pkce-method"] : attrs["pkce-method"];
    if (pkce !== null && pkce !== undefined && pkce !== "" && pkce !== "S256" && pkce !== "none") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "pkce-method must be \"S256\", \"none\", or null" }] };
    }

    const signingAlgInput = attrs["signing-alg"] === undefined ? current["signing-alg"] : attrs["signing-alg"];
    const signingAlg = signingAlgInput === null || signingAlgInput === undefined
      ? null
      : typeof signingAlgInput === "string" && signingAlgInput.trim() !== "" ? signingAlgInput.trim() : null;
    if (signingAlg !== null && !OIDC_SIGNING_ALGORITHMS.has(signingAlg)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "signing-alg must be a supported ID token algorithm or null" }] };
    }

    const authError = await authLockoutResponse(set, {
      saml: (await currentSamlSettings()).enabled,
      oidc: enabled,
      ldap: (await ldapSettings()).enabled,
    });
    if (authError !== null) return authError;

    const clientSecret = attrs["client-secret"] === null
      ? null
      : typeof attrs["client-secret"] === "string" && attrs["client-secret"] !== ""
        ? attrs["client-secret"]
        : current["client-secret"];
    if (enabled && signingAlg?.startsWith("HS") === true && (typeof clientSecret !== "string" || clientSecret === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "a client secret is required for symmetric signing algorithms" }] };
    }
    const updated = await updateSettings("oidc", {
      ...attrs,
      issuer,
      "client-id": clientId,
      "client-secret": clientSecret,
      "pkce-method": pkce === "" ? null : pkce,
      "signing-alg": signingAlg,
    });
    invalidatePingSsoCache();
    return oidcSettingsResource(updated);
    });
  })
  // --- B.9 LDAP Settings ---
  .get("/api/v2/admin/ldap-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    // bind-password is write-only: never return its value to the dashboard.
    const values = await getSettings("ldap");
    const { "bind-password": bindPassword, ...safe } = values;
    return settingResource("ldap-settings", {
      ...safe,
      "bind-password-set": typeof bindPassword === "string" && bindPassword !== "",
    });
  })
  .patch("/api/v2/admin/ldap-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return withAuthSettingsLock(async (): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};

    const current = await getSettings("ldap");
    for (const key of ["enabled", "link-by-email"] as const) {
      if (attrs[key] !== undefined && typeof attrs[key] !== "boolean") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `${key} must be a boolean` }] };
      }
    }
    for (const key of ["host", "bind-dn", "bind-password", "base-dn", "user-filter", "attr-username", "attr-email", "attr-display-name"] as const) {
      if (attrs[key] !== undefined && attrs[key] !== null && typeof attrs[key] !== "string") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `${key} must be a string or null` }] };
      }
    }
    const port = attrs.port === undefined ? current.port : attrs.port;
    if (!(typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "port must be an integer between 1 and 65535" }] };
    }
    const encryption = attrs.encryption === undefined ? current.encryption : attrs.encryption;
    if (encryption !== "plain" && encryption !== "starttls" && encryption !== "ldaps") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "encryption must be one of plain, starttls, ldaps" }] };
    }
    const enabled = typeof attrs.enabled === "boolean" ? attrs.enabled : current.enabled === true;
    const host = attrs.host === null ? null : typeof attrs.host === "string" ? attrs.host.trim() : current.host;
    const baseDn = attrs["base-dn"] === null ? null : typeof attrs["base-dn"] === "string" ? attrs["base-dn"].trim() : current["base-dn"];
    const attrUsername = attrs["attr-username"] === null
      ? ""
      : typeof attrs["attr-username"] === "string" ? attrs["attr-username"].trim() : typeof current["attr-username"] === "string" ? current["attr-username"] : "uid";
    const attrEmail = attrs["attr-email"] === null
      ? ""
      : typeof attrs["attr-email"] === "string" ? attrs["attr-email"].trim() : typeof current["attr-email"] === "string" ? current["attr-email"] : "mail";
    if (enabled && (typeof host !== "string" || host === "" || typeof baseDn !== "string" || baseDn === "" || attrUsername === "" || attrEmail === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "host, base-dn, attr-username, and attr-email are required when LDAP is enabled" }] };
    }
    // A bind DN without a password performs an unauthenticated (anonymous)
    // bind per RFC 4511 §4.2; reject the misconfiguration up front rather
    // than silently downgrading at login time.
    // A blank or whitespace-only bind DN means "no service account"; storing
    // it as a string would make authenticateLdap require a bind password
    // forever, and a padded one would be validated trimmed but persisted raw.
    const bindDn = typeof attrs["bind-dn"] === "string"
      ? (attrs["bind-dn"].trim() === "" ? null : attrs["bind-dn"].trim())
      : attrs["bind-dn"] === null ? null : current["bind-dn"];
    const bindPassword = attrs["bind-password"] === undefined ? current["bind-password"] : attrs["bind-password"];
    if (typeof bindDn === "string" && bindDn !== "" && (typeof bindPassword !== "string" || bindPassword === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "bind-password is required when bind-dn is set" }] };
    }
    const userFilter = typeof attrs["user-filter"] === "string" && attrs["user-filter"] !== ""
      ? attrs["user-filter"]
      : typeof current["user-filter"] === "string" && current["user-filter"] !== ""
        ? current["user-filter"]
        : "(uid={{username}})";
    if (!userFilter.includes("{{username}}")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "user-filter must contain the {{username}} placeholder" }] };
    }

    const authError = await authLockoutResponse(set, {
      saml: (await currentSamlSettings()).enabled,
      oidc: (await getSettings("oidc")).enabled === true,
      ldap: enabled === true,
    });
    if (authError !== null) return authError;

    const updated = await updateSettings("ldap", {
      ...attrs,
      encryption,
      "attr-username": attrUsername,
      "attr-email": attrEmail,
      ...(attrs.host === undefined ? {} : { host }),
      ...(attrs["base-dn"] === undefined ? {} : { "base-dn": baseDn }),
      ...(attrs["bind-dn"] === undefined ? {} : { "bind-dn": bindDn }),
      "user-filter": userFilter,
    });
    const { "bind-password": updatedBindPassword, ...safeUpdated } = updated;
    invalidatePingSsoCache();
    return settingResource("ldap-settings", {
      ...safeUpdated,
      "bind-password-set": typeof updatedBindPassword === "string" && updatedBindPassword !== "",
    });
    });
  });
