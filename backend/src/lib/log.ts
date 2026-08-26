import { formatSyslogMessage, resolveHostname } from "./syslog-format";
import { closeSyslogTransports, parseSyslogTarget, sendSyslogFrame, type SyslogTarget } from "./syslog-transport";

// Initialize log level
const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** Resolve LOG_LEVEL defensively: an unknown value previously produced an
 * index of -1, which silently disabled every log line. Fall back to the
 * default and warn instead. Empty/unset means default. */
function resolveLogLevel(rawLevel?: string): LogLevel {
  const configured = (rawLevel ?? "").trim().toLowerCase();
  if (configured === "") return DEFAULT_LOG_LEVEL;
  if ((LOG_LEVELS as readonly string[]).includes(configured)) return configured as LogLevel;
  console.warn(
    `[terrence] Unknown log level ${JSON.stringify(rawLevel)}; ` +
      `expected one of: ${LOG_LEVELS.join(", ")}. Falling back to "${DEFAULT_LOG_LEVEL}".`,
  );
  return DEFAULT_LOG_LEVEL;
}

const LOG_LEVEL = resolveLogLevel(process.env.LOG_LEVEL);

// ── Remote syslog sink (kanban: configurable RFC 5424 forwarding) ──────────
//
//   TERRENCE_SYSLOG_TARGET   udp://collector.example.com:514 | tcp://host:514
//   TERRENCE_SYSLOG_LEVEL    independent level for the remote sink; defaults
//                            to LOG_LEVEL when unset. Lets operators ship
//                            debug locally but only warn+ remotely (or the
//                            reverse).
//   TERRENCE_SYSLOG_HOSTNAME overrides the reported hostname.
//   TERRENCE_SYSLOG_APP      app name field (default "terrence").

const SYSLOG_TARGET: SyslogTarget | null = (() => {
  const target = parseSyslogTarget(process.env.TERRENCE_SYSLOG_TARGET);
  if (target === null && process.env.TERRENCE_SYSLOG_TARGET?.trim() !== "" && process.env.TERRENCE_SYSLOG_TARGET !== undefined) {
    console.warn(
      `[terrence] Invalid TERRENCE_SYSLOG_TARGET ${JSON.stringify(process.env.TERRENCE_SYSLOG_TARGET)}; ` +
        `expected udp://host:port or tcp://host:port. Remote syslog disabled.`,
    );
  }
  return target;
})();

const SYSLOG_LEVEL: LogLevel = SYSLOG_TARGET === null ? LOG_LEVEL : resolveLogLevel(process.env.TERRENCE_SYSLOG_LEVEL ?? process.env.LOG_LEVEL);
const SYSLOG_IDENTITY = {
  hostname: resolveHostname(),
  appName: process.env.TERRENCE_SYSLOG_APP?.trim() || "terrence",
  procId: String(process.pid),
};

function isLogLevelEnabled(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(LOG_LEVEL);
}

function isSyslogEnabled(level: LogLevel): boolean {
  return (
    SYSLOG_TARGET !== null &&
    SYSLOG_LEVELS.indexOf(level) <= SYSLOG_LEVELS.indexOf(SYSLOG_LEVEL)
  );
}

const SYSLOG_LEVELS = LOG_LEVELS;

/** Serialize log meta defensively: BigInt throws in JSON.stringify and
 * circular references would otherwise crash the logger (and, with it, the
 * request handler that called it). */
function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key: string, entry: unknown) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry !== null && typeof entry === "object") {
      if (seen.has(entry)) return "[Circular]";
      seen.add(entry);
    }
    return entry;
  });
}

function structuredLog(level: LogLevel, message: string, meta?: Readonly<Record<string, unknown>>): void {
  // Remote sink first so a local console failure can never suppress shipping;
  // both paths are individually failure-isolated below.
  if (SYSLOG_TARGET !== null && isSyslogEnabled(level)) {
    try {
      const frame = formatSyslogMessage(
        meta !== undefined
          ? { timestamp: new Date().toISOString(), level, message, meta }
          : { timestamp: new Date().toISOString(), level, message },
        SYSLOG_IDENTITY,
      );
      sendSyslogFrame(SYSLOG_TARGET, frame);
    } catch {
      /* transport errors are swallowed inside sendSyslogFrame */
    }
  }
  if (!isLogLevelEnabled(level)) return;
  // Logging is best-effort: a failing stream or a meta serialization failure
  // must never crash the process or propagate to the caller.
  try {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    // Metadata is nested under a reserved `meta` key so caller-supplied
    // keys can never collide with the structured fields (12.5).
    if (meta !== undefined && Object.keys(meta).length > 0) {
      entry.meta = meta;
    }
    const output = safeJsonStringify(entry);
    if (level === "error") {
      console.error(output);
    } else if (level === "warn") {
      console.warn(output);
    } else {
      console.log(output);
    }
  } catch {
    // Swallow: logging failures must never propagate to the caller.
  }
}

export const log = {
  error: (msg: string, meta?: Readonly<Record<string, unknown>>): void => {
    structuredLog("error", msg, meta);
  },
  warn: (msg: string, meta?: Readonly<Record<string, unknown>>): void => {
    structuredLog("warn", msg, meta);
  },
  info: (msg: string, meta?: Readonly<Record<string, unknown>>): void => {
    structuredLog("info", msg, meta);
  },
  debug: (msg: string, meta?: Readonly<Record<string, unknown>>): void => {
    structuredLog("debug", msg, meta);
  },
};

/** Test/shutdown hook: close UDP socket and TCP connections. */
export function shutdownLogging(): void {
  closeSyslogTransports();
}
