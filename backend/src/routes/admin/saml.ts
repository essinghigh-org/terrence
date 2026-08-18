import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { organizations, samlSettings, adminSettings } from "../../db/schema";
import { eq } from "drizzle-orm";
import { getSettings, invalidateSettingsCache } from "../../lib/settings";
import { ldapSettings } from "../../lib/sso";
import { invalidatePingSsoCache } from "../health";
import type { ParamCtx } from "./types";
import { SAML_SETTINGS_ID, withAuthSettingsLock, currentSamlSettings, authLockoutResponse, samlSettingsResource, samlInput } from "./helpers";
export const samlRoutes = new Elysia({ name: "admin-saml" })
  .use(authPlugin)
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
    if (data.type !== undefined && data.type !== "" && data.type !== "saml-settings" && data.type !== "admin-saml-settings") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `data.type must be saml-settings (got ${String(data.type)})` }] };
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
    const [oidcEnabled, ldapEnabledForSso] = await Promise.all([
      getSettings("oidc").then((settings): boolean => settings.enabled === true),
      ldapSettings().then((settings): boolean => settings.enabled),
    ]);
    const authError = await authLockoutResponse(set, {
      saml: input.values.enabled === true,
      oidc: oidcEnabled,
      ldap: ldapEnabledForSso,
    });
    if (authError !== null) return authError;
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.update(samlSettings).set(input.values).where(eq(samlSettings.id, SAML_SETTINGS_ID));
      if (input.values.enabled !== current.enabled) {
        await t.update(organizations).set({ samlEnabled: input.values.enabled });
      }
      // The companion link-by-email setting must land atomically with the
      // SAML row: a partial write could leave SAML enabled while the linking
      // policy silently reverts, or vice versa.
      const linkRow = await t.query.adminSettings.findFirst({ where: eq(adminSettings.id, "saml") });
      const linkValues = { ...(linkRow?.values ?? { "link-by-email": false }), "link-by-email": linkByEmail };
      await t.insert(adminSettings).values({ id: "saml", values: linkValues, updatedAt: Date.now() })
        .onConflictDoUpdate({ target: adminSettings.id, set: { values: linkValues, updatedAt: Date.now() } });
    });
    invalidateSettingsCache();
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
  });
