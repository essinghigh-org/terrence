import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { normalizePlanExplainerBaseUrl } from "../../lib/settings";
import { listCatalogProviders, getCatalogProviderModels } from "../../lib/model-catalog";
import { type ReasoningEffort, REASONING_EFFORTS } from "../../lib/run-explanations";
import type { ParamCtx } from "./types";
import { usableHttpUrl, validClockTime, operationsSettingsResource, updateSettings } from "./helpers";
type SettingsRejection = { errors: { status: string; title: string; detail: string }[] };

function rejectSettings(set: ParamCtx["set"], detail: string): SettingsRejection {
  (set as { status: number }).status = 422;
  return { errors: [{ status: "422", title: "Unprocessable Entity", detail }] };
}

async function applyApprovalWebhook(
  attrs: Record<string, unknown>,
  set: ParamCtx["set"],
): Promise<{ applied: true } | { error: SettingsRejection }> {
  if (attrs["approval-webhook"] === undefined) return { applied: true };
  const value = attrs["approval-webhook"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: rejectSettings(set, "approval-webhook must be an object") };
  const group = value as Record<string, unknown>;
  if (group["enabled"] !== undefined && typeof group["enabled"] !== "boolean") return { error: rejectSettings(set, "approval-webhook.enabled must be a boolean") };
  if (group["secret"] !== undefined && group["secret"] !== null && typeof group["secret"] !== "string") return { error: rejectSettings(set, "approval-webhook.secret must be a string") };
  if (group["url"] !== undefined && group["url"] !== null) {
    if (typeof group["url"] !== "string" || !usableHttpUrl(group["url"])) return { error: rejectSettings(set, "approval-webhook.url must be an http(s) URL or null") };
  }
  await updateSettings("approval-webhook", group);
  return { applied: true };
}

function checkMaintenanceWindow(rawWindow: unknown, set: ParamCtx["set"]): { ok: true } | { error: SettingsRejection } {
  if (rawWindow === null || typeof rawWindow !== "object" || Array.isArray(rawWindow)) return { error: rejectSettings(set, "each maintenance window must be an object") };
  const window = rawWindow as Record<string, unknown>;
  const days = window["days"];
  if (!Array.isArray(days) || !days.every((day: unknown): boolean => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6)) {
    return { error: rejectSettings(set, "maintenance window days must be an array of integers 0-6") };
  }
  if (typeof window["start-time"] !== "string" || !validClockTime(window["start-time"])
    || typeof window["end-time"] !== "string" || !validClockTime(window["end-time"])) {
    return { error: rejectSettings(set, "maintenance window start-time and end-time must be HH:MM with a valid clock time (00-23 hours, 00-59 minutes)") };
  }
  if (window["timezone"] !== undefined && typeof window["timezone"] !== "string") return { error: rejectSettings(set, "maintenance window timezone must be a string") };
  return { ok: true };
}

async function applyMaintenanceWindows(
  attrs: Record<string, unknown>,
  set: ParamCtx["set"],
): Promise<{ applied: true } | { error: SettingsRejection }> {
  if (attrs["maintenance-windows"] === undefined) return { applied: true };
  const value = attrs["maintenance-windows"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: rejectSettings(set, "maintenance-windows must be an object") };
  const group = value as Record<string, unknown>;
  if (group["enabled"] !== undefined && typeof group["enabled"] !== "boolean") return { error: rejectSettings(set, "maintenance-windows.enabled must be a boolean") };
  if (group["windows"] !== undefined) {
    if (!Array.isArray(group["windows"])) return { error: rejectSettings(set, "maintenance-windows.windows must be an array") };
    for (const rawWindow of group["windows"]) {
      const checked = checkMaintenanceWindow(rawWindow, set);
      if ("error" in checked) return checked;
    }
  }
  await updateSettings("maintenance-windows", group);
  return { applied: true };
}

function normalizeExplainerEndpoints(
  group: Record<string, unknown>,
  set: ParamCtx["set"],
): { normalized: Record<string, unknown> } | { error: SettingsRejection } {
  const normalizedGroup: Record<string, unknown> = { ...group };
  if ("base-url" in group) {
    if (group["base-url"] !== null) {
      const baseUrl = normalizePlanExplainerBaseUrl(group["base-url"]);
      if (baseUrl === null) return { error: rejectSettings(set, "plan-explainer base-url must be an http(s) URL or null") };
      normalizedGroup["base-url"] = baseUrl;
    }
    normalizedGroup["endpoint-url"] = null;
  } else if ("endpoint-url" in group) {
    const baseUrl = group["endpoint-url"] === null ? null : normalizePlanExplainerBaseUrl(group["endpoint-url"]);
    if (group["endpoint-url"] !== null && baseUrl === null) {
      return { error: rejectSettings(set, "plan-explainer endpoint-url must be an http(s) URL or null") };
    }
    normalizedGroup["base-url"] = baseUrl;
    normalizedGroup["endpoint-url"] = null;
  }
  return { normalized: normalizedGroup };
}

function checkExplainerScalars(group: Record<string, unknown>, set: ParamCtx["set"]): { ok: true } | { error: SettingsRejection } {
  if (group["api-key"] !== undefined && group["api-key"] !== null && typeof group["api-key"] !== "string") return { error: rejectSettings(set, "plan-explainer api-key must be a string or null") };
  if (group["model"] !== undefined && group["model"] !== null && typeof group["model"] !== "string") return { error: rejectSettings(set, "plan-explainer model must be a string or null") };
  if (group["reasoning-effort"] !== undefined && group["reasoning-effort"] !== null
    && (typeof group["reasoning-effort"] !== "string" || !REASONING_EFFORTS.includes(group["reasoning-effort"] as ReasoningEffort))) {
    return { error: rejectSettings(set, `plan-explainer reasoning-effort must be one of: ${REASONING_EFFORTS.join(", ")} or null`) };
  }
  return { ok: true };
}

async function applyPlanExplainer(
  attrs: Record<string, unknown>,
  set: ParamCtx["set"],
): Promise<{ applied: true } | { error: SettingsRejection }> {
  if (attrs["plan-explainer"] === undefined) return { applied: true };
  const value = attrs["plan-explainer"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: rejectSettings(set, "plan-explainer must be an object") };
  const group = value as Record<string, unknown>;
  if (group["enabled"] !== undefined && typeof group["enabled"] !== "boolean") return { error: rejectSettings(set, "plan-explainer.enabled must be a boolean") };
  if (group["provider"] !== undefined && group["provider"] !== null && typeof group["provider"] !== "string") return { error: rejectSettings(set, "plan-explainer.provider must be a string or null") };
  const endpoints = normalizeExplainerEndpoints(group, set);
  if ("error" in endpoints) return endpoints;
  const scalars = checkExplainerScalars(group, set);
  if ("error" in scalars) return scalars;
  await updateSettings("plan-explainer", endpoints.normalized);
  return { applied: true };
}

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
    const webhook = await applyApprovalWebhook(attrs, set);
    if ("error" in webhook) return webhook.error;
    const windows = await applyMaintenanceWindows(attrs, set);
    if ("error" in windows) return windows.error;
    const explainer = await applyPlanExplainer(attrs, set);
    if ("error" in explainer) return explainer.error;
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
