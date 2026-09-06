import { parseSyslogTarget } from "./syslog-transport";

export const loggingLevels = ["error", "warn", "info", "debug"] as const;
type Level = (typeof loggingLevels)[number];
export type LoggingEnvironment = Readonly<
  Record<"LOG_LEVEL" | "TERRENCE_SYSLOG_LEVEL", Level>
  & Record<"TERRENCE_SYSLOG_TARGETS", readonly string[]>
  & Record<"TERRENCE_SYSLOG_HOSTNAME", string | null>
  & Record<"TERRENCE_SYSLOG_APP", string>
  & Record<"TERRENCE_SYSLOG_FORMAT", "json" | "rfc5424">
>;
type Environment = Readonly<Record<string, string | undefined>>;

function level(raw: string | undefined, fallback: Level): Level {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "error" || value === "warn" || value === "info" || value === "debug") return value;
  throw new Error("Logging levels must be error, warn, info, or debug");
}

function identity(raw: string | undefined, fallback: string | null, maximum: number): string | null {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!/^[\x21-\x7E]+$/u.test(value) || value.length > maximum) throw new Error("Invalid syslog identity configuration");
  return value;
}

export function parseLoggingEnvironment(environment: Environment): LoggingEnvironment {
  const single = environment["TERRENCE_SYSLOG_TARGET"];
  const multiple = environment["TERRENCE_SYSLOG_TARGETS"];
  if (single !== undefined && multiple !== undefined && single.trim() !== multiple.trim()) {
    throw new Error("TERRENCE_SYSLOG_TARGET and TERRENCE_SYSLOG_TARGETS conflict; configure one");
  }
  const raw = multiple ?? single;
  const targets = raw === undefined ? [] : raw.split(/[\n,]/u).map((value): string => value.trim());
  if (targets.length > 16 || targets.some((value): boolean => parseSyslogTarget(value) === null)) {
    throw new Error("Syslog targets must contain at most 16 valid udp://host:port or tcp://host:port destinations");
  }
  const format = (environment["TERRENCE_SYSLOG_FORMAT"] ?? "rfc5424").trim().toLowerCase();
  if (format !== "rfc5424" && format !== "json") throw new Error("TERRENCE_SYSLOG_FORMAT must be rfc5424 or json");
  const logLevel = level(environment["LOG_LEVEL"], "info");
  return Object.freeze({
    LOG_LEVEL: logLevel,
    TERRENCE_SYSLOG_LEVEL: level(environment["TERRENCE_SYSLOG_LEVEL"], logLevel),
    TERRENCE_SYSLOG_TARGETS: Object.freeze(targets),
    TERRENCE_SYSLOG_HOSTNAME: identity(environment["TERRENCE_SYSLOG_HOSTNAME"], null, 255),
    TERRENCE_SYSLOG_APP: identity(environment["TERRENCE_SYSLOG_APP"], "terrence", 48) ?? "terrence",
    TERRENCE_SYSLOG_FORMAT: format,
  });
}
