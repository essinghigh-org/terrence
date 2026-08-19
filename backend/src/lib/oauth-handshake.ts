// DB-backed store for OAuth handshake state (the `state` value exchanged during
// the VCS provider authorization-code / OAuth1 flows).
//
// This replaces the in-process Map that previously lived in the OAuth routes.
// That Map was replica-local: under a multi-instance deployment a callback
// landing on a different replica than the one that started the flow would find
// no state and the connection would fail. Persisting the state lets any replica
// read and consume it. The table is created idempotently at boot
// (src/db/index.ts) for both the sqlite and postgres backends, so no generated
// migration is needed and a sparse/legacy journal that re-applies the boot path
// stays safe.
//
// The payload is opaque to this module; callers cast to their own discriminated
// union type on read. Rows carry an `expiresAt` so a periodic sweep (pruneExpired)
// can drop stale handshakes, and read paths filter on it so an expired state can
// never be resurrected.
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { oauthHandshakeStates } from "../db/schema";

export type OAuthHandshakePayload = Record<string, unknown>;

/** Persist a handshake. Overwrites any prior state for the same id. */
export async function putOAuthHandshakeState(
  id: string,
  expiresAt: number,
  payload: Readonly<OAuthHandshakePayload>,
): Promise<void> {
  await db.insert(oauthHandshakeStates).values({ id, expiresAt, payload })
    .onConflictDoUpdate({ target: oauthHandshakeStates.id, set: { expiresAt, payload } });
}

/**
 * Atomically read-and-delete a handshake if it exists and has not expired.
 * Returns undefined (and leaves nothing) when the id is unknown or expired.
 * Consumption is one-shot: a second call for the same id returns undefined.
 */
export async function takeOAuthHandshakeState<T extends OAuthHandshakePayload>(
  id: string,
  now = Date.now(),
): Promise<T | undefined> {
  const [row] = await db.delete(oauthHandshakeStates)
    .where(and(
      eq(oauthHandshakeStates.id, id),
      gt(oauthHandshakeStates.expiresAt, now),
    ))
    .returning({ payload: oauthHandshakeStates.payload });
  // Single atomic statement: the row is deleted only if it exists AND is
  // unexpired, so two concurrent callbacks (or two replicas) can never both
  // receive the same state.
  return row?.payload as T | undefined;
}

/** Drop handshakes whose TTL has elapsed. Safe to call periodically. */
export async function pruneExpiredOAuthHandshakeStates(now = Date.now()): Promise<number> {
  const deleted = await db.delete(oauthHandshakeStates)
    .where(lt(oauthHandshakeStates.expiresAt, now))
    .returning({ id: oauthHandshakeStates.id });
  return deleted.length;
}

/** Advisory count of live handshakes (diagnostics only). */
export async function countOAuthHandshakeStates(now = Date.now()): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` })
    .from(oauthHandshakeStates)
    .where(gt(oauthHandshakeStates.expiresAt, now));
  return rows[0]?.count ?? 0;
}
