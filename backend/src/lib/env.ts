/** Shared environment-flag helper (todo 838).
 *
 * The codebase historically mixed `=== "1"` and `=== "true"` for boolean env
 * flags (TERRENCE_DISABLE_WORKER was the worst offender: checked as "1" in
 * the worker path but "true" in the health/ready probe). This helper accepts
 * both so existing deployments keep working regardless of which form they set,
 * and gives a single import to grep for instead of scattered string literals.
 *
 * Only the exact strings "1" and "true" (lowercase) count as enabled — this
 * mirrors the permissive IACT_QUERY_TOKEN_ENABLED check that already accepted
 * both, and avoids treating arbitrary truthy values ("yes", "on", "TRUE") as
 * enabled by accident.
 */
export function envEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function envFlag(name: string): boolean {
  return envEnabled(process.env[name]);
}
