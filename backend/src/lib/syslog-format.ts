// Bare-JSON log shipping for Terrence's structured log entries.
//
// Format "json" emits one JSON object per datagram with NO syslog envelope:
// collectors that auto-extract JSON (Splunk json/_json sourcetypes) parse
// every field, including nested objects such as `http`, with zero
// collector-side configuration. (A JSON body wrapped in an RFC 5424
// envelope defeats content-based JSON detection, so the envelope is
// omitted outright — the JSON body already carries timestamp, hostname,
// and app identity.)
//
// Format "rfc5424" (default) emits IETF-style messages with dotted
// structured-data params for syslog-native tooling:
//
//   <PRI>VERSION TIMESTAMP HOSTNAME APP PROCID MSGID [terrence@65024 k="v"]
//
// Datagram transports (UDP, 1024-byte RFC 5426 cap) pass maxBodyBytes so the
// body is shortened to valid JSON that fits; stream transports (TCP) send
// the full body newline-delimited.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type SyslogSeverity = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Nil value marker defined by RFC 5424 §6.3. */
const NIL = "-";

/** Private enterprise number placeholder; operators can rebrand by changing
 * this constant. IANA PEN registration is not required for local use. */
const ENTERPRISE_ID = 65024;


export type SyslogFormat = "rfc5424" | "json";

/** Resolve the syslog message format defensively: unknown values warn
 * and fall back to RFC 5424 structured data (the historical default). */
export function resolveSyslogFormat(raw: unknown): SyslogFormat {
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (normalized === "json" || normalized === "rfc5424") return normalized;
  if (normalized !== "") {
    console.warn(
      `[terrence] Unknown syslog format ${JSON.stringify(raw)}; ` +
      `expected "rfc5424" or "json". Falling back to "rfc5424".`,
    );
  }
  return "rfc5424";
}

/** RFC 5424 §6.2.4 PARAM-VALUE escaping: "\" -> "\\", "]" -> "\]",
 * '"' -> '\"', and control characters are removed. */
function sdEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/]/g, "\\]").replace(/[\x00-\x1f\x7f]/g, "");
}

function paramSafeKey(key: string): string {
  const safe = key.replace(/[^\w.\-/]/g, "_").slice(0, 32);
  return safe === "" ? "key" : safe;
}

/** Maximum SD-PARAM nesting depth before falling back to a JSON string,
 * and maximum total params per message so one huge meta object cannot blow
 * the UDP datagram budget on structure alone (the transport still truncates
 * oversized frames with the SD block preserved). */
const MAX_FLATTEN_DEPTH = 5;
const MAX_FLATTEN_PARAMS = 128;

/** Flatten one meta value into dotted SD-PARAM entries. Objects recurse
 * (`http: {status}` -> `http.status`), arrays use numeric segments
 * (`tags: ["a"]` -> `tags.0`), scalars stringify, and null/undefined are
 * dropped so collectors see absence instead of the string "null". Circular
 * references and over-deep values degrade to a JSON string (never throw:
 * the logger must not crash the request path). */
function flattenMetaParam(
  key: string,
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  out: Array<readonly [string, string]>,
): void {
  if (out.length >= MAX_FLATTEN_PARAMS || value === null || value === undefined) return;
  if (typeof value === "string") {
    out.push([key, value]);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    out.push([key, String(value)]);
    return;
  }
  if (typeof value !== "object" || depth >= MAX_FLATTEN_DEPTH || ancestors.has(value)) {
    try {
      const json = JSON.stringify(value) ?? NIL;
      out.push([key, json]);
    } catch {
      out.push([key, "[unserializable]"]);
    }
    return;
  }
  const nested = ancestors instanceof Set ? ancestors : new Set(ancestors);
  nested.add(value);
  for (const [childKey, childValue] of Object.entries(value)) {
    flattenMetaParam(`${key}.${childKey}`, childValue, depth + 1, nested, out);
    if (out.length >= MAX_FLATTEN_PARAMS) return;
  }
  nested.delete(value);
}

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

/** Return the smallest useful JSON value that fits an unusually small cap.
 * A valid object is impossible below two bytes, so the final scalar/empty
 * fallback is only used for pathological caller-supplied limits. */
function fallbackJsonBody(maxBytes: number): string {
  for (const candidate of ['{"truncated":true}', "{}", "0"]) {
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  }
  return "";
}

