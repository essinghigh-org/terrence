import { appendSetCookies } from "./sso";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_MS, peekPendingAuth } from "../oauth";

/**
 * Validated post-auth continuation carried through an SSO round-trip.
 *
 * A signed-out user starting `terraform login`, or an unauthenticated deep
 * link, must survive the SAML/OIDC redirect chain to complete the original
 * handshake or return to the intended page. Carrying either value in an URL
 * query string alone is unsafe (value is client-controlled), so the
 * continuation is persisted server-side alongside the SSO challenge and only
 * resumed after a successful callback.
 */
export type SsoContinuation = Readonly<{
  oauthState: string | null;
  returnTo: string | null;
}>;

export type ContinuationValidation =
  | { continuation: SsoContinuation }
  | { error: "oauth-state-invalid" | "return-to-invalid" };

/** Only same-origin /app destinations are honored (open-redirect prevention). */
export function safeReturnTarget(returnTo: unknown): string | null {
  if (typeof returnTo !== "string" || returnTo === "") return null;
  if (returnTo !== "/app" && !returnTo.startsWith("/app/")) return null;
  if (returnTo.startsWith("//")) return null;
  if (/[\r\n]/.test(returnTo) || returnTo.includes("/../")) return null;
  return returnTo;
}

/** Validate the optional continuation params on the SSO start endpoint. */
export async function validateSsoContinuation(
  query: Readonly<Record<string, unknown>>,
): Promise<ContinuationValidation> {
  const rawOauthState = query["oauth_state"];
  const rawReturnTo = query["returnTo"];
  let oauthState: string | null = null;
  if (typeof rawOauthState === "string" && rawOauthState !== "") {
    const pending = await peekPendingAuth(rawOauthState).catch(() => undefined);
    if (pending === undefined || pending.expiresAt <= Date.now()) {
      return { error: "oauth-state-invalid" };
    }
    oauthState = rawOauthState;
  }
  let returnTo: string | null = null;
  if (typeof rawReturnTo === "string" && rawReturnTo !== "") {
    const target = safeReturnTarget(rawReturnTo);
    if (target === null) return { error: "return-to-invalid" };
    returnTo = target;
  }
  return { continuation: { oauthState, returnTo } };
}

/** Read the validated continuation back out of a consumed SSO challenge. */
export function continuationFromChallenge(payload: unknown): SsoContinuation {
  if (payload === null || typeof payload !== "object") return { oauthState: null, returnTo: null };
  const record = payload as Record<string, unknown>;
  const oauthState = typeof record["oauthState"] === "string" ? record["oauthState"] : null;
  const returnTo = typeof record["returnTo"] === "string" ? record["returnTo"] : null;
  return {
    oauthState: oauthState !== null && oauthState !== "" ? oauthState : null,
    returnTo: returnTo !== null && returnTo !== "" ? safeReturnTarget(returnTo) : null,
  };
}

/**
 * Build the post-SSO response for a validated continuation, or null when the
 * caller should fall back to its normal landing page.
 *
 * The OAuth state cookie is re-issued here because the IdP round-trip returns
 * through a cross-site POST/GET that cannot carry a SameSite=Lax cookie; the
 * completion route requires both the query parameter and the cookie.
 */
export function continuationResponse(
  continuation: SsoContinuation,
  set: Readonly<{ headers: Readonly<Record<string, string | number | readonly string[]>> }>,
  secure: boolean,
): Response | null {
  const sessionCookies = set.headers["Set-Cookie"];
  if (continuation.oauthState !== null) {
    const state = continuation.oauthState;
    const response = new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: `/oauth/authorization/complete?oauth_state=${encodeURIComponent(state)}`,
        "Set-Cookie": `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}${secure ? "; Secure" : ""}`,
      },
    });
    appendSetCookies(response, sessionCookies);
    return response;
  }
  if (continuation.returnTo !== null) {
    const response = new Response(null, {
      status: 302,
      headers: { "Cache-Control": "no-store", Location: continuation.returnTo },
    });
    appendSetCookies(response, sessionCookies);
    return response;
  }
  return null;
}
