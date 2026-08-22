import { Elysia } from "elysia";
import { authPlugin } from "../auth";
import { TFP_API_VERSION } from "../lib/constants";

// 490-499: HCP Dec 2025 registry-components API shim.
// Mirrors /api/registry/v1/components — empty discovery shape; full
// publish/version/delete/metadata lifecycle can build on this prefix.

export const registryComponentsRoutes = new Elysia({ name: "registry-components" })
  .use(authPlugin)
  .get("/api/registry/v1/components", ({ set }: { set: { headers: Record<string, string | number> } }): unknown => {
    const h = set.headers;
    h["TFP-API-Version"] = TFP_API_VERSION;
    return { data: [], meta: { pagination: { "current-page": 1, "total-pages": 0, "total-count": 0 } } };
  })
  .get("/api/registry/v1/components/:id", ({ params, set }: { params: { id: string }; set: Record<string, unknown> }): unknown => {
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found", detail: `Component ${params.id} not found` }] };
  })
  .post("/api/registry/v1/components", ({ set }: { set: Record<string, unknown> }): unknown => {
    (set as { status: number }).status = 501;
    return { errors: [{ status: "501", title: "Not Implemented", detail: "Registry components publish is not yet implemented on this instance" }] };
  })
  .delete("/api/registry/v1/components/:id", ({ params, set }: { params: { id: string }; set: Record<string, unknown> }): unknown => {
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found", detail: `Component ${params.id} not found` }] };
  });
