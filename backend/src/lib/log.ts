// Initialize log level
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function isLogLevelEnabled(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(LOG_LEVEL as LogLevel);
}

function structuredLog(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!isLogLevelEnabled(level)) return;
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(meta !== undefined ? { ...meta } : {}),
  };
  const output = JSON.stringify(entry);
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const log = {
  error: (msg: string, meta?: Record<string, unknown>): void => {
    structuredLog("error", msg, meta);
  },
  warn: (msg: string, meta?: Record<string, unknown>): void => {
    structuredLog("warn", msg, meta);
  },
  info: (msg: string, meta?: Record<string, unknown>): void => {
    structuredLog("info", msg, meta);
  },
  debug: (msg: string, meta?: Record<string, unknown>): void => {
    structuredLog("debug", msg, meta);
  },
};
