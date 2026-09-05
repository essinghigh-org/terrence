import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { getSettings } from "../../lib/settings";
import { refreshTrustedClientIpHeaders } from "../../lib/client-ip";
import { ldapSettings } from "../../lib/sso";
import { invalidatePingSsoCache } from "../health";
import type { ParamCtx } from "./types";
import { withAuthSettingsLock, updateSettings, settingResource, currentSamlSettings, authLockoutResponse } from "./helpers";
export const settingsRoutes = new Elysia({ name: "admin-settings" })
  .use(authPlugin)
  .get("/api/v2/admin/settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return settingResource("settings", await getSettings("site"));
  })
  .patch("/api/v2/admin/settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    return settingResource("settings", await updateSettings("site", attrs));
  })
  // --- B.1 General Settings ---
  .get("/api/v2/admin/general-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return settingResource("general-settings", await getSettings("general"));
  })
  .patch("/api/v2/admin/general-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return withAuthSettingsLock(async (): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const current = await getSettings("general");
    if (attrs["local-signup-enabled"] !== undefined && attrs["local-signup-enabled"] !== null && typeof attrs["local-signup-enabled"] !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "local-signup-enabled must be a boolean or null to use the environment setting" }] };
    }
    if (attrs["local-auth-enabled"] !== undefined && typeof attrs["local-auth-enabled"] !== "boolean") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "local-auth-enabled must be a boolean" }] };
    }
    if (attrs["trusted-client-ip-headers"] !== undefined
      && attrs["trusted-client-ip-headers"] !== null
      && (!Array.isArray(attrs["trusted-client-ip-headers"])
        || !(attrs["trusted-client-ip-headers"] as unknown[]).every((name: unknown): boolean => typeof name === "string"))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "trusted-client-ip-headers must be an array of header names (highest priority first)" }] };
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
      oidc: oidc["enabled"] === true,
      ldap: ldap.enabled,
    }, localAuthEnabled);
    if (authError !== null) return authError;
    const updated = await updateSettings("general", attrs);
    await refreshTrustedClientIpHeaders();
    invalidatePingSsoCache();
    return settingResource("general-settings", updated);
    });
  })
  // --- B.2 Data Retention Policy Settings ---
  .get("/api/v2/admin/data-retention-policy-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const values = await getSettings("retention");
    if (values["delete-older-than-n-days"] === null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return settingResource("data-retention-policy-settings", values);
  })
  .post("/api/v2/admin/data-retention-policy-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const days = typeof attrs["delete-older-than-n-days"] === "number" ? attrs["delete-older-than-n-days"] : null;
    const values = await updateSettings("retention", { "delete-older-than-n-days": days });
    (set as { status: number }).status = 201;
    return settingResource("data-retention-policy-settings", values);
  })
  .delete("/api/v2/admin/data-retention-policy-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await updateSettings("retention", { "delete-older-than-n-days": null });
    (set as { status: number }).status = 204;
    return {};
  });
