import { randomUUID } from "node:crypto";
import { isPostgres } from "../db/driver";
import { booleanSetting, deploymentSecret, executionSetting, listenerSetting } from "./runtime-config";

export const controlPlaneInstanceId = `terrence-${process.pid}-${randomUUID()}`;

export function haEnabled(): boolean {
  return booleanSetting("TERRENCE_HA_ENABLED");
}

export function controlPlaneNodeId(): string {
  const configured = process.env["TERRENCE_NODE_ID"]?.trim();
  return configured === undefined || configured === "" ? "terrence-node-1" : configured;
}

export function coordinatorEligible(): boolean {
  return haEnabled() && !booleanSetting("TERRENCE_DISABLE_WORKER");
}

/**
 * HA deliberately fails closed. A cluster cannot safely tolerate per-replica
 * generated secrets, an implicit local storage path, or an ambiguous node id.
 * STORAGE_DIR still has to be backed by shared POSIX storage; Terrence can
 * require the operator to configure it but cannot prove the mount topology.
 */
export function assertHaConfiguration(): void {
  if (!haEnabled()) return;

  const missing: string[] = [];
  if (!isPostgres) missing.push("PostgreSQL DATABASE_URL");
  if (process.env["TERRENCE_NODE_ID"]?.trim() === undefined || process.env["TERRENCE_NODE_ID"]?.trim() === "") {
    missing.push("TERRENCE_NODE_ID");
  }
  if (executionSetting("PUBLIC_URL") === null) missing.push("PUBLIC_URL");
  if (process.env["STORAGE_DIR"]?.trim() === undefined || process.env["STORAGE_DIR"]?.trim() === "") {
    missing.push("STORAGE_DIR");
  }
  for (const name of ["ENCRYPTION_PASSWORD", "TERRENCE_TOKEN_HASH_SECRET", "SIGNED_URL_SECRET"] as const) {
    if (deploymentSecret(name) === undefined) missing.push(name);
  }

  if (missing.length > 0) {
    throw new Error(`TERRENCE_HA_ENABLED requires explicit shared cluster configuration: ${missing.join(", ")}`);
  }

  // Force path validation here so HA startup never gets past validation with a
  // path that only happened to be read later by a storage consumer.
  void listenerSetting("STORAGE_DIR");
}
