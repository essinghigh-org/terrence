import { Elysia } from "elysia";
import { desc } from "drizzle-orm";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { controlPlaneNodes } from "../../db/schema";
import { readBackupStatus } from "../../lib/backup-verification";
import { getSettings } from "../../lib/settings";
import { auditLog } from "../../lib/utils";
import { NODE_HEARTBEAT_TIMEOUT_MS, readinessNodeId } from "../health";
import { settingResource, updateSettings } from "./helpers";
import type { ParamCtx } from "./types";

export function rehearsalFreshness(
  lastVerified: string | null,
  maxAgeDays: number,
  now = Date.now(),
): {
  status: "unknown" | "current" | "overdue";
  ageDays: number | null;
} {
  const at = lastVerified === null ? Number.NaN : Date.parse(lastVerified);
  if (!Number.isFinite(at) || at > now) return { status: "unknown", ageDays: null };
  const ageDays = (now - at) / 86_400_000;
  return { status: ageDays > maxAgeDays ? "overdue" : "current", ageDays };
}

function settingsAttributes(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
  const data = (body as Record<string, unknown>)["data"];
  if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
  const attrs = (data as Record<string, unknown>)["attributes"];
  return attrs !== null && typeof attrs === "object" && !Array.isArray(attrs) ? (attrs as Record<string, unknown>) : {};
}

export const operationsCenterRoutes = new Elysia({ name: "admin-operations-center" })
  .use(authPlugin)
  .onBeforeHandle(({ user, set }: ParamCtx): unknown => {
    if (user?.isSiteAdmin === true) return undefined;
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found" }] };
  })
  .get("/api/v2/admin/operations-center", async (): Promise<unknown> => {
    const [backup, settings, nodes] = await Promise.all([
      readBackupStatus(),
      getSettings("operations-center"),
      db.query.controlPlaneNodes.findMany({ orderBy: [desc(controlPlaneNodes.lastHeartbeatAt)], limit: 100 }),
    ]);
    const maxAgeDays = Number(settings["rehearsal-max-age-days"] ?? 30);
    const now = Date.now();
    return settingResource("operations-center", {
      "checked-at": new Date(now).toISOString(),
      "local-node-id": readinessNodeId(),
      "supported-topology": "single-active-control-plane",
      "rehearsal-max-age-days": maxAgeDays,
      backup: {
        "last-verified-restore-at": backup.lastVerifiedRestoreAt,
        "last-rehearsal-id": backup.lastRehearsalId,
        "last-verified-manifest-sha256": backup.lastVerifiedManifestSha256,
        ...rehearsalFreshness(backup.lastVerifiedRestoreAt, maxAgeDays, now),
      },
      nodes: nodes.map(
        (node): Record<string, unknown> => ({
          id: node.id,
          version: node.version,
          status: node.status,
          "last-heartbeat-at": new Date(node.lastHeartbeatAt).toISOString(),
          stale: now - node.lastHeartbeatAt > NODE_HEARTBEAT_TIMEOUT_MS,
          checks: node.readinessChecks,
        }),
      ),
    });
  })
  // Keep body validation inside the authenticated handler. Elysia route-level
  // body schemas run before onBeforeHandle; malformed non-admin requests would
  // otherwise reveal this deliberately hidden admin route with 422 instead of 404.
  .patch("/api/v2/admin/operations-center/settings", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    const attrs = settingsAttributes(body);
    const value = attrs["rehearsal-max-age-days"];
    if (
      Object.keys(attrs).length !== 1 ||
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 3650
    ) {
      (set as { status: number }).status = 422;
      return {
        errors: [
          {
            status: "422",
            title: "Unprocessable Entity",
            detail: "rehearsal-max-age-days must be an integer from 1 to 3650",
          },
        ],
      };
    }
    const values = await updateSettings("operations-center", { "rehearsal-max-age-days": value });
    await auditLog("update", "operations-center-settings", "operations-center", user?.id ?? null, null, {
      "rehearsal-max-age-days": value,
    });
    return settingResource("operations-center-settings", values);
  });
