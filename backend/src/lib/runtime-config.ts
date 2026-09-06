import { deploymentSecretNames, parseDeploymentSecret, parseSecretConfiguration, type DeploymentSecretName, type SecretConfiguration } from "./secret-config";
import { parseIntegrationConfiguration, type IntegrationConfiguration } from "./integration-config";
import { parseNetworkConfiguration, type NetworkConfiguration } from "./network-config";
import { assertKnownEnvironmentNames } from "./environment-names";
import { parseListenerConfiguration, type ListenerConfiguration } from "./listener-config";
import { parseLoggingEnvironment, type LoggingEnvironment } from "./logging-config";
/** Deployment settings are parsed before startup side effects. Never include
 * supplied values in errors: even a misspelled setting can contain a secret. */
type IntegerRule = Readonly<{ default: number; min: number; max: number }>;
const timerMaximum = 2_147_483_647;
export const integerConfiguration = {
  TERRENCE_PASSWORD_MIN_LENGTH: { default: 10, min: 1, max: 72 },
  TERRENCE_WORKER_POLL_MS: { default: 1500, min: 100, max: 2147483647 },
  TERRENCE_AUTO_DESTROY_POLL_MS: { default: 30000, min: 5000, max: 2147483647 },
  TERRENCE_ASSESSMENT_POLL_MS: { default: 60000, min: 5000, max: 2147483647 },
  TERRENCE_DB_STATEMENT_TIMEOUT_MS: { default: 30000, min: 0, max: 86400000 },
  TERRENCE_DB_LOCK_TIMEOUT_MS: { default: 10000, min: 0, max: 86400000 },
  TERRENCE_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: { default: 60000, min: 0, max: 86400000 },
  TERRENCE_VERSION_CACHE_TTL_MS: { default: 86400000, min: 1, max: 31536000000 },
  TERRENCE_BINARY_DOWNLOAD_TIMEOUT_MS: { default: 120000, min: 1, max: 2147483647 },
  TERRENCE_BINARY_DOWNLOAD_RETRIES: { default: 2, min: 0, max: 5 },
  TERRENCE_BINARY_PROBE_TIMEOUT_MS: { default: 10000, min: 1, max: 2147483647 },
  LOG_CAPABILITY_TTL_SECONDS: { default: 172800, min: 1, max: 604800 },
  SIGNED_URL_TTL_SECONDS: { default: 300, min: 1, max: 604800 },
  GC_GRACE_PERIOD_DAYS: { default: 7, min: 0, max: 36500 },
  TERRENCE_EXPLAIN_TIMEOUT_MS: { default: 60000, min: 1, max: 2147483647 },
  AGENT_HEARTBEAT_TIMEOUT_MS: { default: 60000, min: 1, max: 2147483647 },
  TERRENCE_AGENT_FORWARD_TIMEOUT_MS: { default: 60000, min: 1000, max: 300000 },
  CLI_TOKEN_TTL_MS: { default: 2592000000, min: 1, max: 31536000000 },
  MIGRATION_DRAIN_TIMEOUT_MS: { default: 1800000, min: 1, max: 2147483647 },
  MIGRATION_CHECKPOINT_RETRIES: { default: 15, min: 1, max: 100 },
  TERRENCE_DB_SLOW_QUERY_MS: { default: 1000, min: 1, max: 2147483647 },
  TERRENCE_RECOVERY_RETENTION_MS: { default: 604800000, min: 0, max: 31536000000 },
  AVATAR_CACHE_MAX_BYTES: { default: 67108864, min: 1, max: 10737418240 },
  AVATAR_CACHE_MAX_ENTRIES: { default: 2048, min: 1, max: 1000000 },
  AVATAR_CACHE_MAX_AGE_MS: { default: 2592000000, min: 1, max: 31536000000 },
  PORT: { default: 3000, min: 1, max: 65535 },
  SYSTEM_API_PORT: { default: 8443, min: 1, max: 65535 },
  TERRENCE_DRAIN_GRACE_MS: { default: 6000, min: 0, max: 25000 },
  TERRENCE_RUN_CONCURRENCY: { default: 5, min: 1, max: 1024 },
  HEALTH_ASSESSMENT_CONCURRENCY: { default: 2, min: 1, max: 1024 },
  HEALTH_ASSESSMENT_INTERVAL_MS: { default: 86_400_000, min: 1, max: timerMaximum },
  RUN_TASK_TIMEOUT_MS: { default: 3_600_000, min: 1, max: timerMaximum },
  RATE_LIMIT_MAX: { default: 60, min: 1, max: 1_000_000 },
  RATE_LIMIT_SENSITIVE_MAX: { default: 5, min: 1, max: 1_000_000 },
  RATE_LIMIT_SSO_GET_MAX: { default: 60, min: 1, max: 1_000_000 },
  RATE_LIMIT_SCIM_SETTINGS_MAX: { default: 20, min: 1, max: 1_000_000 },
  RATE_LIMIT_SCIM_MAPPING_MAX: { default: 10, min: 1, max: 1_000_000 },
  RATE_LIMIT_WORKSPACE_RUN_HISTORY_MAX: { default: 120, min: 1, max: 1_000_000 },
  RATE_LIMIT_WORKSPACE_RUN_HISTORY_DURATION_MS: { default: 60_000, min: 1, max: timerMaximum },
  RATE_LIMIT_METRICS_MAX: { default: 30, min: 1, max: 1_000_000 },
} as const satisfies Readonly<Record<string, IntegerRule>>;

