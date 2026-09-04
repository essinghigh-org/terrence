/** Fraction of the base delay used for symmetric poll jitter. */
export const POLL_JITTER_FRACTION = 0.2;

/**
 * Return a positive delay with symmetric random jitter around the base value.
 * The optional random source keeps the policy deterministic in unit tests.
 */
export function jitteredPollDelay(
  baseMs: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 1;
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  const multiplier = 1 - POLL_JITTER_FRACTION + (2 * POLL_JITTER_FRACTION * normalized);
  return Math.max(1, Math.round(baseMs * multiplier));
}
