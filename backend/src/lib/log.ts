import { formatSyslogMessage, resolveHostname, resolveSyslogFormat, type SyslogFormat, UDP_JSON_BODY_BUDGET } from "./syslog-format";
import {
  closeSyslogTransports,
  parseSyslogTarget,
  parseSyslogTargets,
  sendSyslogFrame,
  type SyslogTarget,
} from "./syslog-transport";

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const DEFAULT_LOG_LEVEL: LogLevel = "info";

type LoggingConfiguration = Readonly<{
  enabled: boolean;
  logLevel: LogLevel;
  syslogLevel: LogLevel;
  syslogTargets: readonly SyslogTarget[];
  syslogHostname: string | null;
  syslogApp: string;
  syslogFormat: SyslogFormat;
}>;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value.trim().toLowerCase());
}

/** Resolve a log level defensively. Unknown values never disable all logging. */
function resolveLogLevel(rawLevel: unknown, fallback = DEFAULT_LOG_LEVEL): LogLevel {
  const configured = typeof rawLevel === "string" ? rawLevel.trim().toLowerCase() : "";
  if (configured === "") return fallback;
  if (isLogLevel(configured)) return configured;
  console.warn(
    `[terrence] Unknown log level ${JSON.stringify(rawLevel)}; ` +
      `expected one of: ${LOG_LEVELS.join(", ")}. Falling back to "${fallback}".`,
  );
  return fallback;
}

function environmentTargetString(): string | undefined {
  const multiple = process.env["TERRENCE_SYSLOG_TARGETS"]?.trim();
  return multiple === undefined || multiple === ""
    ? process.env["TERRENCE_SYSLOG_TARGET"]
    : multiple;
}

function environmentConfiguration(): LoggingConfiguration {
  const logLevel = resolveLogLevel(process.env["LOG_LEVEL"]);
  const syslogTargets = parseSyslogTargets(environmentTargetString());
  return {
    enabled: syslogTargets.length > 0,
    logLevel,
    syslogLevel: resolveLogLevel(process.env["TERRENCE_SYSLOG_LEVEL"], logLevel),
    syslogTargets,
    syslogHostname: process.env["TERRENCE_SYSLOG_HOSTNAME"]?.trim() || null,
    syslogApp: process.env["TERRENCE_SYSLOG_APP"]?.trim() || "terrence",
    syslogFormat: resolveSyslogFormat(process.env["TERRENCE_SYSLOG_FORMAT"]),
  };
}

let loggingConfiguration: LoggingConfiguration = environmentConfiguration();

function settingString(settings: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function settingTargets(settings: Readonly<Record<string, unknown>>): readonly SyslogTarget[] | undefined {
  const value = settings["syslog-targets"];
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry): SyslogTarget[] => {
    if (typeof entry !== "string") return [];
    const target = parseSyslogTarget(entry);
    return target === null ? [] : [target];
  });
}

function targetKey(target: SyslogTarget): string {
  return `${target.transport}:${target.family ?? 4}:${target.host}:${target.port}`;
}

function targetSetChanged(previous: readonly SyslogTarget[], next: readonly SyslogTarget[]): boolean {
  if (previous.length !== next.length) return true;
  const previousKeys = previous.map(targetKey).sort();
  const nextKeys = next.map(targetKey).sort();
  return previousKeys.some((key, index): boolean => key !== nextKeys[index]);
}

/** Apply effective Site Admin logging settings without restarting the process.
 * A non-null persisted field overrides its environment fallback; an explicit
 * empty target array disables environment-configured remote sinks. */
export function applyLoggingSettings(settings: Readonly<Record<string, unknown>>): void {
  const environment = environmentConfiguration();
  const configuredLogLevel = settingString(settings, "log-level");
  const configuredSyslogLevel = settingString(settings, "syslog-level");
  const configuredTargets = settingTargets(settings);
  const configuredEnabled = settings["enabled"];
  const configuredFormat = settingString(settings, "syslog-format");
  const next: LoggingConfiguration = {
    enabled: typeof configuredEnabled === "boolean"
      ? configuredEnabled
      : (configuredTargets ?? environment.syslogTargets).length > 0,
    logLevel: configuredLogLevel === undefined
      ? environment.logLevel
      : resolveLogLevel(configuredLogLevel, environment.logLevel),
    syslogLevel: configuredSyslogLevel === undefined
      ? environment.syslogLevel
      : resolveLogLevel(configuredSyslogLevel, environment.syslogLevel),
    syslogTargets: configuredTargets ?? environment.syslogTargets,
    syslogHostname: settingString(settings, "syslog-hostname") ?? environment.syslogHostname,
    syslogApp: settingString(settings, "syslog-app") ?? environment.syslogApp,
    syslogFormat: configuredFormat === undefined
      ? environment.syslogFormat
      : resolveSyslogFormat(configuredFormat),
  };
  if (
    targetSetChanged(loggingConfiguration.syslogTargets, next.syslogTargets)
    || loggingConfiguration.enabled !== next.enabled
  ) closeSyslogTransports();
  loggingConfiguration = next;
}

function isLogLevelEnabled(level: LogLevel, configured: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(configured);
}