export type IntegerConfigurationName = keyof typeof integerConfiguration;
export const booleanConfiguration = {
  TERRENCE_PASSWORD_REQUIRE_UPPER: false,
  TERRENCE_PASSWORD_REQUIRE_LOWER: false,
  TERRENCE_PASSWORD_REQUIRE_DIGIT: false,
  TERRENCE_PASSWORD_REQUIRE_SYMBOL: false,
  TERRENCE_PASSWORD_DISALLOW_USERNAME: false,
  AUDIT_STRICT: false,
  TERRENCE_CSP_STRICT: false,
  ALLOW_TOOL_FALLBACK: false,
  ALLOW_UNVERIFIED_CHECKSUMS: false,
  IACT_QUERY_TOKEN_ENABLED: false,
  INFRACOST_ENABLED: false,
  MIGRATION_SKIP_DRAIN: false,
  SIMULATED_RUNS: false,
  SIMULATED_STACK_DEFERRED: false,
  SIMULATED_STACK_PLAN_CHANGES: false,
  TERRENCE_ADMIN_PASSWORD_RESET: false,
  TERRENCE_ALLOW_INSECURE_OAUTH_URLS: false,
  TERRENCE_ALLOW_INSECURE_RUN_TASK_URLS: false,
  TERRENCE_ALLOW_PRIVATE_URLS: false,
  TERRENCE_ALLOW_PRIVATE_VCS_URLS: false,
  TERRENCE_DISABLE_RESTART: false,
  TERRENCE_DISABLE_WORKER: false,
  TERRENCE_ENABLE_LOCAL_SIGNUP: false,
  TERRENCE_QUERY_COUNT: false,
  TERRENCE_QUERY_LOG: false,
  TERRENCE_SANDBOX_EXTRA_RW_ALLOWED: false,
  TERRENCE_SANDBOX_EXTRA_RW_ALLOW_STORAGE: false,
} as const;
export type BooleanConfigurationName = keyof typeof booleanConfiguration;

type ExecutionConfiguration = Readonly<
  Record<"TERRENCE_RUN_SANDBOX", boolean>
  & Record<"TERRENCE_RUN_NET_POLICY", "allow" | "deny">
  & Record<"TERRENCE_EXECUTOR_BACKEND", "landlock" | "container" | "kubernetes" | "agent" | "microvm">
  & Record<"PUBLIC_URL", string | null>
  & Record<"CORS_ORIGIN", readonly string[]>
  & Record<"TERRENCE_SANDBOX_MIN_ABI", number | null>
>;
export type RuntimeConfiguration = Readonly<Record<IntegerConfigurationName, number>> & ExecutionConfiguration & Readonly<Record<BooleanConfigurationName, boolean>> & LoggingEnvironment & ListenerConfiguration & NetworkConfiguration & IntegrationConfiguration & SecretConfiguration;
type Environment = Readonly<Record<string, string | undefined>>;
export type ConfigurationReportEntry = Readonly<{
  name: keyof RuntimeConfiguration;
  value: RuntimeConfiguration[keyof RuntimeConfiguration];
  origin: "environment" | "default";
  restartRequired: true;
}>;

