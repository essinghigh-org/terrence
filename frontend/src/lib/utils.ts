import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { resolveDisplayTimeZone } from "./display-timezone";
import { resolveDisplayTimeFormat } from "./display-time-format";
import { isString } from "../lib/type-guards";

export type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

// NOTE: a memoized cn() was benchmarked and REVERTED (bench/frontend.bench.ts).
// Key building + Map lookups cost ~0.23us/call while twMerge costs ~0.6us;
// the all-strings check on the common conditional-heavy call patterns made
// the cache a net loss on realistic workloads (+9-17%), with the win only
// visible on pure-string repeats. twMerge is already the floor.
export function cn(...inputs: readonly DeepReadonly<ClassValue>[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Parse a displayable date from tolerant input. Bare ISO calendar strings
 * ("YYYY-MM-DD") are constructed as LOCAL calendar dates so they render on
 * the same day in every time zone — `new Date("2026-08-07")` parses as UTC
 * midnight and displays the previous day in negative-offset zones.
 */
const BARE_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDisplayDate(value: Readonly<Date> | string | number | null | undefined, timeZone?: string): Date {
  if (value instanceof Date) return value;
  if (value == null || value === "") return new Date(NaN);
  if (isString(value)) {
    const bare = BARE_ISO_DATE.exec(value.trim());
    if (bare !== null) {
      // When rendering for a pinned display timezone, interpret the calendar
      // day IN that zone instead of the browser's local zone: a bare date has
      // no instant, so UTC midnight keeps the same calendar day for the UTC
      // pin (the only non-local value the preference supports).
      if (timeZone === "UTC") return new Date(`${value.trim()}T00:00:00Z`);
      // setFullYear avoids the Date constructor's 1900+year normalization for
      // years 00-99; reset the time-of-day afterwards because new Date(0) is
      // 1970-01-01T00:00:00Z, which is a non-midnight local wall time in
      // negative-offset zones. The result is local midnight of the calendar day.
      const d = new Date(0);
      d.setFullYear(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
      d.setHours(0, 0, 0, 0);
      return d;
    }
  }
  return new Date(value);
}

/**
 * Format a date for display. Invalid or unparseable input renders as the
 * fallback (default "—") so callers never show "Invalid Date".
 */
/**
 * Compact human time for list cells, e.g. "5 minutes ago" or "in 3 hours".
 * Older than a week falls back to formatDate; pass the exact value to the
 * element's title attribute for precision (review item 14.23).
 */
export function formatRelativeTime(value: Readonly<Date> | string | number | null | undefined, now: Readonly<Date> = new Date()): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = date.getTime() - now.getTime();
  const past = diffMs < 0;
  const diffMsAbs = Math.abs(diffMs);
  const totalSeconds = Math.max(1, Math.round(diffMsAbs / 1000));
  if (totalSeconds < 5) return "just now";
  // Round every unit independently from the raw delta so a value like
  // 1h 29m 30s resolves to "1 hour" instead of cascading into "2 hours".
  const totalMinutes = Math.round(diffMsAbs / 60000);
  const totalHours = Math.round(diffMsAbs / 3600000);
  const totalDays = Math.round(diffMsAbs / 86400000);
  const phrase = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? "" : "s"}`;
  let text: string;
  if (totalMinutes < 1) text = phrase(totalSeconds, "second");
  else if (totalMinutes < 60) text = phrase(totalMinutes, "minute");
  else if (totalHours < 24) text = phrase(totalHours, "hour");
  else if (diffMsAbs < 7 * 86400000) text = phrase(totalDays, "day");
  else return formatDate(value);
  return past ? `${text} ago` : `in ${text}`;
}

export function formatDate(value: Readonly<Date> | string | number | null | undefined, fallback = "—", timeZone = resolveDisplayTimeZone()): string {
  const date = toDisplayDate(value, timeZone);
  return Number.isNaN(date.valueOf()) ? fallback : date.toLocaleDateString(undefined, timeZone !== undefined ? { timeZone } : undefined);
}

/**
 * Format a date-time for display (locale string with time). Invalid input
 * renders as the fallback. The hour cycle follows the operator's display
 * time format preference (12h/24h, default 24h) so a 12-hour render always
 * carries an AM/PM suffix instead of the ambiguous suffixed-less cycle some
 * locales default to.
 */
export function formatDateTime(
  value: Readonly<Date> | string | number | null | undefined,
  fallback = "—",
  timeZone = resolveDisplayTimeZone(),
  timeFormat: "12" | "24" = resolveDisplayTimeFormat(),
): string {
  const date = toDisplayDate(value, timeZone);
  if (Number.isNaN(date.valueOf())) return fallback;
  const options: Intl.DateTimeFormatOptions = { hour12: timeFormat === "12" };
  if (timeZone !== undefined) options.timeZone = timeZone;
  // Fixed locale: the product UI is English and the AM/PM suffix for the
  // 12-hour cycle must render identically on every host (a locale like
  // de-DE or ja-JP omits the day period even with hour12: true).
  return date.toLocaleString("en-US", options);
}

/**
 * A stable, locale- and sort-order-independent date-time key for tables that
 * need exact values, e.g. relative-time tooltips (review item 14.23).
 * Renders a canonical ISO-8601 UTC string; invalid input returns "Unknown".
 */
export function formatDateTimeExact(value: Readonly<Date> | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown";
  return date.toISOString();
}