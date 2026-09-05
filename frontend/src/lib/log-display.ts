export const MAX_LOG_DISPLAY_CHARS = 200_000;

/**
 * Truncate a log for inline display, keeping the TAIL (issue #590).
 * Terraform failures sit at the end of large plans and chatty provider
 * output, so head-keeping drops the Error block exactly when it matters.
 * Returns the log unchanged when it fits.
 */
export function truncateLogForDisplay(log: string, maxChars: number = MAX_LOG_DISPLAY_CHARS): string {
  if (log.length <= maxChars) return log;
  return `… (truncated, showing last ${maxChars.toLocaleString("en-US")} of ${log.length.toLocaleString("en-US")} chars — download full log)\n${log.slice(-maxChars)}`;
}
