// RFC 5424 syslog message formatting for Terrence's structured log entries.
//
// Maps the app's { error, warn, info, debug } levels onto the syslog
// severity codes and emits IETF-style messages:
//
//   <PRI>VERSION TIMESTAMP HOSTNAME APP PROCID MSGID SD STRUCTURED-DATA MSG
//
// Structured data carries the log entry's `meta` object as SD-PARAMs under
// the terrence@<enterprise-id> namespace so collectors (rsyslog, Vector,
// Grafana Loki's syslog source) can index fields without regex parsing.
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

  const params = Object.entries(meta)
    .map(([rawKey, rawValue]): string => {
      const value = typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue) ?? NIL;
      return ` ${paramSafeKey(rawKey)}="${sdEscape(value)}"`;
    })
    .join("");
  const sd = `[terrence@${ENTERPRISE_ID}${params}]`;
  return `${header} ${sd} ${entry.message}`;
}

/** Deterministic default hostname: container id hash when /etc/hostname is
 * unavailable (some sandboxed environments). Kept stable per boot. */
export function resolveHostname(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TERRENCE_SYSLOG_HOSTNAME?.trim();
  if (configured !== undefined && configured !== "") return configured;
  try {
    const name = readFileSync("/etc/hostname", "utf8").trim();
    if (name !== "") return name;
  } catch {
    /* fall through */
  }
  return createHash("sha256").update(env.STORAGE_DIR ?? "terrence").digest("hex").slice(0, 12);
}
