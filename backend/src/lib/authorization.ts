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
  workspaceIdsForPermission,
  checkWorkspacePermission,
  checkRunStateAccess,
} from "./utils";

export type {
  WorkspacePermission,
} from "./utils";
