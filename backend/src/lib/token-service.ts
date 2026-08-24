import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Single credential generator for every long-lived bearer secret (todo 1,
// 15-18, 59): 32 random bytes (256 bits) base64url-encoded behind a type
// prefix. Replaces the mixed `prefix-UUID` formats whose entropy varied by
// endpoint. Existing tokens stay valid until revoked — authentication accepts
// both the current keyed digest and the old unkeyed SHA-256 digest.
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
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function generateEphemeralToken(prefix: string): string {
  return opaqueToken(prefix);
}

const TOKEN_HASH_SECRET_FILE = ".token-hash-secret";
const TOKEN_HASH_SECRET_BYTES = 32;
let cachedTokenHashSecret: { identity: string; value: string } | undefined;

function readTokenHashSecret(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (Buffer.byteLength(value, "utf8") < TOKEN_HASH_SECRET_BYTES) {
    throw new Error(`Token hash secret at ${path} must be at least ${TOKEN_HASH_SECRET_BYTES} bytes`);
  }
  return value;
}

/**
 * Load a stable installation secret for token hashing. Operators running more
 * than one replica should set TERRENCE_TOKEN_HASH_SECRET identically on each
 * replica; single-node installs get a 256-bit secret persisted in STORAGE_DIR.
 */
function tokenHashSecret(): string {
  const configured = process.env.TERRENCE_TOKEN_HASH_SECRET?.trim();
  if (configured !== undefined && configured !== "") {
    if (Buffer.byteLength(configured, "utf8") < TOKEN_HASH_SECRET_BYTES) {
      throw new Error(`TERRENCE_TOKEN_HASH_SECRET must be at least ${TOKEN_HASH_SECRET_BYTES} bytes`);
    }
    return configured;
  }

  const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"));
  if (cachedTokenHashSecret?.identity === storageDir) return cachedTokenHashSecret.value;
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const path = join(storageDir, TOKEN_HASH_SECRET_FILE);
  let value: string;
  try {
    value = readTokenHashSecret(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const generated = randomBytes(TOKEN_HASH_SECRET_BYTES).toString("base64url");
    try {
      writeFileSync(path, generated, { mode: 0o600, flag: "wx" });
      value = generated;
    } catch (createError: unknown) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      value = readTokenHashSecret(path);
    }
  }
  cachedTokenHashSecret = { identity: storageDir, value };
  return value;
}

/** Keyed SHA-256 digest used for at-rest token storage. */
export function hashAuthenticationToken(token: string): string {
  return createHmac("sha256", tokenHashSecret()).update(token).digest("hex");
}

/**
 * Compatibility digest for rows written before token hashing was keyed. This
 * is only used as a read-time migration path; all new rows use the keyed hash.
 */
export function legacyHashAuthenticationToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** Current and legacy digests, ordered so callers prefer the current value. */
export function tokenHashCandidates(token: string): readonly [string, string] {
  return [hashAuthenticationToken(token), legacyHashAuthenticationToken(token)];
}

/** Backwards-compatible alias used by accounts.ts since before the service. */
export function opaqueToken(prefix: string): string {
  return `${prefix}-${randomBytes(32).toString("base64url")}`;
}

/**
 * Non-secret fingerprint shown after creation (todo 6/66): lets an operator
 * identify which credential is installed somewhere without storing/revealing
 * the secret. Last 6 characters of the keyed digest.
 */
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export const TOKEN_FORMAT_VERSION = 1 as const;

/** @lintignore Intentional surface: operator tooling (todo 6/66), consumed out-of-tree. */
export function tokenFingerprint(token: string): string {
  return hashAuthenticationToken(token).slice(-6);
}
