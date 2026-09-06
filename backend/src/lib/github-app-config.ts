import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { db } from "../db";
import { adminSettings } from "../db/schema";
import { integrationSetting } from "./runtime-config";
import { decryptSecret, encryptSecret } from "./secrets";

/**
 * The GitHub App is site-wide.  Keep its lifecycle state in the existing
 * encrypted admin-settings store instead of coupling it to an organization or
 * adding a second credential table.  The row is deliberately a singleton so
 * a disconnected app cannot be rediscovered from deployment environment on a
 * later restart.
 */
export const GITHUB_APP_SETTINGS_ID = "github-app";
export const GITHUB_APP_SETTINGS_VERSION = 1;

export type GitHubAppSource = "manifest" | "manual" | "legacy_environment_import";
export type GitHubAppStatus = "active" | "disconnected" | "invalid";

export type GitHubAppConfiguration = Readonly<{
  appId: number;
  appIdText: string;
  slug: string;
  name: string | null;
  owner: string | null;
  privateKey: string;
  webhookSecret: string | null;
  clientId: string | null;
  clientSecret: string | null;
  apiUrl: string;
  httpUrl: string;
  source: GitHubAppSource;
}>;

export type GitHubAppInstallationSummary = Readonly<{
  installationId: number;
  owner: string;
  ownerType: "Organization" | "User";
}>;

export type GitHubAppPendingConfiguration = Readonly<{
  flowId: string;
  configuration: GitHubAppConfiguration;
  requiredOwners: readonly string[];
  installations: readonly GitHubAppInstallationSummary[];
  createdAt: number;
}>;

export type GitHubAppRecord = Readonly<{
  status: GitHubAppStatus;
  source: GitHubAppSource | null;
  bootstrapConsumed: boolean;
  configuration: GitHubAppConfiguration | null;
  pending: GitHubAppPendingConfiguration | null;
  invalidReason: string | null;
  updatedAt: number;
}>;

