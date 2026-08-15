// First-user (initial site admin) election serialization.
//
// Both bootstrap paths (ADMIN_PASSWORD and the installer IACT bootstrap)
// run a count-then-insert inside a transaction to elect the first user as
// site admin. On PostgreSQL that is not atomic by default: two concurrent
// transactions can both observe zero users and both insert an admin. SQLite
// is safe (single connection, serialized writers), but the pooled postgres.js
// backend can interleave. A transaction-scoped advisory lock serializes the
// election on PostgreSQL and is a no-op elsewhere.
import { sql, type SQL } from "drizzle-orm";
import { isPostgres } from "./driver";

// Arbitrary stable key (ASCII "terr"); only meaningful within this database.
const FIRST_USER_LOCK_KEY = 0x74657272;

/**
 * Serializes the initial-user election inside an already-open transaction.
 * Call BEFORE the user count check. No-op on SQLite, where the single
 * connection already serializes transactions.
 */
export async function lockFirstUserElection(tx: unknown): Promise<void> {
  if (!isPostgres) return;
  // SAFETY: only the postgres-js drizzle client (which always exposes
  // execute()) reaches this call; the sqlite AppDb type is a runtime no-op.
  const client = tx as { readonly execute: (query: SQL) => Promise<unknown> };
  await client.execute(sql`SELECT pg_advisory_xact_lock(${FIRST_USER_LOCK_KEY})`);
}
