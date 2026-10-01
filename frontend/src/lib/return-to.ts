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
 * Terraform OAuth is different: its opaque server-side state is carried to an
 * SSO entry point and resumed at /oauth/authorization/complete after login.
 * The helper below preserves that state without exposing the PKCE request.
 */
export function resolveReturnTarget(returnTo: unknown): string {
  if (!isString(returnTo) || (returnTo !== "/app" && !returnTo.startsWith("/app/"))) return "/app";
  if (returnTo.startsWith("//")) return "/app";
  if (/[\r\n]/.test(returnTo) || returnTo.includes("/../")) return "/app";
  return returnTo;
}

/** Query suffix carried from the login page into SAML/OIDC. OAuth state wins
 * over a normal app destination because a Terraform handshake has exactly one
 * server-controlled continuation. */
export function ssoContinuationQuery(oauthState: unknown, returnTo: unknown): string {
  const params = new URLSearchParams();
  if (isString(oauthState) && oauthState !== "") {
    params.set("oauth_state", oauthState);
  } else if (isString(returnTo) && resolveReturnTarget(returnTo) === returnTo) {
    params.set("returnTo", returnTo);
  }
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

/**
 * Login URL preserving the current location across an authentication
 * round-trip (issue #738). Only same-origin /app destinations are carried;
 * everything else (including the login page itself) uses the plain login
 * so expiry can never manufacture an open redirect or a login loop.
 */
export function loginPathWithReturnTo(
  pathname: string,
  search: string,
  hash: string,
  extraParams?: Readonly<Record<string, string>>,
): string {
  const target = `${pathname}${search}${hash}`;
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    const params = new URLSearchParams();
    params.set("returnTo", target);
    if (extraParams !== undefined) {
      for (const [key, value] of Object.entries(extraParams)) params.set(key, value);
    }
    return `/login?${params.toString()}`;
  }
  return "/login";
}
