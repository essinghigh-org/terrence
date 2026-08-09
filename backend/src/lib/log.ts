// Initialize log level
const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** Resolve LOG_LEVEL defensively: an unknown value previously produced an
 * index of -1, which silently disabled every log line. Fall back to the
 * default and warn instead. Empty/unset means default. */
function resolveLogLevel(): LogLevel {
  const configured = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (configured === "") return DEFAULT_LOG_LEVEL;
  if ((LOG_LEVELS as readonly string[]).includes(configured)) return configured as LogLevel;
  console.warn(
    `[terrence] Unknown LOG_LEVEL ${JSON.stringify(process.env.LOG_LEVEL)}; ` +
      `expected one of: ${LOG_LEVELS.join(", ")}. Falling back to "${DEFAULT_LOG_LEVEL}".`,
  );
  return DEFAULT_LOG_LEVEL;
}

const LOG_LEVEL = resolveLogLevel();

function isLogLevelEnabled(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(LOG_LEVEL);
}

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
  if (!isLogLevelEnabled(level)) return;
  // Logging is best-effort: a failing stream or a meta serialization failure
  // must never crash the process or propagate to the caller.
  try {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(meta !== undefined ? { ...meta } : {}),
    };
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

