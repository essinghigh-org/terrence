import { randomBytes } from "node:crypto";

/**
 * Short-lived MFA (TOTP) login challenges shared by every interactive
 * authentication entry point: the browser JSON login flow (/users/login/mfa)
 * and the Terraform CLI OAuth authorization flow (/oauth/authorization).
 *
 * Challenges are held in-memory with a fixed TTL. Single-process deployment
 * (the Terrence deploy model); if horizontal scaling is added, this store
 * must move to shared persistence or be pinned to a node via session affinity.
 */

const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

type MfaChallenge = {
  userId: string;
  expiresAt: number;
};

const mfaChallenges = new Map<string, MfaChallenge>();

/** Issue a challenge token bound to a user. Returns the opaque token. */
export function issueMfaChallenge(userId: string): string {
  const token = `mfa-${randomBytes(32).toString("base64url")}`;
  const expiresAt = Date.now() + MFA_CHALLENGE_TTL_MS;
  mfaChallenges.set(token, { userId, expiresAt });
  // Self-expiring cleanup aligned to the exact issued expiry, so a late
  // overwrite of the same key does not prematurely evict a newer challenge.
  setTimeout((): void => {
    const current = mfaChallenges.get(token);
    if (current !== undefined && current.expiresAt === expiresAt) mfaChallenges.delete(token);
  }, MFA_CHALLENGE_TTL_MS);
  return token;
}

/**
 * Consume a challenge token. Returns the bound user id on success, or null
 * when the token is missing, expired, or already consumed. Consuming is
 * one-shot: a valid token is always deleted.
 */
export function consumeMfaChallenge(token: string): { userId: string } | null {
  const challenge = mfaChallenges.get(token);
  if (challenge === undefined || challenge.expiresAt < Date.now()) {
    mfaChallenges.delete(token);
    return null;
  }
  mfaChallenges.delete(token);
  return { userId: challenge.userId };
}
