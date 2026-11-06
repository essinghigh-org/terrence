import { eq } from "drizzle-orm";
import { db } from "../db";
import { adminSettings } from "../db/schema";
import type { DeepReadonly } from "./types";
import { validateSettings } from "./settings-contract";

export const POLICY_ENFORCEMENT_GROUP = "policy-enforcement";
export const POLICY_ENFORCEMENT_DEFAULTS = Object.freeze({ revision: 0, opa: true, sentinel: true });

export type PolicyEnforcementSettings = Readonly<{ revision: number; opa: boolean; sentinel: boolean }>;

/** Missing settings enforce both engines. Invalid persisted values fail closed. */
export function resolvePolicyEnforcementSettings(values: Readonly<Record<string, unknown>>): PolicyEnforcementSettings {
  const settings = { ...POLICY_ENFORCEMENT_DEFAULTS, ...values };
  validateSettings(POLICY_ENFORCEMENT_GROUP, settings);
  return settings;
}

/** Policy gates deliberately bypass the process-local settings cache. */
export async function getPolicyEnforcementSettings(
  database: DeepReadonly<typeof db> = db,
): Promise<PolicyEnforcementSettings> {
  const row = await database.query.adminSettings.findFirst({ where: eq(adminSettings.id, POLICY_ENFORCEMENT_GROUP) });
  return resolvePolicyEnforcementSettings(row?.values ?? {});
}
