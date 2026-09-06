/**
 * Authorized resource loading boundary.
 *
 * A context records both the object that was loaded and the capability used
 * to authorize it. Capability-bearing serializers can require this context,
 * which prevents a plain readable row from silently minting a stronger URL.
 */
import type { runs, workspaces } from "../db/schema";
import {
  findAuthorizedRun,
  findAuthorizedWorkspace,
  findRemoteStateReadableWorkspace,
} from "./utils";
import type { WorkspacePermission } from "./authorization";
import type { DeepReadonly } from "./types";

export type AuthorizedRunCapability<Capability extends WorkspacePermission = WorkspacePermission> = Readonly<{
  run: DeepReadonly<typeof runs.$inferSelect>;
  capability: Capability;
}>;

export type StateCapability = "state-read" | "state-write" | "state-outputs" | "admin";
export type StateCapabilitySet = StateCapability | readonly StateCapability[];
export type AuthorizedStateWorkspaceAccess = Readonly<{
  workspace: typeof workspaces.$inferSelect;
  capability: StateCapabilitySet;
}>;
export type AuthorizedStateAccess = Readonly<{ workspaceId: string; capability: StateCapabilitySet }> | AuthorizedStateWorkspaceAccess;

/** Construct an ID-only state context for list serializers after an authorized scope query. */
export function authorizedStateAccess(
  workspaceId: string,
  capability: StateCapabilitySet,
): Readonly<{ workspaceId: string; capability: StateCapabilitySet }> {
  return { workspaceId, capability };
}

export function authorizedRunCapability<Capability extends WorkspacePermission>(
  run: DeepReadonly<typeof runs.$inferSelect>,
  capability: Capability,
): AuthorizedRunCapability<Capability> {
  return { run, capability };
}

export {
  findAuthorizedRun,
  findAuthorizedWorkspace,
  findRemoteStateReadableWorkspace,
};
