// Generic cross-replica mutex backed by the `locks` table.
//
// Used where a read-modify-write (or any non-reentrant) operation must not run
// concurrently across instances — today the auth-settings update path
// (admin/helpers.ts withAuthSettingsLock). A single-process deployment gets the
// same serialization from the in-process Promise queue kept there; this lock
// adds correctness when the postgres backend runs as multiple replicas.
//
// Claim mirrors durable_jobs / registry-sync-lease: INSERT ... ON CONFLICT DO
// UPDATE SET ... WHERE the prior lease has expired, then read back ownership.
// The caller polls (bounded, with backoff) until it owns the name, runs the
// operation, then releases. expiresAt bounds the lock so a crashed holder
// cannot block the name forever; a later claimant reclaims an expired lock.
//
// While the operation runs, an owner-checked interval renews the lock so it
// never becomes reclaimable mid-write. If a renewal fails (ownership lost or a
// database error), the operation result is surfaced along with the loss so the
// caller knows its critical section may not have been exclusive.
//
// The table is created idempotently at boot (src/db/index.ts) for both
// backends, so no generated migration is needed.
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { locks } from "../db/schema";
import { log } from "./log";

// A lock is held at most this long; well above any realistic settings write,
// short enough that a crashed holder is reclaimed quickly.
const DB_LOCK_TTL_MS = 30_000;
// Poll cadence while waiting for a contended lock.
const DB_LOCK_RETRY_MS = 50;
// Hard ceiling on total wait before giving up (covers a wedged/dead holder
// whose lease we should have reclaimed — surfaced as an error, not a hang).
const DB_LOCK_MAX_WAIT_MS = 30_000;
// Renewal cadence while the operation runs: well inside TTL, so the lock
// cannot expire during a slow operation and be claimed by another replica.
const DB_LOCK_RENEWAL_MS = DB_LOCK_TTL_MS / 2;

/** Try to claim `name`. Returns true if this attempt now owns it. */
async function claimLock(name: string, owner: string, now: number): Promise<boolean> {
  const expiresAt = now + DB_LOCK_TTL_MS;
  await db.insert(locks).values({ name, owner, expiresAt })
    .onConflictDoUpdate({
      target: locks.name,
      set: { owner, expiresAt },
      where: lt(locks.expiresAt, now),
    });
  const row = await db.query.locks.findFirst({ where: eq(locks.name, name) });
  return row?.owner === owner;
}

/**
 * Extend the lock for the current owner. Returns false when the lock expired
 * and another replica took it over (or the row is gone), so the holder can be
 * told it no longer owns the name.
 */
async function renewLock(name: string, owner: string, now: number): Promise<boolean> {
  const updated = await db.update(locks)
    .set({ expiresAt: now + DB_LOCK_TTL_MS })
    .where(and(eq(locks.name, name), eq(locks.owner, owner)))
    .returning({ name: locks.name });
  return updated.length === 1;
}

/** Release a lock this attempt holds. Safe to call when not the owner. */
async function releaseLock(name: string, owner: string): Promise<void> {
  await db.delete(locks).where(and(eq(locks.name, name), eq(locks.owner, owner)));
}

/**
 * Run `operation` while holding the named cross-replica lock. Serializes across
 * instances; concurrent callers on the same name wait (bounded) for the holder
 * to finish. Throws if the lock cannot be acquired within DB_LOCK_MAX_WAIT_MS.
 */
export async function withDbLock<T>(
  name: string,
  operation: () => Promise<T>,
  now = Date.now(),
): Promise<T> {
  const owner = `db-lock-${crypto.randomUUID()}`;
  const deadline = now + DB_LOCK_MAX_WAIT_MS;
  let acquired = false;
  let lost = false;
  let renewalTimer: ReturnType<typeof setInterval> | null = null;
  try {
    while (Date.now() < deadline) {
      if (await claimLock(name, owner, Date.now())) {
        acquired = true;
        // Renew on an interval while the operation runs: an owner-checked
        // UPDATE so only this holder can extend it, keeping the lock from
        // expiring mid-write and being reclaimed by another replica.
        renewalTimer = setInterval((): void => {
          renewLock(name, owner, Date.now()).then(
            (ok): void => { if (!ok) lost = true; },
            (error: unknown): void => {
              lost = true;
              log.error("Failed to renew database lock", { name, error });
            },
          );
        }, DB_LOCK_RENEWAL_MS);
        const result = await operation();
        if (lost) {
          // The renewal failed or another replica reclaimed the lock during
          // the operation; the critical section may not have been exclusive.
          throw new Error(`Database lock "${name}" was lost during the operation`);
        }
        return result;
      }
      await Bun.sleep(DB_LOCK_RETRY_MS);
    }
    throw new Error(`Timed out acquiring database lock "${name}"`);
  } finally {
    if (renewalTimer !== null) clearInterval(renewalTimer);
    if (acquired) {
      try {
        await releaseLock(name, owner);
      } catch (error: unknown) {
        // A failed deletion must not mask the operation's result; the lease
        // expiry guard reclaims the lock on the next claimant.
        log.error("Failed to release database lock", { name, error });
      }
    }
  }
}