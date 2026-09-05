import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { consumeSsoChallenge, storeSsoChallenge } from "./sso-challenges";

/**
 * Short-lived MFA (TOTP) login challenges shared by every interactive
 * authentication entry point: the browser JSON login flow (/users/login/mfa)
 * and the Terraform CLI OAuth authorization flow (/oauth/authorization).
 *
 * The token is persisted in the shared single-use challenge store. This keeps
 * MFA completion valid when the two requests land on different replicas and
 * makes consumption atomic so a challenge cannot be replayed.
 */

const MFA_CHALLENGE_KIND = "mfa-login";
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Issue a challenge token bound to a user. Returns the opaque token. */
export async function issueMfaChallenge(userId: string): Promise<string> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { passwordHash: true } });
  if (user === undefined) throw new Error("MFA user not found");
  const credential = createHash("sha256").update(user.passwordHash).digest("hex");
  const token = `mfa-${randomBytes(32).toString("base64url")}`;
  const written = await storeSsoChallenge(
    MFA_CHALLENGE_KIND,
    token,
    { userId, credential },
    Date.now() + MFA_CHALLENGE_TTL_MS,
  );
  if (!written) throw new Error("MFA challenge token collision");
  return token;
}

/**
 * Consume a challenge token. Returns the bound user id on success, or null
 * when the token is missing, expired, malformed, or already consumed.
 */
export async function consumeMfaChallenge(token: string): Promise<{ userId: string } | null> {
  const payload = await consumeSsoChallenge(MFA_CHALLENGE_KIND, token);
  const userId = payload?.["userId"];
  if (typeof userId !== "string" || userId === "" || typeof payload?.["credential"] !== "string") return null;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { passwordHash: true } });
  // A password reset also invalidates partially completed logins, on every replica.
  if (user === undefined || createHash("sha256").update(user.passwordHash).digest("hex") !== payload["credential"]) return null;
  return { userId };
}
