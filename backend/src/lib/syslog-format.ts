// RFC 5424 syslog message formatting for Terrence's structured log entries.
//
// Maps the app's { error, warn, info, debug } levels onto the syslog
// severity codes and emits IETF-style messages:
//
//   <PRI>VERSION TIMESTAMP HOSTNAME APP PROCID MSGID SD STRUCTURED-DATA MSG
//
// Structured data carries the log entry's `meta` object flattened into
// dotted SD-PARAMs (`http: {status: 200}` -> `http.status="200"`) under the
// terrence@<enterprise-id> namespace so collectors (Splunk, rsyslog, Vector,
// Grafana Loki's syslog source) can index fields without regex parsing.
// Values that cannot flatten (over-deep, circular) degrade to JSON strings.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type SyslogSeverity = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Nil value marker defined by RFC 5424 §6.3. */
const NIL = "-";

/** Private enterprise number placeholder; operators can rebrand by changing
 * this constant. IANA PEN registration is not required for local use. */
const ENTERPRISE_ID = 65024;

const SEVERITY_BY_LEVEL: Readonly<Record<string, SyslogSeverity>> = {
  error: 3, // Error
  warn: 4, // Warning
  info: 6, // Informational
  debug: 7, // Debug
};

export function severityForLevel(level: string): SyslogSeverity {
  return SEVERITY_BY_LEVEL[level] ?? 6;
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

/** Build one RFC 5424 line (no framing, no trailing newline). */
export function formatSyslogMessage(entry: SyslogEntryInput, identity: SyslogIdentity): string {
  const severity = severityForLevel(entry.level);
  const header = `<${pri(1, severity)}>1 ${rfc3339Timestamp(entry.timestamp)} ${
    identity.hostname || NIL
  } ${identity.appName || NIL} ${identity.procId || NIL} ${NIL}`;

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