const ERROR_RESERVED_KEYS = new Set(["name", "message", "stack", "cause", "errors"]);
const SAFE_ERROR_DETAIL_KEYS = new Set([
  "code",
  "errno",
  "syscall",
  "path",
  "status",
  "statusCode",
  "exitCode",
  "signal",
  "type",
  "operation",
  "reason",
  "resource",
  "phase",
  "runId",
  "requestId",
]);
const MAX_ERROR_STRING_LENGTH = 4_096;
const MAX_ERROR_DETAIL_STRING_LENGTH = 1_024;
const MAX_ERROR_DETAIL_KEYS = 16;
const MAX_ERROR_COLLECTION_ITEMS = 16;
const MAX_ERROR_CAUSE_DEPTH = 3;
const ERROR_TRUNCATION_SUFFIX = "…[truncated]";
const REDACTED_LOG_VALUE = "[REDACTED]";
const SENSITIVE_LOG_KEY_PATTERN = /(?:authorization|cookie|credential|password|passphrase|secret|token|privatekey|signingkey|apikey)/i;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi;
const BEARER_OR_BASIC_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_SECRET_PARAMETER_PATTERN = /([?&](?:access[_-]?token|api[_-]?key|id[_-]?token|refresh[_-]?token|secret|password|signature|token)=)[^&#\s]*/gi;
const URL_USERINFO_PASSWORD_PATTERN = /(\b[a-z][a-z\d+.-]*:\/\/[^\/\s:@]*):[^\/\s@]+@/gi;
const KEY_VALUE_SECRET_PATTERN = /((?:^|[,{\s;])['"]?(?:access[_-]?token|api[_-]?key|authorization|cookie|id[_-]?token|password|passphrase|private[_-]?key|refresh[_-]?token|secret|token)['"]?\s*[:=]\s*)(?:(['"])(?:\\.|(?!\2)[\s\S])*\2|[^,'"}\s]+)/gi;
const KNOWN_TOKEN_PATTERN = /\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_\-]+/gi;

type ErrorWithOptionalCause = Error & { cause?: unknown; errors?: unknown };
type SafeErrorScalar = string | number | boolean | null;

function isSensitiveLogKey(key: string | undefined): boolean {
  if (key === undefined) return false;
  return SENSITIVE_LOG_KEY_PATTERN.test(key.replace(/[^a-z0-9]/gi, ""));
}

/** Scrub common bearer/credential shapes even when a caller logs one string. */
function redactSensitiveString(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]")
    .replace(BEARER_OR_BASIC_PATTERN, "$1 [REDACTED]")
    .replace(URL_SECRET_PARAMETER_PATTERN, "$1[REDACTED]")
    .replace(URL_USERINFO_PASSWORD_PATTERN, "$1:[REDACTED]@")
    .replace(KEY_VALUE_SECRET_PATTERN, "$1[REDACTED]")
    .replace(KNOWN_TOKEN_PATTERN, "[REDACTED TOKEN]");
}

/** Deeply redact metadata before it reaches either local or remote sinks. */
function redactLogValue(value: unknown, key?: string, ancestors = new WeakSet<object>()): unknown {
  if (isSensitiveLogKey(key)) return REDACTED_LOG_VALUE;
  if (typeof value === "string") return redactSensitiveString(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    try {
      return serializeLogError(value);
    } catch {
      return { name: "Error", message: "[Error omitted]" };
    }
  }
  if (value instanceof Date) {
    try {
      return value.toISOString();
    } catch {
      return "[Invalid date]";
    }
  }
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry: unknown): unknown => redactLogValue(entry, undefined, ancestors));
    }
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === "toJSON") continue;
      try {
        output[childKey] = redactLogValue(childValue, childKey, ancestors);
      } catch {
        output[childKey] = "[Unserializable]";
      }
    }
    return output;
  } catch {
    return "[Unserializable]";
  } finally {
    ancestors.delete(value);
  }
}

function truncateLogString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit - ERROR_TRUNCATION_SUFFIX.length) + ERROR_TRUNCATION_SUFFIX;
}

function safeErrorScalar(value: unknown, limit: number): SafeErrorScalar | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return truncateLogString(redactSensitiveString(value), limit);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return truncateLogString(value.toString(), limit);
  return undefined;
}

function serializeNestedError(value: unknown, depth: number, active: Set<Error>): unknown {
  if (value instanceof Error) {
    if (active.has(value)) return { name: value.name, message: "[Circular error cause]" };
    if (depth >= MAX_ERROR_CAUSE_DEPTH) {
      return {
        name: truncateLogString(value.name, MAX_ERROR_STRING_LENGTH),
        message: "[Nested error omitted]",
      };
    }
    return serializeLogErrorInternal(value, depth, active);
  }
  return safeErrorScalar(value, MAX_ERROR_DETAIL_STRING_LENGTH) ?? { name: "NonErrorThrown", message: "[Non-error cause omitted]" };
}

