import { formatSyslogMessage, resolveHostname } from "./syslog-format";
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
  const logLevel = resolveLogLevel(process.env.LOG_LEVEL);
  const syslogTargets = parseSyslogTargets(environmentTargetString());
  return {
    enabled: syslogTargets.length > 0,
    logLevel,
    syslogLevel: resolveLogLevel(process.env["TERRENCE_SYSLOG_LEVEL"], logLevel),
    syslogTargets,
    syslogHostname: process.env["TERRENCE_SYSLOG_HOSTNAME"]?.trim() || null,
    syslogApp: process.env["TERRENCE_SYSLOG_APP"]?.trim() || "terrence",
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
  const configuredEnabled = settings.enabled;
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
  const configuration = loggingConfiguration;
  if (
    configuration.enabled
    && configuration.syslogTargets.length > 0
    && isLogLevelEnabled(level, configuration.syslogLevel)
  ) {
    try {
      const frame = formatSyslogMessage(
        meta !== undefined
          ? { timestamp: new Date().toISOString(), level, message, meta }
          : { timestamp: new Date().toISOString(), level, message },
        {
          hostname: resolveHostname(process.env, configuration.syslogHostname),
          appName: configuration.syslogApp,
          procId: String(process.pid),
        },
      );
      for (const target of configuration.syslogTargets) {
        try {
          sendSyslogFrame(target, frame);
        } catch {
          // A single destination must never suppress the remaining fan-out.
        }
      }
    } catch {
      // Formatting and transport are best-effort diagnostics.
    }
  }
  if (!isLogLevelEnabled(level, configuration.logLevel)) return;
  try {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    if (meta !== undefined && Object.keys(meta).length > 0) entry["meta"] = meta;
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
