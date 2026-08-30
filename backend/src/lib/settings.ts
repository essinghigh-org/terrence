import { eq } from "drizzle-orm";
import { db } from "../db";
import { adminSettings, organizations } from "../db/schema";
import { CUSTOM_PROVIDER_ID, getCatalogProviderModels } from "./model-catalog";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secrets";

export type Settings = Record<string, unknown>;

const settingDefaults: Record<string, Settings> = {
  general: { "local-auth-enabled": true, "limit-user-organization-creation": false, "api-rate-limiting-enabled": false, "api-rate-limit": 30, "plan-timeout": 3600, "apply-timeout": 3600, "send-passing-statuses-for-untriggered-speculative-plans": false, "allow-speculative-plans-on-pull-requests-from-forks": false, "default-remote-state-access": false, "trusted-client-ip-headers": [] },
  retention: { "delete-older-than-n-days": null },
  cost: { enabled: false, "infracost-api-key": null, "aws-access-key-id": null, "aws-secret-key": null, "gcp-credentials": null, "azure-client-id": null, "azure-client-secret": null, "azure-subscription-id": null, "azure-tenant-id": null },
  smtp: { enabled: false, host: null, port: 25, username: null, password: null, "sender-email": null, auth: "plain", encryption: "starttls" },
  twilio: { enabled: false, "account-sid": null, "auth-token": null, "from-number": null },
  customization: { "support-email-address": null, "login-help": null, footer: null },
  saml: { "link-by-email": false },
  oidc: { enabled: false, issuer: null, "client-id": null, "client-secret": null, scopes: "openid profile email", "pkce-method": null, "signing-alg": null, "link-by-email": false },
  ldap: { enabled: false, host: null, port: 636, encryption: "ldaps", "bind-dn": null, "bind-password": null, "base-dn": null, "user-filter": "(uid={{username}})", "attr-username": "uid", "attr-email": "mail", "attr-display-name": "cn", "link-by-email": false },
  site: { "cost-estimation-enabled": false, "sentinel-enabled": true, "opa-enabled": true, "agent-enabled": false, "module-registry-enabled": true, "provider-registry-enabled": true, "max-run-timeout": 43200, "default-terraform-version": "latest" },
  "approval-webhook": { enabled: false, url: null, secret: null },
  "maintenance-windows": { enabled: false, windows: [] },
  "plan-explainer": { enabled: false, provider: null, "base-url": null, "api-key": null, model: null, "reasoning-effort": null },
};

const encryptedSettingKeys: Readonly<Record<string, readonly string[]>> = {
  cost: ["infracost-api-key", "aws-secret-key", "gcp-credentials", "azure-client-secret"],
  smtp: ["password"],
  twilio: ["auth-token"],
  oidc: ["client-secret"],
  ldap: ["bind-password"],
  "approval-webhook": ["secret"],
  "plan-explainer": ["api-key"],
};

function secretKeysForGroup(group: string): ReadonlySet<string> {
  return new Set(encryptedSettingKeys[group] ?? []);
}

async function decryptSettingsValues(group: string, storedValues: Readonly<Settings>): Promise<Settings> {
  const secretKeys = secretKeysForGroup(group);
  const entries = await Promise.all(Object.entries(storedValues).map(async ([key, value]): Promise<[string, unknown]> => {
    if (!secretKeys.has(key) || typeof value !== "string") return [key, value];
    const encrypted = isEncryptedSecret(value);
    const decrypted = await decryptSecret(value);
    // GCP credentials are accepted as a JSON object by the admin API. Objects
    // written before encryption remain objects; encrypted object values are
    // serialized as JSON and restored to that same runtime shape here.
    if (group === "cost" && key === "gcp-credentials" && encrypted) {
      try {
        return [key, JSON.parse(decrypted) as unknown];
      } catch {
        // Preserve an encrypted non-JSON string for backwards compatibility.
      }
    }
    return [key, decrypted];
  }));
  return Object.fromEntries(entries);
}

export async function encryptSettingsValues(group: string, values: Readonly<Settings>): Promise<Settings> {
  const secretKeys = secretKeysForGroup(group);
  const storedValues: Settings = { ...values };
  for (const key of secretKeys) {
    const value = storedValues[key];
    if (typeof value === "string") {
      storedValues[key] = await encryptSecret(value, { force: true });
    } else if (value !== null && typeof value === "object") {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined) storedValues[key] = await encryptSecret(serialized);
    }
  }
  return storedValues;
}

const SETTINGS_CACHE_TTL_MS = 1_000;
const settingsCache = new Map<string, { values: Settings; fetchedAt: number }>();

