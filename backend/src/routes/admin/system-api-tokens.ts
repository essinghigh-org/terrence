import { Elysia } from "elysia";
import { and, desc, eq, isNull } from "drizzle-orm";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { systemApiTokens } from "../../db/schema";
import { createSystemApiToken, systemTokenResource } from "../../lib/system-api";
import type { ParamCtx } from "./types";

function denied(set: ParamCtx["set"]): Record<string, unknown> {
  (set as { status: number }).status = 404;
  return { errors: [{ status: "404", title: "Not Found" }] };
}

export const systemApiTokenAdminRoutes = new Elysia({ name: "admin-system-api-tokens" })
  .use(authPlugin)
  .get("/api/v2/admin/system-api-tokens", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return denied(set);
    const rows = await db.query.systemApiTokens.findMany({ orderBy: [desc(systemApiTokens.createdAt)] });
    return { data: rows.map(systemTokenResource) };
  })
  .post("/api/v2/admin/system-api-tokens", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return denied(set);
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attrs = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const description = typeof attrs.description === "string" ? attrs.description : "";
    const ttl = attrs.ttl === undefined ? 720 : Number(attrs.ttl);
    try {
      const created = await createSystemApiToken(description, ttl);
      (set as { status: number }).status = 201;
      const resource = systemTokenResource(created.record);
      return {
        data: {
          ...resource,
          attributes: { ...resource.attributes as Record<string, unknown>, token: created.token },
        },
      };
    } catch (error: unknown) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error instanceof Error ? error.message : "Invalid token request" }] };
    }
  })
  .delete("/api/v2/admin/system-api-tokens/:token_id", async ({ user, params, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return denied(set);
    const id = params.token_id ?? "";
    const updated = await db.update(systemApiTokens).set({ revokedAt: Date.now() }).where(and(eq(systemApiTokens.id, id), isNull(systemApiTokens.revokedAt))).returning({ id: systemApiTokens.id });
    if (updated.length === 0) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  });
