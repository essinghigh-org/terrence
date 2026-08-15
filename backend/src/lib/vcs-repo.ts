// Wire serialization for stored vcs-repo JSON blobs.
//
// The DB stores vcs-repo settings with camelCase keys (oauthTokenId,
// githubAppInstallationId, ...), but the TFE API contract — and therefore
// go-tfe, which the tfe provider uses to parse responses — uses kebab-case
// attribute names (oauth-token-id, github-app-installation-id, ...). Every
// API response that embeds a vcs-repo object must map through this helper.
// Emitting the raw stored JSON silently drops the credential keys on the
// provider read path: go-tfe ignores unknown attributes, so state ends up
// with empty oauth_token_id / github_app_installation_id while config has
// the real value — a perpetual vcs_repo diff (ForceNew) on every plan.

export type StoredVcsRepo = Readonly<{
  branch?: string | null;
  identifier?: string | null;
  oauthTokenId?: string | null;
  githubAppInstallationId?: string | null;
  ingressSubmodules?: boolean | null;
  tagsRegex?: string | null;
}>;

export function vcsRepoResource(vcsRepo: StoredVcsRepo | null): Record<string, unknown> | null {
  if (vcsRepo === null) return null;
  return {
    branch: vcsRepo.branch ?? null,
    identifier: vcsRepo.identifier ?? null,
    "oauth-token-id": vcsRepo.oauthTokenId ?? null,
    "github-app-installation-id": vcsRepo.githubAppInstallationId ?? null,
    "ingress-submodules": vcsRepo.ingressSubmodules ?? false,
    "tags-regex": vcsRepo.tagsRegex ?? null,
  };
}
