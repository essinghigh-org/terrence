import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { getSettings } from "../../lib/settings";
import { ldapSettings } from "../../lib/sso";
import { invalidatePingSsoCache } from "../health";
import type { ParamCtx } from "./types";
import { OIDC_SIGNING_ALGORITHMS, withAuthSettingsLock, updateSettings, settingResource, oidcSettingsResource, currentSamlSettings, authLockoutResponse, validOidcIssuer, normalizeIssuer } from "./helpers";
import { currentWorkloadIdentityKey, rotateWorkloadIdentityKey, trimWorkloadIdentityKeys, workloadIdentityJwks } from "../../lib/workload-identity";
import { pageRequest, pagination } from "../../lib/utils";
import { db } from "../../db";
import { workloadIdentityKeys } from "../../db/schema";
import { count, desc } from "drizzle-orm";
import { sendEmail } from "../../lib/smtp";
import { normalizeEmail } from "../../lib/identity";

function hidden(set: ParamCtx["set"]): Record<string, unknown> {
  (set as { status: number }).status = 404;
  return { errors: [{ status: "404", title: "Not Found" }] };
}

function smtpSettingsResource(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe = { ...values };
  const password = safe.password;
  delete safe.password;
  safe["password-set"] = typeof password === "string" && password !== "";
  return settingResource("smtp-settings", safe);
}

function redactedSettingsResource(
  id: string,
  values: Readonly<Record<string, unknown>>,
  secretKeys: readonly string[],
): Record<string, unknown> {
  const safe = { ...values };
  for (const key of secretKeys) {
    const value = safe[key];
    delete safe[key];
    safe[`${key}-set`] = value !== null && value !== undefined && value !== "";
  }
  return settingResource(id, safe);
}