function effectiveSettings(group: string, defaults: Readonly<Settings>, values: Readonly<Settings>): Settings {
  const merged = { ...defaults, ...values };
  // Older SMTP rows have no encryption key. Keep port 465's established
  // implicit-TLS behavior while making every other legacy configuration
  // require STARTTLS instead of silently downgrading.
  if (group === "smtp" && (values.encryption === undefined || values.encryption === null)) {
    merged.encryption = merged.port === 465 ? "tls" : "starttls";
  }
  return merged;
}

async function readPersistedSettings(group: string): Promise<Settings> {
  // Initialization writes an empty map: unset keys keep inheriting the
  // current defaults, so future default changes apply without a rewrite.
  await db.insert(adminSettings).values({ id: group, values: {}, updatedAt: Date.now() })
    .onConflictDoNothing();
  const row = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, group) });
  return decryptSettingsValues(group, row?.values ?? {});
}

/** Force the next getSettings(group) to hit the database (after admin writes). */
export function invalidateSettingsCache(): void {
  settingsCache.clear();
}

/** Read the latest persisted settings without using the process-local cache. */
export async function getSettingsFresh(group: string): Promise<Settings> {
  const defaults = settingDefaults[group] ?? {};
  return effectiveSettings(group, defaults, await readPersistedSettings(group));
}

export async function getSettings(group: string): Promise<Settings> {
  const defaults = settingDefaults[group] ?? {};
  const cached = settingsCache.get(group);
  if (cached !== undefined && cached.fetchedAt + SETTINGS_CACHE_TTL_MS > Date.now()) {
    return effectiveSettings(group, defaults, cached.values);
  }
  const values = await readPersistedSettings(group);
  settingsCache.set(group, { values, fetchedAt: Date.now() });
  return effectiveSettings(group, defaults, values);
}

/** Resolve the one effective cost-estimation gate used by API and workers. */
export async function costEstimationEnabledForOrganization(orgId: string): Promise<boolean> {
  const [settings, organization] = await Promise.all([
    getSettings("cost"),
    db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { costEstimationEnabled: true } }),
  ]);
  return settings.enabled === true && organization?.costEstimationEnabled === true;
}

/** Normalize an optional provider base URL and accept the old full endpoint. */
export function normalizePlanExplainerBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === ""
      || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
    let pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/chat/completions")) pathname = pathname.slice(0, -"/chat/completions".length).replace(/\/+$/, "");
    url.pathname = pathname;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Resolve a configured override or the selected provider's models.dev URL. */
export async function resolvePlanExplainerSettings(settings: Readonly<Settings>): Promise<Settings | null> {
  if (settings.enabled !== true || typeof settings.model !== "string" || settings.model.trim() === "") return null;
  let baseUrl = normalizePlanExplainerBaseUrl(settings["base-url"])
    ?? normalizePlanExplainerBaseUrl(settings["endpoint-url"]);
  const provider = typeof settings.provider === "string" ? settings.provider.trim() : "";
  if (baseUrl === null && provider !== "" && provider !== CUSTOM_PROVIDER_ID) {
    baseUrl = (await getCatalogProviderModels(provider))?.baseUrl ?? null;
  }
  return baseUrl === null ? null : { ...settings, "base-url": baseUrl };
}

/**
 * True when the plan-explainer feature is enabled and has a model plus either
 * an explicit base URL or a usable base URL from the provider catalog.
 */
export async function planExplainerUsable(settings: Readonly<Settings>): Promise<boolean> {
  return (await resolvePlanExplainerSettings(settings)) !== null;
}

/**
 * Site-level feature capabilities surfaced to the UI through the org
 * resource (`attributes.capabilities`). This is the generic primitive for
 * config-gated UI: add a new capability here, gate any view with the
 * useCapability() hook, and the button/section hides itself when the
 * feature is disabled or misconfigured. Keys must be stable kebab-case.
 */
export async function getSiteCapabilities(): Promise<Readonly<Record<string, boolean>>> {
  const [explainer, cost] = await Promise.all([
    getSettings("plan-explainer"),
    getSettings("cost"),
  ]);
  return {
    agents: true,
    "audit-logging": true,
    "configuration-designer": true,
    "configuration-version": true,
    "global-run-tasks": true,
    "module-testing": true,
    "no-code": true,
    opa: true,
    operations: true,
    "policy-enforcement": true,
    "policy-evaluations": true,
    "private-module-registry": true,
    "private-policy-agents": true,
    "private-registry": true,
    "private-run-tasks": true,
    "private-vcs": true,
    "run-tasks": true,
    sentinel: true,
    sso: true,
    "state-storage": true,
    teams: true,
    "usage-reporting": true,
    "vcs-integrations": true,
    "cost-estimation": cost.enabled === true,
    "plan-explainer": await planExplainerUsable(explainer),
  };
}
