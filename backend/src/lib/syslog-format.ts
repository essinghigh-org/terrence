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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type SyslogSeverity = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Nil value marker defined by RFC 5424 §6.3. */
const NIL = "-";

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

/** Body keys owned by the envelope; a meta key colliding with one of these
 * is dropped so the log line's own timestamp/level/message always win. */
const RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
  "timestamp",
  "level",
  "message",
  "hostname",
  "app",
]);

/** Circular-safe JSON for the message body. Mirrors log.ts safeJsonStringify
 * except Errors shrink to {name, message} without the stack: stacks would
 * blow the 1024-byte UDP budget on their own, and full detail stays in the
 * local console JSON logs. Never throws. */
function stringifySyslogBody(value: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key: string, entry: unknown): unknown => {
        if (typeof entry === "bigint") return entry.toString();
        if (entry !== null && typeof entry === "object") {
          if (seen.has(entry)) return "[Circular]";
          seen.add(entry);
          if (entry instanceof Error) return { name: entry.name, message: entry.message };
        }
        return entry;
      }) ?? "{}"
    );
  } catch {
    return "{}";
  }
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
  const metaBody: Record<string, unknown> = { ...(entry.meta ?? {}) };
  for (const reserved of RESERVED_BODY_KEYS) delete metaBody[reserved];
  const body: Record<string, unknown> = {
    timestamp: entry.timestamp,
    level: entry.level,
    message: entry.message,
    hostname: identity.hostname || NIL,
    app: identity.appName || NIL,
    ...metaBody,
  };
  return `${header} ${NIL} ${stringifySyslogBody(body)}`;
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