function parseInteger(name: IntegerConfigurationName, environment: Environment): number {
  const rule = integerConfiguration[name];
  const raw = environment[name];
  if (raw === undefined) return rule.default;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < rule.min || value > rule.max) {
    throw new Error(`${name} must be an integer between ${String(rule.min)} and ${String(rule.max)}`);
  }
  return value;
}

function parseBoolean(name: BooleanConfigurationName, environment: Environment): boolean {
  const raw = environment[name];
  if (raw === undefined) return booleanConfiguration[name];
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function parsePublicUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== ""
      || url.search !== "" || url.hash !== "" || raw.trim() !== raw) throw new Error();
    return url.toString();
  } catch {
    throw new Error("PUBLIC_URL must be an HTTP(S) URL without credentials, query, or fragment");
  }
}

function parseOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw === "") return Object.freeze([]);
  const origins = raw.split(",").map((entry): string => entry.trim());
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error();
    } catch {
      throw new Error("CORS_ORIGIN must be comma-separated HTTP(S) origins without paths, credentials, query, or fragment");
    }
  }
  return Object.freeze([...new Set(origins)]);
}

function parseSandboxMinimum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > 255) {
    throw new Error("TERRENCE_SANDBOX_MIN_ABI must be an integer between 1 and 255");
  }
  return value;
}

function parseExecutionConfiguration(environment: Environment): ExecutionConfiguration {
  const executor = (environment["TERRENCE_EXECUTOR_BACKEND"] ?? "landlock").trim().toLowerCase();
  if (executor !== "landlock" && executor !== "container" && executor !== "kubernetes" && executor !== "agent" && executor !== "microvm") {
    throw new Error("TERRENCE_EXECUTOR_BACKEND must be landlock, container, kubernetes, agent, or microvm");
  }
  const sandbox = (environment["TERRENCE_RUN_SANDBOX"] ?? "true").toLowerCase();
  if (!["true", "1", "yes", "on", "false", "0", "none", "no", "off"].includes(sandbox)) {
    throw new Error("TERRENCE_RUN_SANDBOX must be true or false (1/0, yes/no, on/off, and none are accepted aliases)");
  }
  const required = ["true", "1", "yes", "on"].includes(sandbox);
  const policy = (environment["TERRENCE_RUN_NET_POLICY"] ?? "allow").toLowerCase().trim();
  if (policy !== "allow" && policy !== "deny") throw new Error("TERRENCE_RUN_NET_POLICY must be allow or deny");
  if (!required && policy === "deny") throw new Error("TERRENCE_RUN_NET_POLICY=deny requires TERRENCE_RUN_SANDBOX=true");
  return {
    TERRENCE_SANDBOX_MIN_ABI: parseSandboxMinimum(environment["TERRENCE_SANDBOX_MIN_ABI"]),
    TERRENCE_EXECUTOR_BACKEND: executor,
    TERRENCE_RUN_SANDBOX: required,
    TERRENCE_RUN_NET_POLICY: policy,
    PUBLIC_URL: parsePublicUrl(environment["PUBLIC_URL"]),
    CORS_ORIGIN: parseOrigins(environment["CORS_ORIGIN"]),
  };
}

export function parseRuntimeConfiguration(environment: Environment, rejectUnknown = false): RuntimeConfiguration {
  const values = Object.fromEntries(Object.keys(integerConfiguration).map((key): [string, number] => {
    const name = key as IntegerConfigurationName;
    return [name, parseInteger(name, environment)];
  })) as Record<IntegerConfigurationName, number>;
  if (values.PORT === values.SYSTEM_API_PORT) {
    throw new Error("PORT and SYSTEM_API_PORT must use different ports");
  }
  const flags = Object.fromEntries(Object.keys(booleanConfiguration).map((key): [string, boolean] => {
    const name = key as BooleanConfigurationName;
    return [name, parseBoolean(name, environment)];
  })) as Record<BooleanConfigurationName, boolean>;
  const configuration = Object.freeze({ ...values, ...flags, ...parseExecutionConfiguration(environment), ...parseLoggingEnvironment(environment), ...parseListenerConfiguration(environment), ...parseNetworkConfiguration(environment), ...parseIntegrationConfiguration(environment), ...parseSecretConfiguration(environment) });
  if (rejectUnknown && Object.keys(environment).some((key): boolean => !Object.hasOwn(configuration, key) && key !== "TERRENCE_SYSLOG_TARGET")) {
    throw new Error("Unsupported setting in configuration example");
  }
  assertKnownEnvironmentNames(environment, configuration);
  return configuration;
}

