import { validConfiguredCidr } from "./network-config";
import { parseSyslogTarget } from "./syslog-transport";
type Rule = Readonly<{
  kind: "boolean" | "integer" | "headers" | "string" | "enum" | "issuer" | "json" | "syslog-targets" | "ascii" | "url" | "windows" | "cidrs";
  nullable?: boolean;
  min?: number;
  max?: number;
  choices?: readonly string[];
  sensitive?: boolean;
  caseInsensitive?: boolean;
  allowQuery?: boolean;
}>;

export const oidcSigningAlgorithms = ["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"] as const;
const privateString: Rule = { kind: "string", nullable: true, max: 65536, sensitive: true };

/** Rules shared by startup, settings reads, and admin writes. */
export const settingsContract: Readonly<Record<string, Readonly<Record<string, Rule>>>> = {
  general: {
    "local-auth-enabled": { kind: "boolean" },
    "local-signup-enabled": { kind: "boolean", nullable: true },
    "limit-user-organization-creation": { kind: "boolean" },
    "api-rate-limiting-enabled": { kind: "boolean" },
    "api-rate-limit": { kind: "integer", min: 1, max: 1_000_000 },
    "plan-timeout": { kind: "integer", min: 1, max: 604_800 },
    "apply-timeout": { kind: "integer", min: 1, max: 604_800 },
    "send-passing-statuses-for-untriggered-speculative-plans": { kind: "boolean" },
    "allow-speculative-plans-on-pull-requests-from-forks": { kind: "boolean" },
    "default-remote-state-access": { kind: "boolean" },
    "trusted-client-ip-cidrs": { kind: "cidrs", sensitive: true },
    "trusted-client-ip-headers": { kind: "headers" },
  },
  retention: {
    "delete-older-than-n-days": { kind: "integer", min: 1, max: 36500, nullable: true },
  },
  oidc: {
    enabled: { kind: "boolean" },
    "link-by-email": { kind: "boolean" },
    issuer: { kind: "issuer", nullable: true, sensitive: true },
    "client-id": privateString,
    "client-secret": privateString,
    scopes: privateString,
    "pkce-method": { kind: "enum", nullable: true, choices: ["S256", "none"] },
    "signing-alg": { kind: "enum", nullable: true, choices: oidcSigningAlgorithms },
  },
  ldap: {
    enabled: { kind: "boolean" },
    "link-by-email": { kind: "boolean" },
    host: privateString,
    port: { kind: "integer", min: 1, max: 65535 },
    encryption: { kind: "enum", choices: ["plain", "starttls", "ldaps"] },
    "bind-dn": privateString,
    "bind-password": privateString,
    "base-dn": privateString,
    "user-filter": privateString,
    "attr-username": privateString,
    "attr-email": privateString,
    "attr-display-name": privateString,
  },
  site: {
    "cost-estimation-enabled": { kind: "boolean" },
    "sentinel-enabled": { kind: "boolean" },
    "opa-enabled": { kind: "boolean" },
    "agent-enabled": { kind: "boolean" },
    "module-registry-enabled": { kind: "boolean" },
    "provider-registry-enabled": { kind: "boolean" },
    "max-run-timeout": { kind: "integer", min: 1, max: 604800 },
    "default-terraform-version": { kind: "string", max: 128 },
  },
  cost: {
    enabled: { kind: "boolean" },
    "infracost-api-key": privateString,
    "aws-access-key-id": privateString,
    "aws-secret-key": privateString,
    "gcp-credentials": { kind: "json", nullable: true, sensitive: true },
    "azure-client-id": privateString,
    "azure-client-secret": privateString,
    "azure-subscription-id": privateString,
    "azure-tenant-id": privateString,
  },
  twilio: {
    enabled: { kind: "boolean" },
    "account-sid": privateString,
    "auth-token": privateString,
    "from-number": privateString,
  },
  customization: {
    "support-email-address": privateString,
    "login-help": privateString,
    footer: privateString,
  },
  saml: { "link-by-email": { kind: "boolean" } },
  logging: {
    enabled: { kind: "boolean", nullable: true },
    "log-level": { kind: "enum", nullable: true, choices: ["error", "warn", "info", "debug"], caseInsensitive: true },
    "syslog-level": { kind: "enum", nullable: true, choices: ["error", "warn", "info", "debug"], caseInsensitive: true },
    "syslog-targets": { kind: "syslog-targets", nullable: true, sensitive: true },
    "syslog-hostname": { kind: "ascii", nullable: true, max: 255, sensitive: true },
    "syslog-app": { kind: "ascii", nullable: true, max: 48, sensitive: true },
    "syslog-format": { kind: "enum", nullable: true, choices: ["rfc5424", "json"], caseInsensitive: true },
  },
  "approval-webhook": {
    enabled: { kind: "boolean" },
    url: { kind: "url", nullable: true, sensitive: true, allowQuery: true },
    secret: privateString,
  },
  "maintenance-windows": {
    enabled: { kind: "boolean" },
    windows: { kind: "windows", sensitive: true },
  },
  "plan-explainer": {
    enabled: { kind: "boolean" },
    provider: privateString,
    "base-url": { kind: "url", nullable: true, sensitive: true },
    "endpoint-url": { kind: "url", nullable: true, sensitive: true },
    "api-key": privateString,
    model: privateString,
    "reasoning-effort": { kind: "enum", nullable: true, choices: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  },
  smtp: {
    enabled: { kind: "boolean" },
    host: { kind: "string", nullable: true, max: 253, sensitive: true },
    port: { kind: "integer", min: 1, max: 65535 },
    username: { kind: "string", nullable: true, max: 1024, sensitive: true },
    password: { kind: "string", nullable: true, max: 65536, sensitive: true },
    "sender-email": { kind: "string", nullable: true, max: 320, sensitive: true },
    auth: { kind: "enum", choices: ["plain", "login", "none"] },
    encryption: { kind: "enum", choices: ["starttls", "tls", "plain"] },
  },
};

export class SettingsValidationError extends Error {
  public readonly status: 422 | 503;
  constructor(message: string, input: boolean) {
    super(message);
    this.name = "SettingsValidationError";
    this.status = input ? 422 : 503;
  }
}

export function validOidcIssuer(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function validInteger(value: unknown, rule: Rule): boolean {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= (rule.min ?? 0) && value <= (rule.max ?? Number.MAX_SAFE_INTEGER);
}

function validString(value: unknown, rule: Rule): boolean {
  return typeof value === "string" && value.length <= (rule.max ?? 65536) && !value.includes("\u0000");
}

function validJson(value: unknown): boolean {
  return (typeof value === "string" || (typeof value === "object" && !Array.isArray(value))) && JSON.stringify(value).length <= 65536;
}

function validHeaders(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 16
    && value.every((header: unknown): boolean => typeof header === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(header));
}

function validEnum(value: unknown, rule: Rule): boolean {
  if (typeof value !== "string") return false;
  return rule.choices?.includes(rule.caseInsensitive === true ? value.trim().toLowerCase() : value) === true;
}

function validSyslogTargets(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 16
    && value.every((target: unknown): boolean => typeof target === "string" && parseSyslogTarget(target) !== null);
}

function validAscii(value: unknown, rule: Rule): boolean {
  return typeof value === "string" && value.trim().length <= (rule.max ?? 255) && /^[\x21-\x7E]+$/u.test(value.trim());
}

function validHttpUrl(value: unknown, rule: Rule): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === ""
      && url.hash === "" && (rule.allowQuery === true || url.search === "");
  } catch { return false; }
}

