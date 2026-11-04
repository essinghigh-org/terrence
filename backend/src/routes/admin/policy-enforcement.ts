import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { adminSettings, auditLogs } from "../../db/schema";
import { auditLogValues } from "../../lib/audit-trail";
import {
  getPolicyEnforcementSettings,
  POLICY_ENFORCEMENT_DEFAULTS,
  POLICY_ENFORCEMENT_GROUP,
  resolvePolicyEnforcementSettings,
  type PolicyEnforcementSettings,
} from "../../lib/policy-enforcement";
import { invalidateSettingsCache } from "../../lib/settings";
import { SettingsValidationError } from "../../lib/settings-contract";
import type { ParamCtx } from "./types";

type EnforcementChange = Readonly<{ revision: number; reason: string; opa?: boolean; sentinel?: boolean }>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function parseRevision(revision: unknown): number {
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new SettingsValidationError("revision must be the integer returned by the latest settings read", true);
  }
  return revision;
}

function parseReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 2000 || reason.includes("\u0000")) {
    throw new SettingsValidationError("An explicit reason of 1 to 2000 characters is required", true);
  }
  return reason.trim();
}

function parseChange(body: unknown): EnforcementChange {
  const data = record(record(body)["data"]);
  const attrs = record(data["attributes"]);
  if (data["type"] !== undefined && data["type"] !== POLICY_ENFORCEMENT_GROUP) {
    throw new SettingsValidationError("data.type must be policy-enforcement", true);
  }
  if (Object.keys(attrs).some((key): boolean => !["revision", "reason", "opa", "sentinel"].includes(key))) {
    throw new SettingsValidationError("Only OPA and Sentinel enforcement settings can be changed", true);
  }
  const revision = parseRevision(attrs["revision"]);
  const reason = parseReason(attrs["reason"]);
  const opa = attrs["opa"];
  const sentinel = attrs["sentinel"];
  if (
    (opa !== undefined && typeof opa !== "boolean") ||
    (sentinel !== undefined && typeof sentinel !== "boolean") ||
    (opa === undefined && sentinel === undefined)
  ) {
    throw new SettingsValidationError("Specify at least one boolean OPA or Sentinel enforcement setting", true);
  }
  return {
    revision,
    reason,
    ...(opa === undefined ? {} : { opa }),
    ...(sentinel === undefined ? {} : { sentinel }),
  };
}

function resource(settings: PolicyEnforcementSettings): Record<string, unknown> {
  return { data: { id: POLICY_ENFORCEMENT_GROUP, type: POLICY_ENFORCEMENT_GROUP, attributes: settings } };
}

function hidden(set: ParamCtx["set"]): Record<string, unknown> {
  (set as { status: number }).status = 404;
  return { errors: [{ status: "404", title: "Not Found" }] };
}

async function persistChange(change: EnforcementChange, userId: string): Promise<PolicyEnforcementSettings | null> {
  return db.transaction(async (tx: unknown): Promise<PolicyEnforcementSettings | null> => {
    const t = tx as typeof db;
    await t
      .insert(adminSettings)
      .values({ id: POLICY_ENFORCEMENT_GROUP, values: POLICY_ENFORCEMENT_DEFAULTS, updatedAt: 0 })
      .onConflictDoNothing();
    const row = await t.query.adminSettings.findFirst({ where: eq(adminSettings.id, POLICY_ENFORCEMENT_GROUP) });
    if (row === undefined) throw new Error("Policy enforcement settings are unavailable");
    const before = resolvePolicyEnforcementSettings(row.values);
    if (change.revision !== before.revision) return null;
    const after = resolvePolicyEnforcementSettings({
      revision: before.revision + 1,
      opa: change.opa ?? before.opa,
      sentinel: change.sentinel ?? before.sentinel,
    });
    // The database predicate fences concurrent writers across replicas. The
    // monotonic timestamp also prevents an ABA race within one millisecond.
    const updated = await t
      .update(adminSettings)
      .set({ values: after, updatedAt: Math.max(Date.now(), row.updatedAt + 1) })
      .where(and(eq(adminSettings.id, POLICY_ENFORCEMENT_GROUP), eq(adminSettings.updatedAt, row.updatedAt)))
      .returning({ id: adminSettings.id });
    if (updated.length !== 1) return null;
    // This audit record is mandatory and atomic with the bypass. Do not use
    // the best-effort audit helper: an audit failure must roll the change back.
    await t.insert(auditLogs).values(
      auditLogValues({
        action: "update",
        resourceType: POLICY_ENFORCEMENT_GROUP,
        resourceId: POLICY_ENFORCEMENT_GROUP,
        userId,
        orgId: null,
        immutable: true,
        details: {
          reason: change.reason,
          before,
          after,
          scope: "site",
          bypass: { opa: !after.opa, sentinel: !after.sentinel },
        },
      }) as typeof auditLogs.$inferInsert,
    );
    return after;
  });
}

export const policyEnforcementAdminRoutes = new Elysia({ name: "admin-policy-enforcement" })
  .use(authPlugin)
  .get("/api/v2/admin/policy-enforcement", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    return resource(await getPolicyEnforcementSettings());
  })
  .patch("/api/v2/admin/policy-enforcement", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return hidden(set);
    const changed = await persistChange(parseChange(body), user.id);
    if (changed === null) {
      (set as { status: number }).status = 409;
      return {
        errors: [
          {
            status: "409",
            title: "Conflict",
            detail: "Policy enforcement changed. Reload the current settings and review before saving again.",
          },
        ],
      };
    }
    invalidateSettingsCache();
    return resource(changed);
  });
