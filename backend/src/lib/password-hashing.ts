import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";

export const PASSWORD_HASH_ALGORITHM = "bcrypt" as const;
export const PASSWORD_HASH_COST = 12;

// This is a valid bcrypt hash of a random value that is not stored anywhere.
// It keeps nonexistent-user login attempts on the same verification path as
// real accounts without making any password a documented shared secret.
const DUMMY_PASSWORD_HASH = "$2b$12$jbY1EixIl9ckVE4L3.egUOlXQtz0ztvpry6zyi1wyWenHqa8VcgzS";

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: PASSWORD_HASH_ALGORITHM,
    cost: PASSWORD_HASH_COST,
  });
}

/** Compare local passwords safely, including nonexistent and unusable accounts. */
export async function passwordMatches(password: string, passwordHash = DUMMY_PASSWORD_HASH): Promise<boolean> {
  try {
    return await Bun.password.verify(password, passwordHash);
  } catch {
    return false;
  }
}

/** Return true when a successful verification should replace an old hash. */
export function needsPasswordHashUpgrade(passwordHash: string): boolean {
  const bcryptCost = /^\$2[aby]\$(\d{2})\$/.exec(passwordHash)?.[1];
  return bcryptCost === undefined || Number(bcryptCost) < PASSWORD_HASH_COST;
}

/**
 * Verify a user's password and transparently upgrade a legacy hash. The
 * compare-and-set update makes concurrent logins harmless: only a row still
 * carrying the hash that was verified can be replaced.
 */
export async function verifyAndUpgradePassword(
  userId: string,
  password: string,
  passwordHash: string,
): Promise<boolean> {
  if (!(await passwordMatches(password, passwordHash))) return false;
  if (!needsPasswordHashUpgrade(passwordHash)) return true;

  const upgradedHash = await hashPassword(password);
  await db.update(users)
    .set({ passwordHash: upgradedHash })
    .where(and(eq(users.id, userId), eq(users.passwordHash, passwordHash)));
  return true;
}