type MutableConfiguration = Omit<GitHubAppConfiguration, "privateKey" | "webhookSecret" | "clientSecret"> & {
  privateKey: string;
  webhookSecret: string | null;
  clientSecret: string | null;
};

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : nonEmptyString(value);
  if (text === null || !/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeHttpUrl(value: unknown, fallback: string): string | null {
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function appSlug(value: unknown): string | null {
  const slug = nonEmptyString(value);
  return slug !== null && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(slug) ? slug : null;
}

function appConfigurationFromValues(values: JsonRecord, source: GitHubAppSource): MutableConfiguration | null {
  const appId = positiveInteger(values["appId"] ?? values["app-id"]);
  const slug = appSlug(values["slug"]);
  const privateKey = nonEmptyString(values["privateKey"] ?? values["private-key"]);
  if (appId === null || slug === null || privateKey === null) return null;
  const apiUrl = safeHttpUrl(values["apiUrl"] ?? values["api-url"], "https://api.github.com");
  const httpUrl = safeHttpUrl(values["httpUrl"] ?? values["http-url"], "https://github.com");
  if (apiUrl === null || httpUrl === null) return null;
  const name = nonEmptyString(values["name"]);
  const owner = nonEmptyString(values["owner"]);
  const webhookSecret = nonEmptyString(values["webhookSecret"] ?? values["webhook-secret"]);
  const clientId = nonEmptyString(values["clientId"] ?? values["client-id"]);
  const clientSecret = nonEmptyString(values["clientSecret"] ?? values["client-secret"]);
  return {
    appId,
    appIdText: String(appId),
    slug,
    name,
    owner,
    privateKey,
    webhookSecret,
    clientId,
    clientSecret,
    apiUrl,
    httpUrl,
    source,
  };
}

async function decryptField(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || value === "") return null;
  try {
    return await decryptSecret(value);
  } catch {
    return null;
  }
}

async function readConfiguration(values: JsonRecord, source: GitHubAppSource): Promise<MutableConfiguration | null> {
  const decrypted = { ...values };
  decrypted["privateKey"] = await decryptField(values["privateKey"]);
  decrypted["webhookSecret"] = await decryptField(values["webhookSecret"]);
  decrypted["clientSecret"] = await decryptField(values["clientSecret"]);
  return appConfigurationFromValues(decrypted, source);
}

function storedConfiguration(values: Readonly<MutableConfiguration>): JsonRecord {
  return {
    appId: values.appId,
    appIdText: values.appIdText,
    slug: values.slug,
    name: values.name,
    owner: values.owner,
    privateKey: values.privateKey,
    webhookSecret: values.webhookSecret,
    clientId: values.clientId,
    clientSecret: values.clientSecret,
    apiUrl: values.apiUrl,
    httpUrl: values.httpUrl,
    source: values.source,
  };
}

async function loadRecord(): Promise<GitHubAppRecord | null> {
  const row = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, GITHUB_APP_SETTINGS_ID) });
  if (row === undefined) return null;
  const values = asRecord(row.values);
  if (values === null) {
    return {
      status: "invalid",
      source: null,
      bootstrapConsumed: true,
      configuration: null,
      pending: null,
      invalidReason: "The stored GitHub App configuration is malformed",
      updatedAt: row.updatedAt,
    };
  }
  const sourceValue = values["source"];
  const source: GitHubAppSource | null = sourceValue === "manifest" || sourceValue === "manual" || sourceValue === "legacy_environment_import"
    ? sourceValue
    : null;
  const statusValue = values["status"];
  const status: GitHubAppStatus = statusValue === "active" || statusValue === "disconnected" || statusValue === "invalid"
    ? statusValue
    : "invalid";
  const bootstrapConsumed = values["bootstrapConsumed"] === true || values["bootstrap-consumed"] === true;
  const configurationValues = asRecord(values["configuration"]);
  const configuration = status !== "disconnected" && source !== null && configurationValues !== null
    ? await readConfiguration(configurationValues, source)
    : null;
  const resolvedStatus: GitHubAppStatus = status === "active" && configuration === null ? "invalid" : status;

  let pending: GitHubAppPendingConfiguration | null = null;
  const pendingValue = asRecord(values["pending"]);
  const pendingSourceValue = pendingValue?.["source"];
  const pendingSource: GitHubAppSource | null = pendingSourceValue === "manifest" || pendingSourceValue === "manual" || pendingSourceValue === "legacy_environment_import"
    ? pendingSourceValue
    : source;
  if (pendingValue !== null && pendingSource !== null) {
    const pendingConfiguration = asRecord(pendingValue["configuration"]);
    const requiredOwners = Array.isArray(pendingValue["requiredOwners"])
      ? pendingValue["requiredOwners"].filter((owner): owner is string => typeof owner === "string" && owner.trim() !== "")
      : [];
    const installations = Array.isArray(pendingValue["installations"])
      ? pendingValue["installations"].flatMap((candidate): GitHubAppInstallationSummary[] => {
        const record = asRecord(candidate);
        const installationId = positiveInteger(record?.["installationId"]);
        const owner = nonEmptyString(record?.["owner"]);
        const ownerType = record?.["ownerType"];
        return installationId !== null && owner !== null && (ownerType === "Organization" || ownerType === "User")
          ? [{ installationId, owner, ownerType }]
          : [];
      })
      : [];
    if (pendingConfiguration !== null) {
      const decoded = await readConfiguration(pendingConfiguration, pendingSource);
      const createdAt = positiveInteger(pendingValue["createdAt"]) ?? row.updatedAt;
      const flowId = nonEmptyString(pendingValue["flowId"]) ?? `legacy-${String(createdAt)}`;
      if (decoded !== null) pending = { flowId, configuration: decoded, requiredOwners, installations, createdAt };
    }
  }

  const reason = nonEmptyString(values["invalidReason"]);
  return {
    status: resolvedStatus,
    source,
    bootstrapConsumed,
    configuration,
    pending,
    invalidReason: reason ?? (resolvedStatus === "invalid" ? "The stored GitHub App credentials could not be decrypted" : null),
    updatedAt: row.updatedAt,
  };
}

