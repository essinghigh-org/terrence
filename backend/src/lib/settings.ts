import { eq } from "drizzle-orm";
import { db } from "../db";
import { adminSettings } from "../db/schema";

export type Settings = Record<string, unknown>;

const settingDefaults: Record<string, Settings> = {
  general: { "local-auth-enabled": true, "limit-user-organization-creation": false, "api-rate-limiting-enabled": false, "api-rate-limit": 30, "plan-timeout": 3600, "apply-timeout": 3600, "send-passing-statuses-for-untriggered-speculative-plans": false, "allow-speculative-plans-on-pull-requests-from-forks": false, "default-remote-state-access": false, "trusted-client-ip-headers": [] },
  retention: { "delete-older-than-n-days": null },
  cost: { enabled: false, "aws-access-key-id": null, "aws-secret-key": null, "gcp-credentials": null, "azure-client-id": null, "azure-client-secret": null, "azure-subscription-id": null, "azure-tenant-id": null },
  smtp: { enabled: false, host: null, port: 25, username: null, password: null, "sender-email": null, auth: "plain" },
  twilio: { enabled: false, "account-sid": null, "auth-token": null, "from-number": null },
  customization: { "support-email-address": null, "login-help": null, footer: null },
  saml: { "link-by-email": false },
  oidc: { enabled: false, issuer: null, "client-id": null, "client-secret": null, scopes: "openid profile email", "pkce-method": null, "signing-alg": null, "link-by-email": false },
  ldap: { enabled: false, host: null, port: 636, encryption: "ldaps", "bind-dn": null, "bind-password": null, "base-dn": null, "user-filter": "(uid={{username}})", "attr-username": "uid", "attr-email": "mail", "attr-display-name": "cn", "link-by-email": false },
  site: { "cost-estimation-enabled": false, "sentinel-enabled": true, "opa-enabled": true, "agent-enabled": false, "module-registry-enabled": true, "provider-registry-enabled": true, "max-run-timeout": 43200, "default-terraform-version": "latest" },
  "approval-webhook": { enabled: false, url: null, secret: null },
  "maintenance-windows": { enabled: false, windows: [] },
  "plan-explainer": { enabled: false, provider: null, "endpoint-url": null, "api-key": null, model: null },
};

const SETTINGS_CACHE_TTL_MS = 1_000;
const settingsCache = new Map<string, { values: Settings; fetchedAt: number }>();

/** Force the next getSettings(group) to hit the database (after admin writes). */
export function invalidateSettingsCache(): void {
  settingsCache.clear();
}

export async function getSettings(group: string): Promise<Settings> {
  const defaults = settingDefaults[group] ?? {};
  const cached = settingsCache.get(group);
  if (cached !== undefined && cached.fetchedAt + SETTINGS_CACHE_TTL_MS > Date.now()) {
    return { ...defaults, ...cached.values };
  }
  // Initialization writes an empty map: unset keys keep inheriting the
  // current defaults, so future default changes apply without a rewrite.
  await db.insert(adminSettings).values({ id: group, values: {}, updatedAt: Date.now() })
    .onConflictDoNothing();
  const row = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, group) });
  const values = row?.values ?? {};
  settingsCache.set(group, { values, fetchedAt: Date.now() });
  return { ...defaults, ...values };
}
