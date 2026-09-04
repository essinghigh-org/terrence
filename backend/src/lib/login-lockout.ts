import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";

/** Five failures in one window lock password login for the same account. */
export const LOGIN_FAILURE_THRESHOLD = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

type LoginLockoutState = Pick<
  typeof users.$inferSelect,
  "loginFailedAttempts" | "loginFailureWindowStartedAt" | "loginLockedUntil"
>;

export function isLoginLocked(user: Readonly<LoginLockoutState>, now = Date.now()): boolean {
  return user.loginLockedUntil !== null && user.loginLockedUntil > now;
}

/**
 * Increment an account's failed-login state atomically. The CASE expressions
 * run inside one UPDATE, so concurrent requests on different replicas cannot
 * overwrite each other's attempts with a stale read.
 */
export async function recordFailedLogin(
  userId: string,
  now = Date.now(),
): Promise<Readonly<{ failedAttempts: number; lockedUntil: number | null }>> {
  const windowCutoff = now - LOGIN_FAILURE_WINDOW_MS;
  const windowExpired = sql`
    ${users.loginFailureWindowStartedAt} IS NULL
    OR ${users.loginFailureWindowStartedAt} <= ${windowCutoff}
  `;
  const nextAttempts = sql<number>`
    CASE
      WHEN ${windowExpired} THEN 1
      ELSE ${users.loginFailedAttempts} + 1
    END
  `;
  const nextWindowStart = sql<number | null>`
    CASE
      WHEN ${windowExpired} THEN ${now}
      ELSE ${users.loginFailureWindowStartedAt}
    END
  `;
  const nextLockedUntil = sql<number | null>`
    CASE
      WHEN ${users.loginLockedUntil} IS NOT NULL AND ${users.loginLockedUntil} > ${now}
        THEN ${users.loginLockedUntil}
      WHEN ${windowExpired} THEN NULL
      WHEN ${users.loginFailedAttempts} + 1 >= ${LOGIN_FAILURE_THRESHOLD} THEN ${now + LOGIN_LOCKOUT_MS}
      ELSE ${users.loginLockedUntil}
    END
  `;
  const rows = await db.update(users)
    .set({
      loginFailedAttempts: nextAttempts,
      loginFailureWindowStartedAt: nextWindowStart,
      loginLockedUntil: nextLockedUntil,
    })
    .where(eq(users.id, userId))
    .returning({
      failedAttempts: users.loginFailedAttempts,
      lockedUntil: users.loginLockedUntil,
    });
  const row = rows[0];
  return {
    failedAttempts: row?.failedAttempts ?? 0,
    lockedUntil: row?.lockedUntil ?? null,
  };
}

/**
 * Clear failure state after a successful password authentication. The lock
 * predicate makes this a compare-and-clear: a lock set after the initial
 * lookup cannot be erased by a racing successful login.
 */
export async function clearLoginFailures(userId: string, now = Date.now()): Promise<boolean> {
  const rows = await db.update(users)
    .set({
      loginFailedAttempts: 0,
      loginFailureWindowStartedAt: null,
      loginLockedUntil: null,
    })
    .where(and(
      eq(users.id, userId),
      or(isNull(users.loginLockedUntil), lte(users.loginLockedUntil, now)),
    ))
    .returning({ id: users.id });
  return rows.length > 0;
}
