// RFC 5424 syslog message formatting for Terrence's structured log entries.
//
// Maps the app's { error, warn, info, debug } levels onto the syslog
// severity codes and emits IETF-style messages with a JSON body:
//
//   <PRI>VERSION TIMESTAMP HOSTNAME APP PROCID MSGID - {"timestamp":...}
//
// Structured data is always NIL; the message is a JSON object so collectors
// with a json sourcetype (Splunk index=terrence) auto-extract every field,
// including nested objects such as `http`, without regex parsing or
// collector-side props. The RFC 5424 envelope (PRI/severity, timestamp,
// hostname, app) is preserved for syslog-native tooling.
//
// Datagram transports (UDP, 1024-byte RFC 5426 cap) pass maxBodyBytes so the
// body is shortened to valid JSON that fits; stream transports (TCP) send
// the full body.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type SyslogSeverity = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Nil value marker defined by RFC 5424 §6.3. */
const NIL = "-";

/** JSON body budget for UDP frames: 1024-byte datagram cap minus envelope
 * headroom (the header is well under 128 bytes). */
export const UDP_JSON_BODY_BUDGET = 896;

/** Marker appended to shortened strings; counted in byte budgets. */
const TRUNCATION_MARKER = "[truncated]";

const SEVERITY_BY_LEVEL: Readonly<Record<string, SyslogSeverity>> = {
  error: 3, // Error
  warn: 4, // Warning
  info: 6, // Informational
  debug: 7, // Debug
};

export function severityForLevel(level: string): SyslogSeverity {
  return SEVERITY_BY_LEVEL[level] ?? 6;
}

/** Bump a PRI by facility << 3 | severity. Facility 1 = user-level. */
export function pri(facility: number, severity: SyslogSeverity): number {
  return facility * 8 + severity;
}

/** Format an ISO timestamp for RFC 5424: must be full-date "T" full-time,
 * which toISOString already produces. */
function rfc3339Timestamp(timestamp: string): string {
  // Defensive: if the caller passes something non-ISO, fall back to nil
  // rather than emitting a spec-violating stamp.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(timestamp) ? timestamp : NIL;
}

function hasToJson(value: object): boolean {
  try {
    return typeof (value as { toJSON?: unknown }).toJSON === "function";
  } catch {
    return false;
  }
}

/** Deep-convert one value into JSON-safe data ahead of stringify. Objects on
 * the active recursion path become "[Circular]"; repeated (sibling)
 * references serialize in full. Errors shrink to {name, message} — stacks
 * would blow the UDP budget on their own, and full detail stays in the local
 * console JSON logs. Values with toJSON (Date et al) pass through untouched
 * so JSON.stringify applies their serializer. */
function makeJsonSafe(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value !== null && typeof value === "object") {
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (hasToJson(value)) return value;
    if (ancestors.has(value)) return "[Circular]";
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item: unknown): unknown => makeJsonSafe(item, ancestors));
      const out: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        out[childKey] = makeJsonSafe(childValue, ancestors);
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  }
  return value;
}

/** Never-throwing JSON for the message body. */
function stringifySyslogBody(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(makeJsonSafe(value, new Set())) ?? "{}";
  } catch {
    return "{}";
  }
}

/** Byte length of a JSON-encoded string value including its quotes. */
function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value) as string, "utf8");
}

/** Shorten body to fit maxBytes while staying valid JSON: the largest
 * non-envelope meta fields are dropped first, then the remaining budget is
 * filled with the longest message prefix that fits. Envelope keys always
 * survive. */
function fitJsonBody(body: Record<string, unknown>, maxBytes: number): string {
  const full = stringifySyslogBody(body);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;
  const shortened: Record<string, unknown> = { ...body, truncated: true };
  const sizeOf = (candidate: Record<string, unknown>): number =>
    Buffer.byteLength(stringifySyslogBody(candidate), "utf8");
  // 1. Drop the largest non-envelope meta fields until the fixed overhead
  // (everything except the resizable message) fits the budget.
  const droppable = Object.keys(shortened)
    .filter((key): boolean => !["timestamp", "level", "message", "hostname", "app", "truncated"].includes(key))
    .map((key): readonly [string, number] => [key, Buffer.byteLength(stringifySyslogBody({ [key]: shortened[key] }), "utf8")])
    .sort((a, b): number => b[1] - a[1]);
  const dropped = new Set<string>();
  const baseFor = (drop: ReadonlySet<string>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries({ ...shortened, message: "" }).filter(([key]): boolean => !drop.has(key)),
    );
  for (const [key] of droppable) {
    if (sizeOf(baseFor(dropped)) <= maxBytes) break;
    dropped.add(key);
  }
  const base = baseFor(dropped);
  const budget = maxBytes - sizeOf(base);
  // 2. Binary-search the longest message prefix (plus marker) that fits.
  const message = typeof shortened["message"] === "string" ? (shortened["message"] as string) : "";
  let lo = 0;
  let hi = message.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = mid < message.length ? `${message.slice(0, mid)}${TRUNCATION_MARKER}` : message;
    if (jsonStringBytes(candidate) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const final: Record<string, unknown> = {
    ...base,
    message: lo < message.length && message !== "" ? `${message.slice(0, lo)}${TRUNCATION_MARKER}` : message,
  };
  return stringifySyslogBody(final);
}

export type SyslogEntryInput = Readonly<{
  timestamp: string;
  level: string;
  message: string;
  meta?: Readonly<Record<string, unknown>>;
}>;

export type SyslogIdentity = Readonly<{
  hostname: string;
  appName: string;
  procId: string;
}>;

export type SyslogFormatOptions = Readonly<{
  /** Cap the JSON body at this many UTF-8 bytes (UDP). Omit for no cap. */
  maxBodyBytes?: number;
}>;

/** Build one RFC 5424 line (no framing, no trailing newline). Base fields
 * always win over same-named meta keys. */
export function formatSyslogMessage(
  entry: SyslogEntryInput,
  identity: SyslogIdentity,
  options?: SyslogFormatOptions,
): string {
  const severity = severityForLevel(entry.level);
  const header = `<${pri(1, severity)}>1 ${rfc3339Timestamp(entry.timestamp)} ${
    identity.hostname || NIL
  } ${identity.appName || NIL} ${identity.procId || NIL} ${NIL}`;
  const body: Record<string, unknown> = {
    ...(entry.meta ?? {}),
    timestamp: entry.timestamp,
    level: entry.level,
    message: entry.message,
    hostname: identity.hostname || NIL,
    app: identity.appName || NIL,
  };
  const maxBytes = options?.maxBodyBytes;
  const json = maxBytes === undefined ? stringifySyslogBody(body) : fitJsonBody(body, maxBytes);
  return `${header} ${NIL} ${json}`;
}

/** Deterministic default hostname: container id hash when /etc/hostname is
 * unavailable (some sandboxed environments). Kept stable per boot. */
export function resolveHostname(env: NodeJS.ProcessEnv = process.env, override?: string | null): string {
  const overrideValue = override?.trim();
  const configured = overrideValue === undefined || overrideValue === ""
    ? env.TERRENCE_SYSLOG_HOSTNAME?.trim()
    : overrideValue;
  if (configured !== undefined && configured !== "") return configured;
  try {
    const name = readFileSync("/etc/hostname", "utf8").trim();
    if (name !== "") return name;
  } catch {
    /* fall through */
  }
  return createHash("sha256").update(env.STORAGE_DIR ?? "terrence").digest("hex").slice(0, 12);
}
