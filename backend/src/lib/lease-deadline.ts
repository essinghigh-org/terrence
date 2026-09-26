/**
 * Convert a database lease expiry into a conservative local monotonic
 * lifetime. The database timestamp is sampled while the query executes; time
 * spent waiting for that query to return must not be added back to the lease.
 * Subtracting the full local query duration is intentionally conservative.
 */
export function conservativeLeaseRemainingMs(
  expiresAt: number,
  databaseNow: number,
  queryStartedAt: number,
  queryFinishedAt = performance.now(),
): number {
  const queryElapsed = Math.max(0, queryFinishedAt - queryStartedAt);
  return Math.max(0, expiresAt - databaseNow - queryElapsed);
}
