import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { normalizePlanExplainerBaseUrl } from "../../lib/settings";
import { listCatalogProviders, getCatalogProviderModels } from "../../lib/model-catalog";
import { type ReasoningEffort, REASONING_EFFORTS } from "../../lib/run-explanations";
import type { ParamCtx } from "./types";
import { usableHttpUrl, validClockTime, operationsSettingsResource, updateSettings } from "./helpers";
export const operationsRoutes = new Elysia({ name: "admin-operations" })
  .use(authPlugin)
  .get("/api/v2/admin/operations-settings", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await operationsSettingsResource() };
  })
  .patch("/api/v2/admin/operations-settings", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const reject = (detail: string): { errors: { status: string; title: string; detail: string }[] } => {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail }] };
    };
    if (attrs["approval-webhook"] !== undefined) {
      const value = attrs["approval-webhook"];
      if (value === null || typeof value !== "object" || Array.isArray(value)) return reject("approval-webhook must be an object");
      const group = value as Record<string, unknown>;
      if (group["enabled"] !== undefined && typeof group["enabled"] !== "boolean") return reject("approval-webhook.enabled must be a boolean");
      if (group["secret"] !== undefined && group["secret"] !== null && typeof group["secret"] !== "string") return reject("approval-webhook.secret must be a string");
      if (group["url"] !== undefined && group["url"] !== null) {
        if (typeof group["url"] !== "string" || !usableHttpUrl(group["url"])) return reject("approval-webhook.url must be an http(s) URL or null");
      }
      await updateSettings("approval-webhook", group);
    }
    if (attrs["maintenance-windows"] !== undefined) {
      const value = attrs["maintenance-windows"];
      if (value === null || typeof value !== "object" || Array.isArray(value)) return reject("maintenance-windows must be an object");
      const group = value as Record<string, unknown>;
      if (group["enabled"] !== undefined && typeof group["enabled"] !== "boolean") return reject("maintenance-windows.enabled must be a boolean");
      if (group["windows"] !== undefined) {
        if (!Array.isArray(group["windows"])) return reject("maintenance-windows.windows must be an array");
        for (const rawWindow of group["windows"]) {
          if (rawWindow === null || typeof rawWindow !== "object" || Array.isArray(rawWindow)) return reject("each maintenance window must be an object");
          const window = rawWindow as Record<string, unknown>;
          const days = window["days"];
          if (!Array.isArray(days) || !days.every((day: unknown): boolean => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6)) {
            return reject("maintenance window days must be an array of integers 0-6");
          }
          if (typeof window["start-time"] !== "string" || !validClockTime(window["start-time"])
            || typeof window["end-time"] !== "string" || !validClockTime(window["end-time"])) {
            return reject("maintenance window start-time and end-time must be HH:MM with a valid clock time (00-23 hours, 00-59 minutes)");
          }
          if (window["timezone"] !== undefined && typeof window["timezone"] !== "string") return reject("maintenance window timezone must be a string");
        }
      }
      await updateSettings("maintenance-windows", group);
    }
    if (attrs["plan-explainer"] !== undefined) {
      const value = attrs["plan-explainer"];
      if (value === null || typeof value !== "object" || Array.isArray(value)) return reject("plan-explainer must be an object");
      const group = value as Record<string, unknown>;
      if (group["enabled"] !== undefined && typeof group["enabled"] !== "boolean") return reject("plan-explainer.enabled must be a boolean");
      if (group["provider"] !== undefined && group["provider"] !== null && typeof group["provider"] !== "string") return reject("plan-explainer.provider must be a string or null");
      const normalizedGroup: Record<string, unknown> = { ...group };
      if ("base-url" in group) {
        if (group["base-url"] !== null) {
          const baseUrl = normalizePlanExplainerBaseUrl(group["base-url"]);
          if (baseUrl === null) return reject("plan-explainer base-url must be an http(s) URL or null");
          normalizedGroup["base-url"] = baseUrl;
        }
        normalizedGroup["endpoint-url"] = null;
      } else if ("endpoint-url" in group) {
        const baseUrl = group["endpoint-url"] === null ? null : normalizePlanExplainerBaseUrl(group["endpoint-url"]);
        if (group["endpoint-url"] !== null && baseUrl === null) {
          return reject("plan-explainer endpoint-url must be an http(s) URL or null");
        }
        normalizedGroup["base-url"] = baseUrl;
        normalizedGroup["endpoint-url"] = null;
      }
      if (group["api-key"] !== undefined && group["api-key"] !== null && typeof group["api-key"] !== "string") return reject("plan-explainer api-key must be a string or null");
      if (group["model"] !== undefined && group["model"] !== null && typeof group["model"] !== "string") return reject("plan-explainer model must be a string or null");
      if (group["reasoning-effort"] !== undefined && group["reasoning-effort"] !== null
        && (typeof group["reasoning-effort"] !== "string" || !REASONING_EFFORTS.includes(group["reasoning-effort"] as ReasoningEffort))) {
        return reject(`plan-explainer reasoning-effort must be one of: ${REASONING_EFFORTS.join(", ")} or null`);
      }
      await updateSettings("plan-explainer", normalizedGroup);
    }
    return { data: await operationsSettingsResource() };
  })
  // --- Plan explainer provider/model catalog (kanban 21.2 UI) ----------
  // Additive admin convenience: powers the provider dropdown + model picker.
  // Sourced from the models.dev catalog (6h TTL background refresh); never
  // part of the explain request itself; the selected provider supplies the
  // default base URL and the saved base-url is only an optional override.
  .get("/api/v2/admin/operations-settings/explainer/providers", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const providers = await listCatalogProviders();
    return {
      data: providers.map((provider) => ({
        id: provider.id,
        type: "explainer-providers",
        attributes: {
          name: provider.name,
          "model-count": provider.modelCount,
        },
      })),
      meta: { "catalog-ttl-ms": 6 * 60 * 60 * 1000 },
    };
  })
  .get("/api/v2/admin/operations-settings/explainer/models", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const providerId = new URL(request.url).searchParams.get("provider") ?? "";
    if (providerId === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "provider query parameter is required" }] }; }
    const provider = await getCatalogProviderModels(providerId);
    if (provider === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found", detail: `Unknown provider: ${providerId}` }] }; }
    return {
      data: provider.models.map((model) => ({
        id: model.id,
        type: "explainer-models",
        attributes: {
          name: model.name,
          reasoning: model.reasoning,
          context: model.context,
        },
      })),
      meta: { provider: providerId, "model-count": provider.models.length },
    };
  });