export const settingsmoreRoutes = new Elysia({ name: "admin-settings-more" })
  .use(authPlugin)
  .get("/api/v2/admin/cost-estimation-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    return redactedSettingsResource("cost-estimation-settings", await getSettings("cost"), [
      "infracost-api-key",
      "aws-access-key-id",
      "aws-secret-key",
      "gcp-credentials",
      "azure-client-secret",
    ]);
  })
  .patch("/api/v2/admin/cost-estimation-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    return redactedSettingsResource("cost-estimation-settings", await updateSettings("cost", attrs), [
      "infracost-api-key",
      "aws-access-key-id",
      "aws-secret-key",
      "gcp-credentials",
      "azure-client-secret",
    ]);
  })
  // --- B.5 SMTP Settings ---
  .get("/api/v2/admin/smtp-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    return smtpSettingsResource(await getSettings("smtp"));
  })
  .patch("/api/v2/admin/smtp-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updated = { ...attrs };
    delete updated["test-email-address"];
    return smtpSettingsResource(await updateSettings("smtp", updated));
  })
  .post("/api/v2/admin/smtp-settings/test", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    const settings = await getSettings("smtp");
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attrs = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const recipient = typeof attrs.email === "string" ? normalizeEmail(attrs.email) : null;
    const host = typeof settings.host === "string" ? settings.host.trim() : "";
    const senderEmail = typeof settings["sender-email"] === "string" ? settings["sender-email"].trim() : "";
    if (settings.enabled !== true || host === "" || senderEmail === "" || recipient === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "SMTP must be enabled and configured, and a valid email is required" }] };
    }
    try {
      await sendEmail(
        {
          host,
          port: typeof settings.port === "number" ? settings.port : 25,
          username: typeof settings.username === "string" && settings.username !== "" ? settings.username : null,
          password: typeof settings.password === "string" ? settings.password : null,
          senderEmail,
          auth: settings.auth === "none" || settings.auth === "login" || settings.auth === "plain" ? settings.auth : "plain",
        },
        {
          to: [recipient],
          subject: "Terrence SMTP test",
          text: "This is a test message from Terrence SMTP settings.",
          html: "<html><body><p>This is a test message from Terrence SMTP settings.</p></body></html>",
        },
      );
    } catch {
      (set as { status: number }).status = 502;
      return { errors: [{ status: "502", title: "Bad Gateway", detail: "SMTP test delivery failed" }] };
    }
    (set as { status: number }).status = 204;
    return {};
  })
  // --- B.6 Twilio Settings ---
  .get("/api/v2/admin/twilio-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    return redactedSettingsResource("twilio-settings", await getSettings("twilio"), ["auth-token"]);
  })
  .patch("/api/v2/admin/twilio-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    return redactedSettingsResource("twilio-settings", await updateSettings("twilio", attrs), ["auth-token"]);
  })
  .post("/api/v2/admin/twilio-settings/verify", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    const settings = await getSettings("twilio");
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attrs = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const testNumber = typeof attrs["test-number"] === "string" ? attrs["test-number"].trim() : "";
    const accountSid = typeof settings["account-sid"] === "string" ? settings["account-sid"] : "";
    const authToken = typeof settings["auth-token"] === "string" ? settings["auth-token"] : "";
    const fromNumber = typeof settings["from-number"] === "string" ? settings["from-number"] : "";
    if (settings.enabled !== true || testNumber === "" || accountSid === "" || authToken === "" || fromNumber === "") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Twilio must be enabled and fully configured, and test-number is required" }] };
    }
    const form = new URLSearchParams({ Body: "Terrence verification message", To: testNumber, From: fromNumber });
    let response: Response;
    try {
      response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      (set as { status: number }).status = 503;
      return { errors: [{ status: "503", title: "Service Unavailable", detail: "Twilio verification could not reach the provider" }] };
    }
    const responseText = await response.text().catch((): string => "");
    if (!response.ok) {
      let detail = "Twilio rejected the verification message";
      try {
        const parsed = JSON.parse(responseText) as { message?: unknown };
        if (typeof parsed.message === "string" && parsed.message !== "") detail = parsed.message;
      } catch {
        // Keep the stable API error when Twilio does not return JSON.
      }
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail }] };
    }
    (set as { status: number }).status = 200;
    return {};
  })
  // --- B.7 Customization Settings ---
  .get("/api/v2/admin/customization-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    return settingResource("customization-settings", await getSettings("customization"));
  })
  .patch("/api/v2/admin/customization-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    return settingResource("customization-settings", await updateSettings("customization", attrs));
  })
  // --- B.8 OIDC Settings ---
  .get("/api/v2/admin/oidc-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    return oidcSettingsResource(await getSettings("oidc"));
  })
  .patch("/api/v2/admin/oidc-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
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
    const [samlEnabledForSso, ldapEnabledForSso] = await Promise.all([
      currentSamlSettings().then((settings): boolean => settings.enabled),
      ldapSettings().then((settings): boolean => settings.enabled),
    ]);
    const authError = await authLockoutResponse(set, {
      saml: samlEnabledForSso,
      oidc: enabled,
      ldap: ldapEnabledForSso,
    });
    if (authError !== null) return authError;
    const clientSecret = attrs["client-secret"] === null
      ? null
      : typeof attrs["client-secret"] === "string" && attrs["client-secret"] !== ""
        ? attrs["client-secret"]
        : current["client-secret"];
    if (attrs["client-secret"] === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "client-secret must be a non-empty string or null" }] };
    }
    if (enabled && signingAlg?.startsWith("HS") === true && (typeof clientSecret !== "string" || clientSecret === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "a client secret is required for symmetric signing algorithms" }] };
    }
    // Without PKCE, the token exchange authenticates the client with its
    // secret; an enabled provider with no secret could be impersonated.
    if (enabled && pkce !== "S256" && (typeof clientSecret !== "string" || clientSecret === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "a client secret is required when pkce-method is not S256" }] };
    }
    const updated = await updateSettings("oidc", {
      ...attrs,
      issuer,
      "client-id": clientId,
      "client-secret": clientSecret,
      "pkce-method": pkce === "" || pkce === undefined ? null : pkce,
      "signing-alg": signingAlg,
    });
    invalidatePingSsoCache();
    return oidcSettingsResource(updated);
    });
  })
  .post("/api/v2/admin/oidc-settings/actions/rotate-key", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    await withAuthSettingsLock(async (): Promise<void> => {
      const now = new Date().toISOString();
      const current = await getSettings("oidc");
      const previous = Array.isArray(current["dynamic-provider-signing-key-ids"])
        ? current["dynamic-provider-signing-key-ids"].filter((value): value is string => typeof value === "string")
        : typeof current["dynamic-provider-signing-key-id"] === "string" ? [current["dynamic-provider-signing-key-id"]] : [];
      const key = await rotateWorkloadIdentityKey();
      const keyId = key.keyId;
      await updateSettings("oidc", {
        "dynamic-provider-signing-key-id": keyId,
        "dynamic-provider-signing-key-ids": [...new Set([...previous, keyId])].slice(-2),
        "dynamic-provider-signing-key-rotated-at": now,
      });
      invalidatePingSsoCache();
    });
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/admin/oidc-settings/actions/trim-key", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    const trimmed = await withAuthSettingsLock(async (): Promise<boolean> => {
      const key = await currentWorkloadIdentityKey();
      const keyId = key.keyId;
      await trimWorkloadIdentityKeys();
      await updateSettings("oidc", {
        "dynamic-provider-signing-key-ids": [keyId],
        "dynamic-provider-signing-key-trimmed-at": new Date().toISOString(),
      });
      invalidatePingSsoCache();
      return true;
    });
    if (!trimmed) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "No current dynamic provider signing key exists" }] };
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/admin/oidc-settings/workload-identity-keys", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    const { number, size } = pageRequest(request);
    const [keys, total] = await Promise.all([
      db.query.workloadIdentityKeys.findMany({ orderBy: [desc(workloadIdentityKeys.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(workloadIdentityKeys),
    ]);
    const page = pagination(request, number, size, total[0]?.total ?? 0);
    return {
      data: keys.map((key): Record<string, unknown> => ({
        id: key.id,
        type: "workload-identity-keys",
        attributes: { "key-id": key.keyId, status: key.status, "created-at": new Date(key.createdAt).toISOString(), "retired-at": key.retiredAt === null ? null : new Date(key.retiredAt).toISOString(), "revoked-at": key.revokedAt === null ? null : new Date(key.revokedAt).toISOString() },
      })),
      links: page.links,
      meta: { ...page.meta, jwks: await workloadIdentityJwks() },
    };
  })
  // --- B.9 LDAP Settings ---
  .get("/api/v2/admin/ldap-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    // bind-password is write-only: never return its value to the dashboard.
    const values = await getSettings("ldap");
    const { "bind-password": bindPassword, ...safe } = values;
    return settingResource("ldap-settings", {
      ...safe,
      "bind-password-set": typeof bindPassword === "string" && bindPassword !== "",
    });
  })
  .patch("/api/v2/admin/ldap-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
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
    // A blank or absent value falls back to the attribute's default; the
    // helper guarantees the result is never an empty string.
    const attrFallback = (key: "attr-username" | "attr-email", fallback: string): string => {
      const input = attrs[key];
      const stored = current[key];
      return typeof input === "string"
        ? input.trim() || fallback
        : input === null ? fallback
          : typeof stored === "string" && stored.trim() !== "" ? stored.trim() : fallback;
    };
    const attrUsername = attrFallback("attr-username", "uid");
    const attrEmail = attrFallback("attr-email", "mail");
    if (enabled && (typeof host !== "string" || host === "" || typeof baseDn !== "string" || baseDn === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "host and base-dn are required when LDAP is enabled" }] };
    }
    // A bind DN without a password performs an unauthenticated (anonymous)
    // bind per RFC 4511 §4.2; reject the misconfiguration up front rather
    // than silently downgrading at login time.
    // A blank or whitespace-only bind DN means "no service account"; storing
    // it as a string would make authenticateLdap require a bind password
    // forever, and a padded one would be validated trimmed but persisted raw.
    const bindDnProvided = attrs["bind-dn"] !== undefined;
    const bindDn = typeof attrs["bind-dn"] === "string"
      ? (attrs["bind-dn"].trim() === "" ? null : attrs["bind-dn"].trim())
      : attrs["bind-dn"] === null ? null : current["bind-dn"];
    const bindPassword = attrs["bind-password"] === undefined ? current["bind-password"] : attrs["bind-password"];
    if (typeof bindDn === "string" && bindDn !== "" && (typeof bindPassword !== "string" || bindPassword === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "bind-password is required when bind-dn is set" }] };
    }
    // The bind password travels over the wire on every bind: never allow it
    // over an unencrypted connection. The ldap settings default ("ldaps")
    // keeps new configurations secure by construction.
    if (enabled && encryption === "plain" && typeof bindDn === "string" && bindDn !== ""
      && typeof bindPassword === "string" && bindPassword !== "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "bind credentials cannot be sent over plaintext LDAP; use starttls or ldaps" }] };
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
    const [samlEnabledForSso, oidcEnabledForSso] = await Promise.all([
      currentSamlSettings().then((settings): boolean => settings.enabled),
      getSettings("oidc").then((settings): boolean => settings.enabled === true),
    ]);
    const authError = await authLockoutResponse(set, {
      saml: samlEnabledForSso,
      oidc: oidcEnabledForSso,
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
      // Clearing the bind DN removes the service account: drop the stored
      // bind password with it so no orphaned secret lingers.
      ...(bindDnProvided ? { "bind-dn": bindDn, ...(bindDn === null ? { "bind-password": null } : {}) } : {}),
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
