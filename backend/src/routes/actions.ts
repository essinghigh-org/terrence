import { Elysia } from "elysia";
import { authPlugin } from "../auth";
import { TFP_API_VERSION } from "../lib/constants";

// 476-482: Terraform Actions API shim (HCP May 2026 surface).
// Returns empty but correctly-typed responses so clients can discover the
// capability without treating its absence as an error. Real execution hooks
// can be layered behind the same prefix later.

export const actionsRoutes = new Elysia({ name: "actions" })
  .use(authPlugin)
  .get("/api/v2/actions", ({ set }: { set: { headers: Record<string, string | number> } }): unknown => {
    const h = set.headers;
    h["TFP-API-Version"] = TFP_API_VERSION;
    return { data: [], meta: { pagination: { "current-page": 1, "total-pages": 0, "total-count": 0 } } };
  })
  .get("/api/v2/actions/:id", ({ params, set }: { params: { id: string }; set: Record<string, unknown> }): unknown => {
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found", detail: `Action ${params.id} not found` }] };
  })
  .get("/api/v2/runs/:run_id/actions", ({ params, set }: { params: { run_id: string }; set: { headers: Record<string, string | number> } }): unknown => {
    const h = set.headers;
    h["TFP-API-Version"] = TFP_API_VERSION;
    void params.run_id;
    return { data: [], meta: { pagination: { "current-page": 1, "total-pages": 0, "total-count": 0 } } };
  })
  // 480/482: invocation output + stack-lifecycle convenience (same empty shape;
  // a real executor would populate data[].attributes.output / stack binding).
  .get("/api/v2/actions/:id/output", ({ params, set }: { params: { id: string }; set: Record<string, unknown> }): unknown => {
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found", detail: `Action ${params.id} has no output` }] };
  })
  .get("/api/v2/stacks/:stack_id/actions", ({ params, set }: { params: { stack_id: string }; set: { headers: Record<string, string | number> } }): unknown => {
    void params.stack_id;
    const h = set.headers;
    h["TFP-API-Version"] = TFP_API_VERSION;
    return { data: [], meta: { pagination: { "current-page": 1, "total-pages": 0, "total-count": 0 } } };
  });
