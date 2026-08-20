import { createHash, randomBytes } from "node:crypto";

// Single credential generator for every long-lived bearer secret (todo 1,
// 15-18, 59): 32 random bytes (256 bits) base64url-encoded behind a type
// prefix. Replaces the mixed `prefix-UUID` formats whose entropy varied by
// endpoint. Existing tokens stay valid until revoked — authentication is a
// SHA-256 lookup, so generation format does not affect old rows.
//
// Resource IDs stay UUIDs (todo 3/18/421): they are identifiers, not secrets,
// and keep their existing shapes for compatibility.

/**
 * Generate a 256-bit opaque bearer secret with a type prefix, e.g.
 * `user-<43 base64url chars>`. Used for user/org/team/CLI/agent credentials.
 */
export function generateAuthenticationToken(prefix: string): string {
  return opaqueToken(prefix);
}

/**
 * Generate a short/ephemeral credential (refresh, MFA recovery, OAuth codes,
 * run tokens). Same entropy, distinct prefix convention at the call site.
 */
export function generateEphemeralToken(prefix: string): string {
  return opaqueToken(prefix);
}

/** SHA-256 hex digest used for at-rest token storage. */
export function hashAuthenticationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Backwards-compatible alias used by accounts.ts since before the service. */
export function opaqueToken(prefix: string): string {
  return `${prefix}-${randomBytes(32).toString("base64url")}`;
}

/**
 * Non-secret fingerprint shown after creation (todo 6/66): lets an operator
 * identify which credential is installed somewhere without storing/revealing
 * the secret. Last 6 characters of the SHA-256 digest.
 */
export function tokenFingerprint(token: string): string {
  return hashAuthenticationToken(token).slice(-6);
}