function serializeLogErrorInternal(error: Error, depth: number, active: Set<Error>): Readonly<Record<string, unknown>> {
  if (active.has(error)) return { name: error.name, message: "[Circular error cause]" };
  active.add(error);
  try {
    const value = error as ErrorWithOptionalCause;
    const serialized: Record<string, unknown> = {
      name: truncateLogString(redactSensitiveString(value.name), MAX_ERROR_STRING_LENGTH),
      message: truncateLogString(redactSensitiveString(value.message), MAX_ERROR_STRING_LENGTH),
    };
    if (value.stack !== undefined) serialized["stack"] = truncateLogString(redactSensitiveString(value.stack), MAX_ERROR_STRING_LENGTH);
    if (value.cause !== undefined) serialized["cause"] = serializeNestedError(value.cause, depth + 1, active);
    if (Array.isArray(value.errors)) {
      const errors = value.errors
        .slice(0, MAX_ERROR_COLLECTION_ITEMS)
        .map((entry): unknown => serializeNestedError(entry, depth + 1, active));
      if (value.errors.length > MAX_ERROR_COLLECTION_ITEMS) {
        errors.push(`[${value.errors.length - MAX_ERROR_COLLECTION_ITEMS} additional errors omitted]`);
      }
      serialized["errors"] = errors;
    }

    const details: Record<string, SafeErrorScalar> = {};
    for (const key of Object.keys(value)) {
      if (
        ERROR_RESERVED_KEYS.has(key)
        || !SAFE_ERROR_DETAIL_KEYS.has(key)
        || Object.keys(details).length >= MAX_ERROR_DETAIL_KEYS
      ) continue;
      let detail: unknown;
      try {
        detail = Reflect.get(value, key);
      } catch {
        continue;
      }
      const safeValue = safeErrorScalar(detail, MAX_ERROR_DETAIL_STRING_LENGTH);
      if (safeValue !== undefined) details[key] = safeValue;
    }
    if (Object.keys(details).length > 0) serialized["details"] = details;
    return serialized;
  } finally {
    active.delete(error);
  }
}

/** Convert Error instances into useful, bounded, JSON-safe structured metadata. */
export function serializeLogError(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) {
    let message: string;
    try {
      message = String(error);
    } catch {
      message = "[Non-error value omitted]";
    }
    return {
      name: "NonErrorThrown",
      message: truncateLogString(redactSensitiveString(message), MAX_ERROR_STRING_LENGTH),
    };
  }
  return serializeLogErrorInternal(error, 0, new Set<Error>());
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(redactLogValue(value)) ?? "null";
  } catch {
    return "[Unserializable]";
  }
}

function structuredLog(level: LogLevel, message: string, meta?: Readonly<Record<string, unknown>>): void {
  const configuration = loggingConfiguration;
  const safeMessage = redactSensitiveString(message);
  const safeMeta = meta === undefined ? undefined : redactLogValue(meta) as Readonly<Record<string, unknown>>;
  if (
    configuration.enabled
    && configuration.syslogTargets.length > 0
    && isLogLevelEnabled(level, configuration.syslogLevel)
  ) {
    // Format per destination: datagram transports (UDP) need a byte-budgeted
    // body so oversized entries stay valid JSON; streams take the full body.
    // The "json" format ships the bare JSON object (no syslog envelope) so
    // JSON-detecting collectors auto-extract every field.
    for (const target of configuration.syslogTargets) {
      try {
        const frame = formatSyslogMessage(
          safeMeta !== undefined
            ? { timestamp: new Date().toISOString(), level, message: safeMessage, meta: safeMeta }
            : { timestamp: new Date().toISOString(), level, message: safeMessage },
          {
            hostname: resolveHostname(process.env, configuration.syslogHostname),
            appName: configuration.syslogApp,
            procId: String(process.pid),
          },
          target.transport === "udp" ? { maxBodyBytes: UDP_JSON_BODY_BUDGET, format: configuration.syslogFormat } : { format: configuration.syslogFormat },
        );
        try {
          sendSyslogFrame(target, frame, { jsonBody: configuration.syslogFormat === "json" });
        } catch {
          // A single destination must never suppress the remaining fan-out.
        }
      } catch {
        // Formatting and transport are best-effort diagnostics.
      }
    }
  }
  if (!isLogLevelEnabled(level, configuration.logLevel)) return;
  try {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: safeMessage,
    };
    if (safeMeta !== undefined && Object.keys(safeMeta).length > 0) entry["meta"] = safeMeta;
    const output = safeJsonStringify(entry);
    if (level === "error") console.error(output);
    else if (level === "warn") console.warn(output);
    else console.log(output);
  } catch {
    // Logging failures must never propagate to the caller.
  }
}

export const log = {
  error: (msg: string, meta?: Readonly<Record<string, unknown>>): void => structuredLog("error", msg, meta),
  warn: (msg: string, meta?: Readonly<Record<string, unknown>>): void => structuredLog("warn", msg, meta),
  info: (msg: string, meta?: Readonly<Record<string, unknown>>): void => structuredLog("info", msg, meta),
  debug: (msg: string, meta?: Readonly<Record<string, unknown>>): void => structuredLog("debug", msg, meta),
};

/** Test/shutdown hook: close UDP socket and TCP connections. */
export function shutdownLogging(): void {
  closeSyslogTransports();
}
