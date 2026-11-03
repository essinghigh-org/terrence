import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { getSettingsFresh } from "../../lib/settings";
import { updateSettings, withSettingsLock } from "./helpers";
import type { ParamCtx } from "./types";

type Banner = { id: string; type: string; attributes: Record<string, unknown> };
const scheduleKeys = ["scheduled-publish-at", "scheduled-expire-at", "timezone"] as const;
const writable = new Set(["title", "body", "style", "audience", ...scheduleKeys]);
function error(set: ParamCtx["set"], status: number, detail: string): unknown {
  (set as { status: number }).status = status;
  return { errors: [{ status: String(status), title: detail }] };
}
function attributes(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object") return null;
  const data = (body as Record<string, unknown>)["data"];
  if (data === null || typeof data !== "object") return null;
  const resource = data as Record<string, unknown>;
  const attrs = resource["attributes"];
  if (resource["type"] !== "admin-banners" || attrs === null || typeof attrs !== "object" || Array.isArray(attrs))
    return null;
  return attrs as Record<string, unknown>;
}
async function sanitizeBody(body: string): Promise<string> {
  // Parse HTML rather than stripping tags with regex. No executable elements,
  // event attributes, or non-HTTP link protocols survive the stored response.
  return new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName;
        if (["script", "style", "iframe", "object", "svg", "math", "template"].includes(tag)) {
          element.remove();
          return;
        }
        if (!["strong", "em", "a"].includes(tag)) {
          element.removeAndKeepContent();
          return;
        }
        const href = element.getAttribute("href");
        for (const [name] of element.attributes) element.removeAttribute(name);
        if (tag === "a" && href !== null) {
          try {
            const url = new URL(href);
            if (["https:", "http:"].includes(url.protocol)) element.setAttribute("href", url.href);
          } catch {
            /* Unsafe/relative links become plain anchors. */
          }
        }
      },
    })
    .transform(new Response(body))
    .text();
}
async function prepare(attrs: Record<string, unknown>, prior?: Banner): Promise<Record<string, unknown> | string> {
  if (Object.keys(attrs).some((key) => !writable.has(key))) return "Unsupported banner attribute";
  const values: Record<string, unknown> = {
    style: "info",
    audience: "authenticated_only",
    "scheduled-publish-at": null,
    "scheduled-expire-at": null,
    timezone: null,
    ...prior?.attributes,
    ...attrs,
  };
  if (typeof values["title"] !== "string" || values["title"].length < 1 || values["title"].length > 100)
    return "title must contain 1 to 100 characters";
  if (typeof values["body"] !== "string") return "body is required";
  const sanitized = await sanitizeBody(values["body"]);
  values["body"] = sanitized;
  if (sanitized.length < 1 || sanitized.length > 500) return "Sanitized body must contain 1 to 500 characters";
  if (!["info", "warning", "critical"].includes(String(values["style"]))) return "Invalid style";
  if (!["all_users", "authenticated_only"].includes(String(values["audience"]))) return "Invalid audience";
  const scheduleError = applySchedule(values, prior);
  return scheduleError ?? values;
}
function applySchedule(values: Record<string, unknown>, prior?: Banner): string | undefined {
  const scheduled = scheduleKeys.some((key) => values[key] !== null);
  if (scheduled) {
    const publish = values["scheduled-publish-at"];
    const expire = values["scheduled-expire-at"];
    const timezone = values["timezone"];
    const timestamp = (value: unknown): value is string =>
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value));
    if (
      !timestamp(publish) ||
      !timestamp(expire) ||
      Date.parse(expire) <= Date.parse(publish) ||
      typeof timezone !== "string" ||
      timezone === ""
    )
      return "A schedule requires valid publish/expire timestamps and timezone, with expiry after publication";
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      return "Invalid timezone";
    }
    values["published-at"] = publish;
  } else {
    values["published-at"] = prior?.attributes["published-at"] ?? new Date().toISOString();
    if (prior?.attributes["scheduled-publish-at"] !== null && prior !== undefined)
      values["published-at"] = new Date().toISOString();
  }
  return undefined;
}
async function current(): Promise<Banner | null> {
  return ((await getSettingsFresh("admin-banners"))["active"] as Banner | null | undefined) ?? null;
}
export const bannersRoutes = new Elysia({ name: "admin-banners" })
  .use(authPlugin)
  .get("/api/v2/admin/banners", async ({ user, set }: ParamCtx) => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    const banner = await current();
    return { data: banner === null ? [] : [banner] };
  })
  .post("/api/v2/admin/banners", async ({ user, body, set }: ParamCtx) => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    return withSettingsLock("admin-banner-lifecycle", async () => {
      if ((await current()) !== null) return error(set, 409, "A non-deactivated banner already exists");
      const attrs = attributes(body);
      if (attrs === null) return error(set, 422, "Expected an admin-banners resource with attributes");
      const values = await prepare(attrs);
      if (typeof values === "string") return error(set, 422, values);
      const banner = { id: `ban-${crypto.randomUUID()}`, type: "admin-banners", attributes: values };
      await updateSettings("admin-banners", { active: banner });
      (set as { status: number }).status = 201;
      return { data: banner };
    });
  })
  .patch("/api/v2/admin/banners/:id", async ({ user, body, params, set }: ParamCtx) => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    return withSettingsLock("admin-banner-lifecycle", async () => {
      const banner = await current();
      if (banner === null || banner.id !== params["id"]) return error(set, 404, "Not Found");
      const attrs = attributes(body);
      if (attrs === null) return error(set, 422, "Expected an admin-banners resource with attributes");
      const values = await prepare(attrs, banner);
      if (typeof values === "string") return error(set, 422, values);
      const updated = { ...banner, attributes: values };
      await updateSettings("admin-banners", { active: updated });
      return { data: updated };
    });
  })
  .delete("/api/v2/admin/banners/:id", async ({ user, params, set }: ParamCtx) => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    return withSettingsLock("admin-banner-lifecycle", async () => {
      const banner = await current();
      if (banner === null || banner.id !== params["id"]) return error(set, 404, "Not Found");
      await updateSettings("admin-banners", { active: null });
      return new Response(null, { status: 204 });
    });
  });
