/** Shared identity convention for short-lived impersonation API tokens. */
export const IMPERSONATION_TOKEN_PREFIX = "impersonation-";

export function isImpersonationTokenId(id: string | null | undefined): boolean {
  return id?.startsWith(IMPERSONATION_TOKEN_PREFIX) === true;
}
