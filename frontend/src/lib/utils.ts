import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { resolveDisplayTimeZone } from "./display-timezone";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export function cn(...inputs: readonly DeepReadonly<ClassValue>[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Parse a displayable date from tolerant input. Bare ISO calendar strings
 * ("YYYY-MM-DD") are constructed as LOCAL calendar dates so they render on
 * the same day in every time zone — `new Date("2026-08-07")` parses as UTC
 * midnight and displays the previous day in negative-offset zones.
 */
function toDisplayDate(value: Date | string | number | null | undefined): Date {
  if (value instanceof Date) return value;
  if (value == null || value === "") return new Date(NaN);
  if (typeof value === "string") {
    const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (bare !== null) {
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
export function formatDate(value: Date | string | number | null | undefined, fallback = "—", timeZone = resolveDisplayTimeZone()): string {
  const date = toDisplayDate(value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toLocaleDateString(undefined, timeZone !== undefined ? { timeZone } : undefined);
}

/**
 * Format a date-time for display (locale string with time). Invalid input
 * renders as the fallback.
 */
export function formatDateTime(value: Date | string | number | null | undefined, fallback = "—", timeZone = resolveDisplayTimeZone()): string {
  const date = toDisplayDate(value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toLocaleString(undefined, timeZone !== undefined ? { timeZone } : undefined);
}

/**
 * A stable, locale- and sort-order-independent date-time key for tables that
 * need exact values, e.g. relative-time tooltips (review item 14.23).
 * Renders a canonical ISO-8601 UTC string; invalid input returns "Unknown".
 */
export function formatDateTimeExact(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown";
  return date.toISOString();
}
