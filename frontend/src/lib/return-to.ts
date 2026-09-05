import { isString } from "./type-guards";

/**
 * Shared post-auth destination validator (issue #642).
 *
 * Login, Register, and any future auth entry point must agree on which
 * `returnTo` values are safe to restore after sign-in. Only same-origin /app
 * paths are honored so the flag can never act as an open redirect:
 * protocol-relative URLs, CR/LF injection, and path traversal all fall back
 * to the app home.
 *
 * The OAuth handshake needs no destination of its own: `terraform login`
 * completes server-side at /oauth/authorization/complete, which never takes
 * a redirect target, so there is no second SPA implementation to unify.
 */
export function resolveReturnTarget(returnTo: unknown): string {
  if (!isString(returnTo) || (returnTo !== "/app" && !returnTo.startsWith("/app/"))) return "/app";
  if (returnTo.startsWith("//")) return "/app";
  if (/[\r\n]/.test(returnTo) || returnTo.includes("/../")) return "/app";
  return returnTo;
}
