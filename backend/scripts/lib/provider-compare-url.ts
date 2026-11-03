/** Only canonical numeric release identifiers may leave the local catalog. */
function releaseTag(version: string): string {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new Error("Invalid provider comparison version");
  }
  const parts = version.split(".");
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error("Invalid provider comparison version");
  // Reconstruct from numbers rather than forwarding file or environment strings.
  return `v${major}.${minor}.${patch}`;
}

export function providerCompareUrl(current: string, target: string): string {
  return `https://api.github.com/repos/hashicorp/terraform-provider-tfe/compare/${releaseTag(current)}...${releaseTag(target)}`;
}