function validClock(value: unknown): boolean {
  return typeof value === "string" && /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value);
}

function validWindow(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Record<string, unknown>;
  if (Object.keys(window).some((key): boolean => !["days", "start-time", "end-time", "timezone"].includes(key))) return false;
  const days = window["days"];
  if (!Array.isArray(days) || days.length > 7 || !days.every((day: unknown): boolean => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6)) return false;
  if (!validClock(window["start-time"]) || !validClock(window["end-time"])) return false;
  const timezone = window["timezone"];
  if (timezone === undefined) return true;
  if (typeof timezone !== "string" || timezone === "") return false;
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return true; } catch { return false; }
}

function validWindows(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 100 && value.every(validWindow);
}

function validCidrs(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 256 && value.every((entry: unknown): boolean => typeof entry === "string" && validConfiguredCidr(entry));
}

function matchesRule(value: unknown, rule: Rule): boolean {
  if (value === null) return rule.nullable === true;
  switch (rule.kind) {
    case "url": return validHttpUrl(value, rule);
    case "cidrs": return validCidrs(value);
    case "windows": return validWindows(value);
    case "json": return validJson(value);
    case "issuer": return typeof value === "string" && validOidcIssuer(value);
    case "boolean": return typeof value === "boolean";
    case "string": return validString(value, rule);
    case "enum": return validEnum(value, rule);
    case "syslog-targets": return validSyslogTargets(value);
    case "ascii": return validAscii(value, rule);
    case "integer": return validInteger(value, rule);
    case "headers": return validHeaders(value);
  }
}

export function configurationReportValue(group: string, key: string, value: unknown): unknown {
  const rule = settingsContract[group]?.[key];
  return rule?.sensitive === true && value !== null ? "[redacted]" : value;
}

export function validateSettings(group: string, values: Readonly<Record<string, unknown>>, input = false): void {
  const rules = Object.hasOwn(settingsContract, group) ? settingsContract[group] : undefined;
  if (rules === undefined) return;
  for (const [key, value] of Object.entries(values)) {
    const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
    // Unknown names can themselves contain secrets; never echo them.
    if (rule === undefined) throw new SettingsValidationError(`Unsupported setting in ${group}`, input);
    if (!matchesRule(value, rule)) throw new SettingsValidationError(`Invalid ${group}.${key} configuration`, input);
  }
  validateEnabledAuthentication(group, values, input);
}

function validateEnabledAuthentication(group: string, values: Readonly<Record<string, unknown>>, input: boolean): void {
  if (values["enabled"] !== true) return;
  const present = (key: string): boolean => typeof values[key] === "string" && values[key].trim() !== "";
  if (group === "oidc") {
    if (!present("issuer") || !present("client-id")) throw new SettingsValidationError("Enabled OIDC requires issuer and client-id", input);
    const algorithm = values["signing-alg"];
    if ((values["pkce-method"] !== "S256" || (typeof algorithm === "string" && algorithm.startsWith("HS"))) && !present("client-secret")) {
      throw new SettingsValidationError("OIDC requires a client secret unless using S256 with asymmetric signing", input);
    }
  }
  if (group === "ldap") {
    if (!present("host") || !present("base-dn")) throw new SettingsValidationError("Enabled LDAP requires host and base-dn", input);
    if (present("bind-dn") && !present("bind-password")) throw new SettingsValidationError("LDAP service account requires a bind password", input);
  }
}