async function saveValues(values: JsonRecord): Promise<void> {
  await db.insert(adminSettings)
    .values({ id: GITHUB_APP_SETTINGS_ID, values, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: adminSettings.id, set: { values, updatedAt: Date.now() } });
}

async function encodeConfiguration(configuration: GitHubAppConfiguration): Promise<MutableConfiguration> {
  return {
    ...configuration,
    privateKey: await encryptSecret(configuration.privateKey, { force: true }),
    webhookSecret: configuration.webhookSecret === null ? null : await encryptSecret(configuration.webhookSecret, { force: true }),
    clientSecret: configuration.clientSecret === null ? null : await encryptSecret(configuration.clientSecret, { force: true }),
  };
}

export async function getGitHubAppRecord(): Promise<GitHubAppRecord | null> {
  return loadRecord();
}

/** Return the active persisted configuration, or legacy environment values only
 * when the singleton row has never existed. */
export async function getGitHubAppConfiguration(): Promise<GitHubAppConfiguration | null> {
  const record = await loadRecord();
  if (record !== null) return record.status === "active" ? record.configuration : null;
  return legacyEnvironmentConfiguration(false);
}

/** Runtime token callers only need the App ID and private key.  Keep the
 * historical webhook/token behavior working for deployments that never set a
 * slug; the setup UI still requires a real slug through the stricter resolver
 * above. */
export async function getGitHubAppRuntimeConfiguration(): Promise<GitHubAppConfiguration | null> {
  const record = await loadRecord();
  if (record !== null) return record.status === "active" ? record.configuration : null;
  return legacyEnvironmentConfiguration(false, false);
}

/** Resolve the host identity independently from credentials.  A webhook must
 * still be able to create an errored run when an environment-backed key is
 * missing, while a deliberate disconnect or invalid persisted configuration
 * must stop the old environment fallback from matching deliveries. */
export async function getGitHubAppApiUrl(): Promise<string | null> {
  const record = await loadRecord();
  if (record !== null) return record.status === "active" ? record.configuration?.apiUrl ?? null : null;
  return safeHttpUrl(integrationSetting("GITHUB_APP_API_URL"), "https://api.github.com");
}

/** Same as getGitHubAppConfiguration, but does not fall back to environment.
 * Runtime token and webhook paths use this to honour a deliberate disconnect. */
export async function getPersistedGitHubAppConfiguration(): Promise<GitHubAppConfiguration | null> {
  const record = await loadRecord();
  return record?.status === "active" ? record.configuration : null;
}

export async function getGitHubWebhookSecret(): Promise<string | null> {
  const record = await loadRecord();
  if (record !== null) return record.status === "active" ? record.configuration?.webhookSecret ?? null : null;
  return nonEmptyString(process.env["GITHUB_WEBHOOK_SECRET"]);
}

export function legacyEnvironmentConfiguration(requireWebhookSecret: boolean, requireSlug = true): GitHubAppConfiguration | null {
  const appIdText = nonEmptyString(process.env["GITHUB_APP_ID"]);
  const appId = positiveInteger(appIdText);
  const slug = appSlug(process.env["GITHUB_APP_SLUG"]);
  const privateKey = nonEmptyString(process.env["GITHUB_APP_PRIVATE_KEY"]?.replaceAll("\\n", "\n"));
  const webhookSecret = nonEmptyString(process.env["GITHUB_WEBHOOK_SECRET"]);
  const apiUrl = safeHttpUrl(integrationSetting("GITHUB_APP_API_URL"), "https://api.github.com");
  const httpUrl = safeHttpUrl(integrationSetting("GITHUB_APP_HTTP_URL"), "https://github.com");
  if (appId === null || appIdText === null || (requireSlug && slug === null) || privateKey === null || apiUrl === null || httpUrl === null) return null;
  if (requireWebhookSecret && webhookSecret === null) return null;
  return {
    appId,
    appIdText,
    slug: slug ?? "legacy-app",
    name: null,
    owner: null,
    privateKey,
    webhookSecret,
    clientId: null,
    clientSecret: null,
    apiUrl,
    httpUrl,
    source: "legacy_environment_import",
  };
}

