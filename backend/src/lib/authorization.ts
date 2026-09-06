/**
 * Authorization decisions are kept behind this named boundary.
 *
 * The implementation remains compatible with the legacy facade while callers
 * can now make the trust boundary visible at the import site. Resource
 * loading belongs in authorized-resources.ts; serializers must not import
 * this module to decide access implicitly.
 */
export {
  checkOrgPermission,
  checkOrganizationPermission,
  checkOrganizationPermissionsMany,
  checkOrganizationVcsReadPermission,
  scopeWorkspaceIdsForOrg,
  workspaceIdsForPermission,
  workspacePermissionSets,
  workspaceAllows,
  checkWorkspacePermission,
  checkRunRegistryRead,
  checkRunStateAccess,
  checkRegistryReadPermission,
} from "./utils";

export type {
  OrganizationPermission,
  WorkspacePermission,
  WorkspacePermissionSets,
  RunPrincipal,
} from "./utils";
