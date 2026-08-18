import type { JsonObject } from "@/lib/json";
/**
 * Runtime type guards for decoding untrusted values at I/O boundaries.
 *
 * The anti-slop lint policy forbids raw `typeof` checks in application code:
 * external values must be decoded into meaningful types at their boundary.
 * These guards are that decode step. Each guard narrows the value with a
 * type predicate, so call sites branch on the domain value afterwards.
 */

/** True when the value is a string. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** True when the value is a finite number (excludes NaN and infinities). */
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when the value is a boolean. */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** True when the value is a plain object (non-null, non-array). */
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the value is callable. */
export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/** True when the value is a bigint. */
export function isBigInt(value: unknown): value is bigint {
  return typeof value === "bigint";
}

/**
 * True when typeof value is "object". This includes null and arrays; callers
 * that need a plain record must pair it with `!== null` / `!Array.isArray`.
 */
export function isObjectLike(value: unknown): value is object {
  return typeof value === "object";
}