export async function persistGitHubAppConfiguration(configuration: GitHubAppConfiguration, bootstrapConsumed = true): Promise<void> {
  const stored = await encodeConfiguration(configuration);
  await saveValues({
    version: GITHUB_APP_SETTINGS_VERSION,
    status: "active",
    source: configuration.source,
    bootstrapConsumed,
    configuration: storedConfiguration(stored),
    updatedAt: Date.now(),
  });
}

export async function persistPendingGitHubAppConfiguration(
  configuration: GitHubAppConfiguration,
  requiredOwners: readonly string[],
  installations: readonly GitHubAppInstallationSummary[],
  flowId: string = crypto.randomUUID(),
): Promise<void> {
  const existing = await loadRecord();
  const stored = await encodeConfiguration(configuration);
  const pending = {
    configuration: storedConfiguration(stored),
    source: configuration.source,
    flowId,
    requiredOwners: [...new Set(requiredOwners)].sort(),
    installations: installations.map((installation): GitHubAppInstallationSummary => ({ ...installation })),
    createdAt: Date.now(),
  };
  await saveValues({
    version: GITHUB_APP_SETTINGS_VERSION,
    status: existing?.status === "active" ? "active" : "disconnected",
    source: existing?.source ?? configuration.source,
    bootstrapConsumed: existing?.bootstrapConsumed ?? true,
    ...(existing?.configuration === null || existing?.configuration === undefined ? {} : { configuration: await encodeConfiguration(existing.configuration).then(storedConfiguration) }),
    pending,
    updatedAt: Date.now(),
  });
}

export async function activatePendingGitHubAppConfiguration(): Promise<GitHubAppPendingConfiguration | null> {
  const existing = await loadRecord();
  if (existing?.pending === null || existing?.pending === undefined) return null;
  await persistGitHubAppConfiguration(existing.pending.configuration, true);
  return existing.pending;
}

export async function disconnectGitHubApp(): Promise<void> {
  const existing = await loadRecord();
  await saveValues({
    version: GITHUB_APP_SETTINGS_VERSION,
    status: "disconnected",
    source: existing?.source ?? null,
    bootstrapConsumed: true,
    updatedAt: Date.now(),
  });
}

export async function markGitHubAppInvalid(reason: string): Promise<void> {
  const existing = await loadRecord();
  if (existing === null) return;
  const values: Record<string, unknown> = {
    version: GITHUB_APP_SETTINGS_VERSION,
    status: "invalid",
    source: existing.source,
    bootstrapConsumed: existing.bootstrapConsumed,
    invalidReason: reason.slice(0, 500),
    updatedAt: Date.now(),
  };
  if (existing.configuration !== null) values["configuration"] = await encodeConfiguration(existing.configuration).then(storedConfiguration);
  if (existing.pending !== null) {
    const encoded = await encodeConfiguration(existing.pending.configuration);
    values["pending"] = {
      configuration: storedConfiguration(encoded),
      source: existing.pending.configuration.source,
      flowId: existing.pending.flowId,
      requiredOwners: [...existing.pending.requiredOwners],
      installations: [...existing.pending.installations],
      createdAt: existing.pending.createdAt,
    };
  }
  await saveValues(values);
}