/** Shorten body to fit maxBytes while staying valid JSON: the largest
 * non-envelope meta fields are dropped first, then the remaining budget is
 * filled with the longest message prefix (plus marker) that fits. Envelope keys always
 * survive when the requested budget permits them. */
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
  const baseBytes = sizeOf(base);
  if (baseBytes > maxBytes) return fallbackJsonBody(maxBytes);
  const budget = maxBytes - baseBytes;
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
    message: messageForBudget(message, lo, budget),
  };
  const fitted = stringifySyslogBody(final);
  return Buffer.byteLength(fitted, "utf8") <= maxBytes ? fitted : fallbackJsonBody(maxBytes);
}

/** Message value for a fitted body: the full text when it fits, else the
 * longest prefix plus marker — or "" when even the marker exceeds the
 * remaining budget (the truncated flag still signals the shortening). */
function messageForBudget(message: string, prefixLength: number, budget: number): string {
  if (prefixLength >= message.length || message === "") return message;
  if (budget >= jsonStringBytes(TRUNCATION_MARKER)) return `${message.slice(0, prefixLength)}${TRUNCATION_MARKER}`;
  return "";
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
  /** Message shape: "json" for a JSON body, "rfc5424" (default) for dotted SD-PARAMs. */
  format?: SyslogFormat;
}>;

/** Build one wire message (no framing, no trailing newline). Format "json"
 * returns the bare JSON object with no syslog envelope so collectors with
 * content-based JSON detection auto-extract every field; "rfc5424" (the
 * default) returns the full RFC 5424 line with meta as dotted SD-PARAMs. */
export function formatSyslogMessage(
  entry: SyslogEntryInput,
  identity: SyslogIdentity,
  options?: SyslogFormatOptions,
): string {
  const severity = severityForLevel(entry.level);
  const header = `<${pri(1, severity)}>1 ${rfc3339Timestamp(entry.timestamp)} ${
    identity.hostname || NIL
  } ${identity.appName || NIL} ${identity.procId || NIL} ${NIL}`;
  if ((options?.format ?? "rfc5424") === "json") {
    // Envelope keys come first so last-resort transport truncation keeps
    // timestamp/level/message; colliding meta keys are dropped so the
    // envelope always wins (same precedence as before, just ordered).
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry.meta ?? {})) {
      if (!["timestamp", "level", "message", "hostname", "app"].includes(key)) extra[key] = value;
    }
    const body: Record<string, unknown> = {
      timestamp: rfc3339Timestamp(entry.timestamp),
      level: entry.level,
      message: entry.message,
      hostname: identity.hostname || NIL,
      app: identity.appName || NIL,
      ...extra,
    };
    const maxBytes = options?.maxBodyBytes;
    // Bare JSON on the wire: no RFC 5424 envelope, so JSON-detecting
    // collectors parse the datagram with no extra configuration.
    return maxBytes === undefined ? stringifySyslogBody(body) : fitJsonBody(body, maxBytes);
  }
  const meta = entry.meta;
  if (meta === undefined || Object.keys(meta).length === 0) {
    return `${header} ${NIL} ${entry.message}`;
  }
  const params: Array<readonly [string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(meta)) {
    flattenMetaParam(paramSafeKey(rawKey), rawValue, 0, new Set(), params);
  }
  const sd = `[terrence@${ENTERPRISE_ID}${params
    .map(([key, value]): string => ` ${key}="${sdEscape(value)}"`)
    .join("")}]`;
  return `${header} ${sd} ${entry.message}`;
}

/** Deterministic default hostname: container id hash when /etc/hostname is
 * unavailable (some sandboxed environments). Kept stable per boot. */
export function resolveHostname(env: NodeJS.ProcessEnv = process.env, override?: string | null): string {
  const overrideValue = override?.trim();
  const configured = overrideValue === undefined || overrideValue === ""
    ? env["TERRENCE_SYSLOG_HOSTNAME"]?.trim()
    : overrideValue;
  if (configured !== undefined && configured !== "") return configured;
  try {
    const name = readFileSync("/etc/hostname", "utf8").trim();
    if (name !== "") return name;
  } catch {
    /* fall through */
  }
  return createHash("sha256").update(env["STORAGE_DIR"] ?? "terrence").digest("hex").slice(0, 12);
}
