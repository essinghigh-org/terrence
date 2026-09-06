/**
 * Authorized resource loading boundary.
 *
 * A context records both the object that was loaded and the capability used
 * to authorize it. Capability-bearing serializers can require this context,
 * which prevents a plain readable row from silently minting a stronger URL.
 */
import type { runs, variableSets, workspaces } from "../db/schema";
import {
  canConsumeRemoteState,
  findAuthorizedRun,
  findAuthorizedVariableSet,
  findAuthorizedWorkspace,
  findRemoteStateReadableWorkspace,
  findWorkspaceByName,
} from "./utils";
import type { WorkspacePermission } from "./authorization";
import type { DeepReadonly } from "./types";

export type AuthorizedWorkspaceAccess<Capability extends WorkspacePermission = WorkspacePermission> = Readonly<{
  workspace: typeof workspaces.$inferSelect;
  capability: Capability;
}>;

export type AuthorizedRunAccess<Capability extends WorkspacePermission = WorkspacePermission> = Readonly<{
  run: typeof runs.$inferSelect;
  workspace: typeof workspaces.$inferSelect;
  capability: Capability;
}>;

export type AuthorizedRunCapability<Capability extends WorkspacePermission = WorkspacePermission> = Readonly<{
  run: DeepReadonly<typeof runs.$inferSelect>;
  capability: Capability;
}>;

export type AuthorizedVariableSetAccess<Capability extends "read-varsets" | "manage-varsets" = "read-varsets" | "manage-varsets"> = Readonly<{
  variableSet: typeof variableSets.$inferSelect;
  capability: Capability;
}>;

export type StateCapability = "state-read" | "state-write" | "state-outputs" | "admin";
export type StateCapabilitySet = StateCapability | readonly StateCapability[];
export type AuthorizedStateWorkspaceAccess = Readonly<{
  workspace: typeof workspaces.$inferSelect;
  capability: StateCapabilitySet;
}>;
export type AuthorizedStateAccess = Readonly<{ workspaceId: string; capability: StateCapabilitySet }> | AuthorizedStateWorkspaceAccess;

/** Construct a context only after the caller has completed its authorization check. */
export function authorizedWorkspaceAccess<Capability extends WorkspacePermission>(
  workspace: typeof workspaces.$inferSelect,
  capability: Capability,
): AuthorizedWorkspaceAccess<Capability> {
  return { workspace, capability };
}

/** Construct an ID-only state context for list serializers after an authorized scope query. */
export function authorizedStateAccess(
  workspaceId: string,
  capability: StateCapabilitySet,
): Readonly<{ workspaceId: string; capability: StateCapabilitySet }> {
  return { workspaceId, capability };
}

export async function findAuthorizedWorkspaceAccess<Capability extends WorkspacePermission>(
  workspaceId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  capability: Capability,
): Promise<AuthorizedWorkspaceAccess<Capability> | undefined> {
  const workspace = await findAuthorizedWorkspace(workspaceId, userId, tokenOrgId, tokenTeamId, capability);
  return workspace === undefined ? undefined : authorizedWorkspaceAccess(workspace, capability);
}

export async function findAuthorizedRunAccess<Capability extends WorkspacePermission>(
  runId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  capability: Capability,
): Promise<AuthorizedRunAccess<Capability> | undefined> {
  const authorized = await findAuthorizedRun(runId, userId, tokenOrgId, tokenTeamId, capability);
  return authorized === undefined ? undefined : { ...authorized, capability };
}

/** Attach an explicit capability to a row that was already checked by a caller. */
export function authorizedRunAccess<Capability extends WorkspacePermission>(
  authorized: Readonly<{ run: typeof runs.$inferSelect; workspace: typeof workspaces.$inferSelect }>,
  capability: Capability,
): AuthorizedRunAccess<Capability> {
  return { ...authorized, capability };
}

export function authorizedRunCapability<Capability extends WorkspacePermission>(
  run: DeepReadonly<typeof runs.$inferSelect>,
  capability: Capability,
): AuthorizedRunCapability<Capability> {
  return { run, capability };
}

export async function findAuthorizedVariableSetAccess<Capability extends "read-varsets" | "manage-varsets">(
  variableSetId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  capability: Capability,
): Promise<AuthorizedVariableSetAccess<Capability> | undefined> {
  const variableSet = await findAuthorizedVariableSet(variableSetId, userId, tokenOrgId, tokenTeamId, capability);
  return variableSet === undefined ? undefined : { variableSet, capability };
}

export {
  canConsumeRemoteState,
  findAuthorizedRun,
  findAuthorizedVariableSet,
  findAuthorizedWorkspace,
  findRemoteStateReadableWorkspace,
  findWorkspaceByName,
};
