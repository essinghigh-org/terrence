import { eq } from "drizzle-orm";
import { db } from "../db";
import { adminSettings } from "../db/schema";

export type Settings = Record<string, unknown>;

const settingDefaults: Record<string, Settings> = {
  general: { "local-auth-enabled": true, "limit-user-organization-creation": false, "api-rate-limiting-enabled": false, "api-rate-limit": 30, "plan-timeout": 3600, "apply-timeout": 3600, "send-passing-statuses-for-untriggered-speculative-plans": false, "allow-speculative-plans-on-pull-requests-from-forks": false, "default-remote-state-access": false },
  retention: { "delete-older-than-n-days": null },
  cost: { enabled: false, "aws-access-key-id": null, "aws-secret-key": null, "gcp-credentials": null, "azure-client-id": null, "azure-client-secret": null, "azure-subscription-id": null, "azure-tenant-id": null },
  smtp: { enabled: false, host: null, port: 25, username: null, password: null, "sender-email": null, auth: "plain" },
  twilio: { enabled: false, "account-sid": null, "auth-token": null, "from-number": null },
  customization: { "support-email-address": null, "login-help": null, footer: null },
  saml: { "link-by-email": false },
  oidc: { enabled: false, issuer: null, "client-id": null, "client-secret": null, scopes: "openid profile email", "pkce-method": null, "link-by-email": false },
  ldap: { enabled: false, host: null, port: 389, encryption: "plain", "bind-dn": null, "bind-password": null, "base-dn": null, "user-filter": "(uid={{username}})", "attr-username": "uid", "attr-email": "mail", "attr-display-name": "cn", "link-by-email": false },
  site: { "cost-estimation-enabled": false, "sentinel-enabled": true, "opa-enabled": true, "agent-enabled": false, "module-registry-enabled": true, "provider-registry-enabled": true, "max-run-timeout": 43200, "default-terraform-version": "latest" },
};

export async function getSettings(group: string): Promise<Settings> {
  const defaults = settingDefaults[group] ?? {};
  await db.insert(adminSettings).values({ id: group, values: defaults, updatedAt: Date.now() }).onConflictDoNothing();
  const row = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, group) });
  return { ...defaults, ...(row?.values ?? {}) };
}
