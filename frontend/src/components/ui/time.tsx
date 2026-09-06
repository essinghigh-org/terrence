import { useEffect, useState } from "react";

import {
  formatDateTime,
  formatDateTimeExact,
  formatRelativeTime,
} from "../../lib/utils";

type TimeValue = Readonly<Date> | string | number | null | undefined;

function asIsoDateTime(value: TimeValue): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

/**
 * A compact, accessible time label for dense operational lists.
 *
 * The visible label is relative and refreshes in place. The title and
 * accessible name retain the exact instant, so changing clocks or time zones
 * never removes the authoritative value from the UI.
 */
export function RelativeTime({
  value,
  fallback = "—",
  className,
  updateIntervalMs = 30_000,
}: Readonly<{
  value: TimeValue;
  fallback?: string;
  className?: string;
  updateIntervalMs?: number;
}>): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());

  useEffect((): (() => void) | undefined => {
    if (updateIntervalMs <= 0) return undefined;
    const timer = window.setInterval((): void => { setNow(new Date()); }, updateIntervalMs);
    return (): void => { window.clearInterval(timer); };
  }, [updateIntervalMs]);

  const relative = formatRelativeTime(value, now);
  const localized = formatDateTime(value, fallback);
  const iso = asIsoDateTime(value);
  const exact = iso === undefined ? "Unknown" : formatDateTimeExact(iso);
  const exactLabel = exact === "Unknown" ? localized : `${localized} (${exact})`;

  return (
    <time
      dateTime={iso}
      title={exactLabel}
      aria-label={exact === "Unknown" ? localized : `${relative}; exact time ${exact}`}
      className={className}
    >
      {relative === "—" ? fallback : relative}
    </time>
  );
}