let startupConfiguration: RuntimeConfiguration | undefined;
let startupReport: readonly ConfigurationReportEntry[] | undefined;

function configurationReport(values: RuntimeConfiguration, environment: Environment): readonly ConfigurationReportEntry[] {
  const redacted = new Set<string>([...deploymentSecretNames, "TERRENCE_SANDBOX_EXTRA_RW_PATHS", "TERRENCE_AGENT_UPDATE_URL", "GITHUB_API_URL", "GITHUB_APP_API_URL", "GITHUB_APP_HTTP_URL", "SYSTEM_API_TLS_CERT", "SYSTEM_API_TLS_KEY", "STORAGE_DIR", "TERRENCE_SYSLOG_TARGETS", "TERRENCE_SYSLOG_HOSTNAME", "TERRENCE_SYSLOG_APP"]);
  return Object.freeze(Object.keys(values).map((key): ConfigurationReportEntry => {
    const name = key as keyof RuntimeConfiguration;
    const inherited = name === "GITHUB_APP_API_URL" ? environment["GITHUB_API_URL"] : name === "TERRENCE_SYSLOG_TARGETS" ? environment["TERRENCE_SYSLOG_TARGET"]
      : name === "TERRENCE_SYSLOG_LEVEL" ? environment["LOG_LEVEL"] : undefined;
    return Object.freeze({ name, value: redacted.has(name) ? "[redacted]" : values[name], origin: environment[name] === undefined && inherited === undefined ? "default" : "environment", restartRequired: true });
  }));
}

export function initializeRuntimeConfiguration(environment: Environment = process.env): RuntimeConfiguration {
  if (startupConfiguration !== undefined) return startupConfiguration;
  const values = parseRuntimeConfiguration(environment);
  startupReport = configurationReport(values, environment);
  startupConfiguration = values;
  return values;
}

/** Production callers share the startup snapshot. Isolated library consumers
 * still validate their individual setting without requiring server startup. */
export function integerSetting(name: IntegerConfigurationName): number {
  return startupConfiguration?.[name] ?? parseInteger(name, process.env);
}

export function executionSetting<Name extends keyof ExecutionConfiguration>(name: Name): ExecutionConfiguration[Name] {
  return startupConfiguration === undefined ? parseExecutionConfiguration(process.env)[name] : startupConfiguration[name];
}

export function runtimeConfigurationReport(): readonly ConfigurationReportEntry[] {
  return startupReport ?? configurationReport(parseRuntimeConfiguration(process.env), process.env);
}

export function booleanSetting(name: BooleanConfigurationName): boolean {
  return startupConfiguration?.[name] ?? parseBoolean(name, process.env);
}

export function loggingSetting<Name extends keyof LoggingEnvironment>(name: Name): LoggingEnvironment[Name] {
  return startupConfiguration === undefined ? parseLoggingEnvironment(process.env)[name] : startupConfiguration[name];
}

export function listenerSetting<Name extends keyof ListenerConfiguration>(name: Name): ListenerConfiguration[Name] {
  return startupConfiguration === undefined ? parseListenerConfiguration(process.env)[name] : startupConfiguration[name];
}

export function networkSetting(name: keyof NetworkConfiguration): readonly string[] {
  return startupConfiguration === undefined ? parseNetworkConfiguration(process.env)[name] : startupConfiguration[name];
}

export function integrationSetting<Name extends keyof IntegrationConfiguration>(name: Name): IntegrationConfiguration[Name] {
  return startupConfiguration === undefined ? parseIntegrationConfiguration(process.env)[name] : startupConfiguration[name];
}

export function deploymentSecret(name: DeploymentSecretName): string | undefined {
  return startupConfiguration === undefined ? parseDeploymentSecret(name, process.env[name]) : startupConfiguration[name];
}
