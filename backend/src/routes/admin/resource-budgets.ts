import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { collectDurableJobBudgetSnapshot, collectDurableJobQueueInspector } from "../../lib/durable-jobs";
import { parseResourceBudgetConfig, resourceBudgetConfigurationResource } from "../../lib/resource-budgets";

/** Site-admin diagnostics for the durable work capacity policy. */
export const resourceBudgetRoutes = new Elysia({ name: "admin-resource-budgets" })
  .use(authPlugin)
  .get("/api/v2/admin/resource-budgets", async ({ set }: Readonly<{ set: Readonly<{ status?: number | string }> }>): Promise<unknown> => {
    try {
      const [config, snapshot, queue] = await Promise.all([
        Promise.resolve(parseResourceBudgetConfig()),
        collectDurableJobBudgetSnapshot(),
        collectDurableJobQueueInspector(),
      ]);
      return {
        data: {
          id: "resource-budgets",
          type: "resource-budgets",
          attributes: {
            config: resourceBudgetConfigurationResource(config),
            snapshot,
            queue,
          },
        },
      };
    } catch {
      (set as { status: number }).status = 503;
      return { errors: [{ status: "503", title: "Service Unavailable", detail: "Resource budget diagnostics are unavailable" }] };
    }
  });
