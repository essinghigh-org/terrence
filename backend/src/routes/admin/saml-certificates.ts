import { X509Certificate, randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { samlSettings } from "../../db/schema";
import {
  certificateId,
  samlCertificateCollection,
  samlCertificateResource,
  saveSamlCertificates,
  storedSamlCertificates,
} from "../../lib/saml-certificates";
import { currentSamlSettings, withAuthSettingsLock, SAML_SETTINGS_ID } from "./helpers";
import type { ParamCtx } from "./types";

const path = "/api/v2/admin/saml-settings/idp-certificates";
function error(set: ParamCtx["set"], status: number, detail: string): unknown {
  (set as { status: number }).status = status;
  return { errors: [{ status: String(status), title: status === 404 ? "Not Found" : "Unprocessable Entity", detail }] };
}
function attributes(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: { type?: unknown; attributes?: unknown } }).data;
  if (data?.type !== "saml-idp-certificates" || !data.attributes || typeof data.attributes !== "object") return null;
  return data.attributes as Record<string, unknown>;
}
function validCertificate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(value)
  )
    return false;
  try {
    new X509Certificate(value);
    return true;
  } catch {
    return false;
  }
}
export const samlCertificateRoutes = new Elysia({ name: "admin-saml-certificates" })
  .use(authPlugin)
  .get(path, async ({ user, set }: ParamCtx) => {
    if (!user?.isSiteAdmin) return error(set, 404, "Not Found");
    return { data: (await samlCertificateCollection(await currentSamlSettings())).map(samlCertificateResource) };
  })
  .get(`${path}/:id`, async ({ user, params, set }: ParamCtx) => {
    if (!user?.isSiteAdmin) return error(set, 404, "Not Found");
    const item = (await samlCertificateCollection(await currentSamlSettings())).find((c) => c.id === params["id"]);
    return item ? { data: samlCertificateResource(item) } : error(set, 404, "Certificate not found");
  })
  .post(path, async ({ user, body, set }: ParamCtx) => {
    if (!user?.isSiteAdmin) return error(set, 404, "Not Found");
    return withAuthSettingsLock(async () => {
      const attrs = attributes(body);
      if (
        !attrs ||
        typeof attrs["display-name"] !== "string" ||
        !attrs["display-name"].trim() ||
        !validCertificate(attrs["cert"])
      )
        return error(set, 422, "A display-name and valid PEM X.509 cert are required");
      if (
        (await samlCertificateCollection(await currentSamlSettings())).some(
          (c) => certificateId(c.cert) === certificateId(attrs["cert"] as string),
        )
      )
        return error(set, 422, "Certificate is already trusted");
      const item = {
        id: `idpc-${randomUUID().replaceAll("-", "")}`,
        name: attrs["display-name"],
        cert: attrs["cert"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await saveSamlCertificates([...(await storedSamlCertificates()), item]);
      (set as { status: number }).status = 201;
      return { data: samlCertificateResource({ ...item, role: "managed" }) };
    });
  })
  .patch(`${path}/:id`, async ({ user, params, body, set }: ParamCtx) => {
    if (!user?.isSiteAdmin) return error(set, 404, "Not Found");
    return withAuthSettingsLock(async () => {
      const item = (await samlCertificateCollection(await currentSamlSettings())).find((c) => c.id === params["id"]);
      if (!item) return error(set, 404, "Certificate not found");
      const attrs = attributes(body);
      if (
        !attrs ||
        (attrs["display-name"] !== undefined &&
          (typeof attrs["display-name"] !== "string" || !attrs["display-name"].trim()))
      )
        return error(set, 422, "display-name must not be empty");
      if (
        attrs["cert"] !== undefined &&
        (!validCertificate(attrs["cert"]) ||
          (item.role !== "managed" && certificateId(attrs["cert"]) !== certificateId(item.cert)))
      )
        return error(
          set,
          422,
          "Legacy certificate bodies must be changed through SAML settings; cert must be valid PEM X.509",
        );
      if (
        attrs["cert"] !== undefined &&
        (await samlCertificateCollection(await currentSamlSettings())).some(
          (c) => c.id !== item.id && certificateId(c.cert) === certificateId(attrs["cert"] as string),
        )
      )
        return error(set, 422, "Certificate is already trusted");
      const updated = {
        ...item,
        legacy: item.role !== "managed",
        name: typeof attrs["display-name"] === "string" ? attrs["display-name"] : item.name,
        cert: typeof attrs["cert"] === "string" ? attrs["cert"] : item.cert,
        updatedAt: Date.now(),
      };
      await saveSamlCertificates([...(await storedSamlCertificates()).filter((c) => c.id !== item.id), updated]);
      return { data: samlCertificateResource(updated) };
    });
  })
  .delete(`${path}/:id`, async ({ user, params, set }: ParamCtx) => {
    if (!user?.isSiteAdmin) return error(set, 404, "Not Found");
    return withAuthSettingsLock(async () => {
      const settings = await currentSamlSettings();
      const items = await samlCertificateCollection(settings);
      const item = items.find((c) => c.id === params["id"]);
      if (!item) return error(set, 404, "Certificate not found");
      if (settings.enabled && items.length <= 1)
        return error(set, 422, "Cannot remove the last trusted certificate while SAML is enabled");
      if (item.role !== "managed")
        await db
          .update(samlSettings)
          .set({
            ...(item.role === "legacy_primary" ? { idpCert: null } : { oldIdpCert: null }),
            updatedAt: Date.now(),
          })
          .where(eq(samlSettings.id, SAML_SETTINGS_ID));
      await saveSamlCertificates((await storedSamlCertificates()).filter((c) => c.id !== item.id));
      (set as { status: number }).status = 204;
      return new Response(null, { status: 204 });
    });
  });
