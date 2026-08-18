// Wire serialization for stored vcs-repo JSON blobs.
//
// The DB stores vcs-repo settings with camelCase keys (oauthTokenId,
// githubAppInstallationId, ...), but the the reference format API contract — and therefore
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

function isBraceQuantifierStart(pattern: string, index: number): boolean {
  if (pattern[index] !== "{") return false;
  const end = pattern.indexOf("}", index);
  if (end === -1) return false;
  return /^\d+(,\d*)?$/.test(pattern.slice(index + 1, end));
}

function isGroupQuantifier(pattern: string, index: number): boolean {
  const char = pattern[index] ?? "";
  return char === "*" || char === "+" || char === "?" || isBraceQuantifierStart(pattern, index);
}

function hasNestedQuantifiers(pattern: string): boolean {
  const openGroups: boolean[] = [];
  let inClass = false;
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") { inClass = true; continue; }
    if (char === "(") { openGroups.push(false); continue; }
    if (char === ")") {
      const nested = openGroups.pop() ?? false;
      if (nested && isGroupQuantifier(pattern, index + 1)) return true;
      if (nested && openGroups.length > 0) openGroups[openGroups.length - 1] = true;
      continue;
    }
    if (char === "*" || char === "+" || char === "?" || isBraceQuantifierStart(pattern, index)) {
      if (openGroups.length > 0) openGroups[openGroups.length - 1] = true;
    }
  }
  return false;
}

/** Reject bounded but potentially catastrophic tag patterns at the API boundary. */
export function isValidTagsRegex(pattern: string): boolean {
  if (pattern.length > 256) return false;
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch {
    return false;
  }
  if (hasNestedQuantifiers(pattern)) return false;
  return (compiled.source.match(/\|/g) ?? []).length <= 100;
}

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