export async function validateGitHubAppConfiguration(configuration: GitHubAppConfiguration): Promise<Readonly<{ ok: boolean; status: number | null; detail: string; credentialError: boolean; appId?: number; slug?: string; name?: string | null; owner?: string | null }>> {
  let token: string;
  try {
    token = jwt.sign({
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + (9 * 60),
      iss: configuration.appIdText,
    }, configuration.privateKey, { algorithm: "RS256" });
  } catch {
    return { ok: false, status: null, detail: "The GitHub App private key is invalid", credentialError: true };
  }
  const controller = new AbortController();
  const timer = setTimeout((): void => { controller.abort(); }, 10_000);
  try {
    const response = await fetch(`${configuration.apiUrl.replace(/\/$/u, "")}/app`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Terrence",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch((): unknown => ({}));
    if (!response.ok) return {
      ok: false,
      status: response.status,
      detail: `GitHub returned HTTP ${response.status}`,
      credentialError: response.status >= 400 && response.status < 500,
    };
    const record = asRecord(body);
    const returnedId = positiveInteger(record?.["id"]);
    const returnedSlug = nonEmptyString(record?.["slug"]);
    const returnedName = nonEmptyString(record?.["name"]);
    if (returnedId !== configuration.appId || (returnedSlug !== null && returnedSlug !== configuration.slug)) {
      return { ok: false, status: 502, detail: "GitHub returned an App that does not match the configured credentials", credentialError: true };
    }
    const ownerValue = asRecord(record?.["owner"]);
    const owner = nonEmptyString(ownerValue?.["login"] ?? ownerValue?.["name"]);
    return { ok: true, status: response.status, detail: "GitHub App credentials are valid", appId: returnedId, slug: returnedSlug ?? configuration.slug, name: returnedName, owner, credentialError: false };
  } catch {
    return { ok: false, status: null, detail: "GitHub App validation could not reach GitHub", credentialError: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Import the complete legacy environment configuration once, after proving
 * the private key belongs to the claimed App with GET /app. */
export async function importLegacyGitHubAppConfiguration(): Promise<Readonly<{ imported: boolean; reason?: string }>> {
  const existing = await loadRecord();
  if (existing !== null) return { imported: false, reason: "bootstrap-consumed" };
  const configuration = legacyEnvironmentConfiguration(true);
  if (configuration === null) return { imported: false, reason: "legacy-environment-incomplete" };
  const validation = await validateGitHubAppConfiguration(configuration);
  if (!validation.ok) return { imported: false, reason: validation.detail };
  const authoritative: GitHubAppConfiguration = {
    ...configuration,
    appId: validation.appId ?? configuration.appId,
    appIdText: String(validation.appId ?? configuration.appId),
    slug: validation.slug ?? configuration.slug,
    name: validation.name ?? configuration.name,
    owner: validation.owner ?? configuration.owner,
    source: "legacy_environment_import",
  };
  await persistGitHubAppConfiguration(authoritative, true);
  return { imported: true };
}

/** Explicit site-admin recovery is the only path that can retry an import
 * after disconnecting or invalidating an environment-backed App. */
export async function recoverLegacyGitHubAppConfiguration(): Promise<Readonly<{ imported: boolean; reason?: string }>> {
  const configuration = legacyEnvironmentConfiguration(true);
  if (configuration === null) return { imported: false, reason: "legacy-environment-incomplete" };
  const validation = await validateGitHubAppConfiguration(configuration);
  if (!validation.ok) return { imported: false, reason: validation.detail };
  await persistGitHubAppConfiguration({
    ...configuration,
    appId: validation.appId ?? configuration.appId,
    appIdText: String(validation.appId ?? configuration.appId),
    slug: validation.slug ?? configuration.slug,
    name: validation.name ?? configuration.name,
    owner: validation.owner ?? configuration.owner,
    source: "legacy_environment_import",
  }, true);
  return { imported: true };
}
