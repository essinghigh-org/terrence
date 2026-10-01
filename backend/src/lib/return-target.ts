/**
 * Backend counterpart to the SPA return-target contract.
 *
 * Only same-origin /app destinations are accepted. Invalid values return
 * undefined so SSO entry points can reject them instead of silently choosing a
 * different target.
 */
export function resolveSsoReturnTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || (value !== "/app" && !value.startsWith("/app/"))) return undefined;
  if (value.startsWith("//")) return undefined;
  if (/[\r\n]/.test(value) || value.includes("/../")) return undefined;
  return value;
}
