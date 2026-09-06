import { createHash, createHmac } from "node:crypto";

export type CredentialDoctorProvider = "aws" | "azure" | "gcp" | "vault";
export type CredentialDoctorCheckName = "token_issuance" | "trust" | "network_reachability" | "provider_access";
export type CredentialDoctorCheckStatus = "passed" | "warning" | "failed" | "skipped";

export type CredentialDoctorConfiguration = Readonly<{
  provider: CredentialDoctorProvider;
  values: Readonly<Record<string, unknown>>;
}>;

export type CredentialDoctorToken = Readonly<{
  token: string;
  claims: Readonly<Record<string, unknown>>;
}>;

export type CredentialDoctorRequest = Readonly<{
  method: "GET" | "HEAD" | "POST";
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>;

export type CredentialDoctorRequester = (request: CredentialDoctorRequest) => Promise<Response>;

type DoctorResponse = Readonly<{
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  body: Readonly<{ cancel: () => Promise<void> }> | null;
}>;

export type CredentialDoctorCheck = Readonly<{
  name: CredentialDoctorCheckName;
  status: CredentialDoctorCheckStatus;
  code: string;
  guidance: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export type CredentialDoctorResult = Readonly<{
  status: "passed" | "warning" | "failed";
  checks: readonly CredentialDoctorCheck[];
  identity: Readonly<Record<string, unknown>> | null;
}>;

export const CREDENTIAL_DOCTOR_ENDPOINTS = {
  aws: "https://sts.amazonaws.com/",
  azureLogin: "https://login.microsoftonline.com",
  azureManagement: "https://management.azure.com",
  gcpSts: "https://sts.googleapis.com/v1/token",
  gcpResourceManager: "https://cloudresourcemanager.googleapis.com/v1/projects?pageSize=1",
} as const;

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const NETWORK_TIMEOUT_GUIDANCE = "Check DNS resolution and outbound connectivity from the selected worker or agent.";

const GUIDANCE: Readonly<Record<string, string>> = {
  issued: "The Terrence workload token was issued for this doctor run.",
  expired_credentials: "The provider rejected the short-lived credential as expired. Check clock skew and token lifetime on the selected worker or agent.",
  missing_trust: "The provider does not trust this issuer, audience, or subject. Compare the provider trust policy with the claims shown above.",
  trust_match: "The token claims match the configured audience and subject expectation.",
  trust_expectation_unconfigured: "No subject expectation is configured for this OIDC configuration; provider-side trust still needs to be verified.",
  reachable: "The provider endpoint returned an HTTP response from the selected worker or agent.",
  dns_failure: NETWORK_TIMEOUT_GUIDANCE,
  tls_trust_failure: "The selected worker or agent cannot establish a trusted TLS connection. Install the provider CA chain or correct the endpoint certificate.",
  network_timeout: NETWORK_TIMEOUT_GUIDANCE,
  blocked_destination: "The provider endpoint is outside the configured outbound network policy. Add the exact provider host or CIDR to the operator allowlist.",
  invalid_endpoint: "The provider endpoint configuration is invalid. Use the documented HTTPS endpoint without embedded credentials.",
  provider_identity: "The provider returned a harmless identity/read result. This does not prove authorization for every later resource operation.",
  provider_permission_denied: "The identity call reached the provider, but the configured identity lacks permission for this harmless read.",
  provider_error: "The provider returned an unexpected response. Inspect the provider-side audit log and trust policy.",
  provider_unavailable: "The provider returned a server error. Retry from the selected worker or agent and inspect provider availability.",
};

function valueAsString(values: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function safeVisibleString(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string" || value.length > maxLength) return null;
  // Provider response fields are expected to be identifiers. Do not echo a
  // bearer token or JWT-shaped value even if an upstream service misbehaves.
  if (/^Bearer\s+/i.test(value) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return null;
  return value;
}

export function providerForOidcConfigType(configType: string): CredentialDoctorProvider | undefined {
  switch (configType) {
    case "aws-oidc-configurations": return "aws";
    case "azure-oidc-configurations": return "azure";
    case "gcp-oidc-configurations": return "gcp";
    case "vault-oidc-configurations": return "vault";
    default: return undefined;
  }
}

/** The audience used by the run environment for a provider configuration. */
export function credentialDoctorAudience(provider: CredentialDoctorProvider, values: Readonly<Record<string, unknown>>): string {
  const configured = valueAsString(values, "audience");
  if (configured !== undefined) return configured;
  if (provider === "gcp") {
    const providerId = valueAsString(values, "workload-identity-provider-id", "workload-provider-name");
    if (providerId !== undefined) return providerId;
  }
  return `${provider}.workload.identity`;
}

/**
 * Return the one endpoint used for the network reachability check. Provider
 * hosts are constants; Vault is the only user-supplied endpoint and its URL
 * is validated before it reaches this function's requester.
 */
export function credentialDoctorNetworkEndpoint(
  provider: CredentialDoctorProvider,
  values: Readonly<Record<string, unknown>>,
): { url: string } | { error: string } {
  if (provider === "aws") return { url: CREDENTIAL_DOCTOR_ENDPOINTS.aws };
  if (provider === "azure") return { url: CREDENTIAL_DOCTOR_ENDPOINTS.azureLogin };
  if (provider === "gcp") return { url: CREDENTIAL_DOCTOR_ENDPOINTS.gcpSts };
  const address = valueAsString(values, "address", "url");
  if (address === undefined) return { error: "Vault address is required" };
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return { error: "Vault address is invalid" };
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username !== "" || parsed.password !== "") {
    return { error: "Vault address must be an HTTP(S) URL without embedded credentials" };
  }
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  return { url: `${base}/v1/sys/health` };
}

function check(
  name: CredentialDoctorCheckName,
  status: CredentialDoctorCheckStatus,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): CredentialDoctorCheck {
  return {
    name,
    status,
    code,
    guidance: GUIDANCE[code] ?? GUIDANCE["provider_error"] ?? "Inspect the provider-side audit log and trust policy.",
    ...(details === undefined ? {} : { details }),
  };
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeResponseDetails(response: DoctorResponse, code: string): Readonly<Record<string, unknown>> {
  return { http_status: response.status, ...(code === "reachable" ? {} : { provider_code: code }) };
}

async function responseText(response: Readonly<{ text: () => Promise<string> }>): Promise<string> {
  try {
    const text = await response.text();
    return text.length > MAX_PROVIDER_RESPONSE_BYTES ? text.slice(0, MAX_PROVIDER_RESPONSE_BYTES) : text;
  } catch {
    return "";
  }
}

function responseErrorCode(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["error", "code", "errorCode"]) {
        const value = record[key];
        // Error descriptions can echo request material. Keep only a bounded
        // provider code in the response details; never surface a provider's
        // free-form error text (which could contain a token).
        if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)) return value;
      }
      const nested = record["error"];
      if (typeof nested === "object" && nested !== null) {
        const nestedCode = (nested as Record<string, unknown>)["code"];
        if (typeof nestedCode === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(nestedCode)) return nestedCode;
      }
    }
  } catch {
    // XML and non-JSON provider responses are handled below.
  }
  const xmlCode = /<(?:Code|code)>([^<]{1,160})<\/(?:Code|code)>/.exec(body)?.[1];
  return xmlCode !== undefined && /^[A-Za-z0-9_.:-]+$/.test(xmlCode) ? xmlCode : "";
}

function networkFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (/enotfound|eai_again|getaddrinfo|dns|resolve/.test(lower)) return "dns_failure";
  if (/certificate|self signed|unable to verify|tls|ssl/.test(lower)) return "tls_trust_failure";
  if (/timeout|timed out|abort|etimedout/.test(lower)) return "network_timeout";
  if (/private or loopback|outbound network policy|blocked/.test(lower)) return "blocked_destination";
  return "provider_error";
}

function responseFailure(
  response: DoctorResponse,
  body: string,
  stage: "exchange" | "identity",
): { code: string; details: Readonly<Record<string, unknown>> } {
  const providerCode = responseErrorCode(body);
  const lower = `${providerCode} ${body.slice(0, 2_000)}`.toLowerCase();
  if (/expired|expiration|expired_token|invalid_grant/.test(lower)) {
    return { code: "expired_credentials", details: safeResponseDetails(response, providerCode || "expired") };
  }
  if (stage === "exchange" && (response.status === 400 || response.status === 401 || response.status === 403
    || /invalididentitytoken|invalid assertion|federated|subject|audience|trust|no matching/.test(lower))) {
    return { code: "missing_trust", details: safeResponseDetails(response, providerCode || "trust") };
  }
  if (response.status === 401) return { code: "provider_permission_denied", details: safeResponseDetails(response, providerCode || "unauthorized") };
  if (response.status === 403) return { code: "provider_permission_denied", details: safeResponseDetails(response, providerCode || "forbidden") };
  if (response.status >= 500) return { code: "provider_unavailable", details: safeResponseDetails(response, providerCode || "server_error") };
  return { code: "provider_error", details: safeResponseDetails(response, providerCode || "unexpected_response") };
}

async function networkCheck(
  endpoint: Readonly<{ url: string }> | Readonly<{ error: string }>,
  requester: CredentialDoctorRequester,
): Promise<CredentialDoctorCheck> {
  if ("error" in endpoint) return check("network_reachability", "failed", "invalid_endpoint");
  try {
    const response = await requester({ method: "HEAD", url: endpoint.url, headers: { accept: "*/*" } });
    await response.body?.cancel();
    return check("network_reachability", "passed", "reachable", { http_status: response.status });
  } catch (error: unknown) {
    const code = networkFailureCode(error);
    return check("network_reachability", "failed", code);
  }
}

function formBody(values: Readonly<Record<string, string>>): string {
  return new URLSearchParams(values).toString();
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- crypto accepts a binary key object.
function hexHmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsAuthorization(
  accessKey: string,
  secretKey: string,
  sessionToken: string,
  body: string,
  now: Readonly<Date>,
): Readonly<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const date = amzDate.slice(0, 8);
  const host = "sts.amazonaws.com";
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const canonicalHeaders = `content-type:application/x-www-form-urlencoded\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\nx-amz-security-token:${sessionToken}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/us-east-1/sts/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signingKey = hexHmac(hexHmac(hexHmac(hexHmac(`AWS4${secretKey}`, date), "us-east-1"), "sts"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "content-type": "application/x-www-form-urlencoded",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-security-token": sessionToken,
  };
}

function xmlValue(body: string, name: string): string | undefined {
  const value = new RegExp(`<${name}>([^<]{1,4096})</${name}>`).exec(body)?.[1];
  const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value?.replace(/&(amp|lt|gt|quot|apos);/g, (match: string, entity: string): string => entities[entity] ?? match);
}

async function awsAccess(
  configuration: CredentialDoctorConfiguration,
  token: CredentialDoctorToken,
  requester: CredentialDoctorRequester,
): Promise<{ check: CredentialDoctorCheck; identity: Readonly<Record<string, unknown>> | null }> {
  const roleArn = valueAsString(configuration.values, "role-arn");
  if (roleArn === undefined) return { check: check("provider_access", "failed", "missing_trust"), identity: null };
  const exchangeBody = formBody({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: "terrence-credential-doctor",
    WebIdentityToken: token.token,
  });
  let exchange: Response;
  try {
    exchange = await requester({
      method: "POST",
      url: CREDENTIAL_DOCTOR_ENDPOINTS.aws,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/xml" },
      body: exchangeBody,
    });
  } catch (error: unknown) {
    return { check: check("provider_access", "failed", networkFailureCode(error)), identity: null };
  }
  const exchangeText = await responseText(exchange);
  if (!exchange.ok) {
    const failure = responseFailure(exchange, exchangeText, "exchange");
    return { check: check("provider_access", "failed", failure.code, failure.details), identity: null };
  }
  const accessKey = xmlValue(exchangeText, "AccessKeyId");
  const secretKey = xmlValue(exchangeText, "SecretAccessKey");
  const sessionToken = xmlValue(exchangeText, "SessionToken");
  if (accessKey === undefined || secretKey === undefined || sessionToken === undefined) {
    return { check: check("provider_access", "failed", "provider_error", { http_status: exchange.status }), identity: null };
  }
  const identityBody = "Action=GetCallerIdentity&Version=2011-06-15";
  let identityResponse: Response;
  try {
    identityResponse = await requester({
      method: "POST",
      url: CREDENTIAL_DOCTOR_ENDPOINTS.aws,
      headers: awsAuthorization(accessKey, secretKey, sessionToken, identityBody, new Date()),
      body: identityBody,
    });
  } catch (error: unknown) {
    return { check: check("provider_access", "failed", networkFailureCode(error)), identity: null };
  }
  const identityText = await responseText(identityResponse);
  if (!identityResponse.ok) {
    const failure = responseFailure(identityResponse, identityText, "identity");
    return { check: check("provider_access", "failed", failure.code, failure.details), identity: null };
  }
  return {
    check: check("provider_access", "passed", "provider_identity", { http_status: identityResponse.status }),
    identity: {
      account: safeVisibleString(xmlValue(identityText, "Account")),
      arn: safeVisibleString(xmlValue(identityText, "Arn")),
      user_id: safeVisibleString(xmlValue(identityText, "UserId")),
    },
  };
}

function jsonRecord(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function azureAccess(
  configuration: CredentialDoctorConfiguration,
  token: CredentialDoctorToken,
  requester: CredentialDoctorRequester,
): Promise<{ check: CredentialDoctorCheck; identity: Readonly<Record<string, unknown>> | null }> {
  const tenantId = valueAsString(configuration.values, "tenant-id");
  const clientId = valueAsString(configuration.values, "client-id", "identity");
  const subscriptionId = valueAsString(configuration.values, "subscription-id");
  if (tenantId === undefined || clientId === undefined || subscriptionId === undefined) {
    return { check: check("provider_access", "failed", "missing_trust"), identity: null };
  }
  const tokenUrl = `${CREDENTIAL_DOCTOR_ENDPOINTS.azureLogin}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = formBody({
    client_id: clientId,
    scope: "https://management.azure.com/.default",
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: token.token,
  });
  let exchange: Response;
  try {
    exchange = await requester({ method: "POST", url: tokenUrl, headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  } catch (error: unknown) {
    return { check: check("provider_access", "failed", networkFailureCode(error)), identity: null };
  }
  const exchangeText = await responseText(exchange);
  if (!exchange.ok) {
    const failure = responseFailure(exchange, exchangeText, "exchange");
    return { check: check("provider_access", "failed", failure.code, failure.details), identity: null };
  }
  const exchangeJson = jsonRecord(exchangeText);
  const accessToken = typeof exchangeJson?.["access_token"] === "string" ? exchangeJson["access_token"] : undefined;
  if (accessToken === undefined || accessToken === "") return { check: check("provider_access", "failed", "provider_error", { http_status: exchange.status }), identity: null };
  const identityUrl = `${CREDENTIAL_DOCTOR_ENDPOINTS.azureManagement}/subscriptions/${encodeURIComponent(subscriptionId)}?api-version=2020-01-01`;
  let identityResponse: Response;
  try {
    identityResponse = await requester({ method: "GET", url: identityUrl, headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  } catch (error: unknown) {
    return { check: check("provider_access", "failed", networkFailureCode(error)), identity: null };
  }
  const identityText = await responseText(identityResponse);
  if (!identityResponse.ok) {
    const failure = responseFailure(identityResponse, identityText, "identity");
    return { check: check("provider_access", "failed", failure.code, failure.details), identity: null };
  }
  const identityJson = jsonRecord(identityText);
  return {
    check: check("provider_access", "passed", "provider_identity", { http_status: identityResponse.status }),
    identity: {
      subscription_id: safeVisibleString(identityJson?.["subscriptionId"]) ?? safeVisibleString(subscriptionId),
      tenant_id: safeVisibleString(identityJson?.["tenantId"]),
      display_name: safeVisibleString(identityJson?.["displayName"]),
      state: safeVisibleString(identityJson?.["state"]),
    },
  };
}

async function gcpAccess(
  configuration: CredentialDoctorConfiguration,
  token: CredentialDoctorToken,
  requester: CredentialDoctorRequester,
): Promise<{ check: CredentialDoctorCheck; identity: Readonly<Record<string, unknown>> | null }> {
  const providerId = valueAsString(configuration.values, "workload-identity-provider-id", "workload-provider-name", "provider");
  if (providerId === undefined) return { check: check("provider_access", "failed", "missing_trust"), identity: null };
  const exchangeBody = formBody({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: providerId,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: token.token,
  });
  let exchange: Response;
  try {
    exchange = await requester({ method: "POST", url: CREDENTIAL_DOCTOR_ENDPOINTS.gcpSts, headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: exchangeBody });
  } catch (error: unknown) {
    return { check: check("provider_access", "failed", networkFailureCode(error)), identity: null };
  }
  const exchangeText = await responseText(exchange);
  if (!exchange.ok) {
    const failure = responseFailure(exchange, exchangeText, "exchange");
    return { check: check("provider_access", "failed", failure.code, failure.details), identity: null };
  }
  const exchangeJson = jsonRecord(exchangeText);
  const accessToken = typeof exchangeJson?.["access_token"] === "string" ? exchangeJson["access_token"] : undefined;
  if (accessToken === undefined || accessToken === "") return { check: check("provider_access", "failed", "provider_error", { http_status: exchange.status }), identity: null };
  let identityResponse: Response;
  try {
    identityResponse = await requester({ method: "GET", url: CREDENTIAL_DOCTOR_ENDPOINTS.gcpResourceManager, headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  } catch (error: unknown) {
    return { check: check("provider_access", "failed", networkFailureCode(error)), identity: null };
  }
  const identityText = await responseText(identityResponse);
  if (!identityResponse.ok) {
    const failure = responseFailure(identityResponse, identityText, "identity");
    return { check: check("provider_access", "failed", failure.code, failure.details), identity: null };
  }
  const identityJson = jsonRecord(identityText);
  const firstProject = Array.isArray(identityJson?.["projects"]) && typeof identityJson["projects"][0] === "object" && identityJson["projects"][0] !== null
    ? identityJson["projects"][0] as Record<string, unknown>
    : undefined;
  return {
    check: check("provider_access", "passed", "provider_identity", { http_status: identityResponse.status }),
    identity: {
      project_id: safeVisibleString(firstProject?.["projectId"]),
      project_name: safeVisibleString(firstProject?.["name"]),
      project_number: safeVisibleString(firstProject?.["projectNumber"]),
    },
  };
}

async function vaultAccess(
  configuration: CredentialDoctorConfiguration,
  token: CredentialDoctorToken,
  requester: CredentialDoctorRequester,
): Promise<{ check: CredentialDoctorCheck; identity: Readonly<Record<string, unknown>> | null }> {
  const endpoint = credentialDoctorNetworkEndpoint("vault", configuration.values);
  if ("error" in endpoint) return { check: check("provider_access", "failed", "invalid_endpoint"), identity: null };
  const healthUrl = endpoint.url.slice(0, -"/v1/sys/health".length);
  const authPath = valueAsString(configuration.values, "auth-path") ?? "jwt";
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(authPath)) return { check: check("provider_access", "failed", "invalid_endpoint"), identity: null };
  const role = valueAsString(configuration.values, "role-name", "role");
  if (role === undefined) return { check: check("provider_access", "failed", "missing_trust"), identity: null };
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const namespace = valueAsString(configuration.values, "namespace");
  if (namespace !== undefined) headers["x-vault-namespace"] = namespace;
  let login: Response;
  try {
    login = await requester({ method: "POST", url: `${healthUrl}/v1/auth/${authPath}/login`, headers, body: JSON.stringify({ role, jwt: token.token }) });
  } catch (error: unknown) {
    return { check: check("provider_access", "failed", networkFailureCode(error)), identity: null };
  }
  const loginText = await responseText(login);
  if (!login.ok) {
    const failure = responseFailure(login, loginText, "exchange");
    return { check: check("provider_access", "failed", failure.code, failure.details), identity: null };
  }
  const loginJson = jsonRecord(loginText);
  const auth = typeof loginJson?.["auth"] === "object" && loginJson["auth"] !== null ? loginJson["auth"] as Record<string, unknown> : null;
  const clientToken = typeof auth?.["client_token"] === "string" ? auth["client_token"] : undefined;
  if (clientToken === undefined || clientToken === "") return { check: check("provider_access", "failed", "provider_error", { http_status: login.status }), identity: null };
  const lookupHeaders: Record<string, string> = { "x-vault-token": clientToken, accept: "application/json" };
  if (namespace !== undefined) lookupHeaders["x-vault-namespace"] = namespace;
  let lookup: Response;
  try {
    lookup = await requester({ method: "GET", url: `${healthUrl}/v1/auth/token/lookup-self`, headers: lookupHeaders });
  } catch (error: unknown) {
    return { check: check("provider_access", "failed", networkFailureCode(error)), identity: null };
  }
  const lookupText = await responseText(lookup);
  if (!lookup.ok) {
    const failure = responseFailure(lookup, lookupText, "identity");
    return { check: check("provider_access", "failed", failure.code, failure.details), identity: null };
  }
  const lookupJson = jsonRecord(lookupText);
  const data = typeof lookupJson?.["data"] === "object" && lookupJson["data"] !== null ? lookupJson["data"] as Record<string, unknown> : null;
  const policies = Array.isArray(data?.["policies"])
    ? data["policies"].map((value): string | null => safeVisibleString(value, 160)).filter((value): value is string => value !== null).slice(0, 32)
    : [];
  return {
    check: check("provider_access", "passed", "provider_identity", { http_status: lookup.status }),
    identity: {
      display_name: safeVisibleString(data?.["display_name"]),
      token_type: safeVisibleString(data?.["token_type"], 160),
      policies,
    },
  };
}

async function providerAccess(
  configuration: CredentialDoctorConfiguration,
  token: CredentialDoctorToken,
  requester: CredentialDoctorRequester,
): Promise<{ check: CredentialDoctorCheck; identity: Readonly<Record<string, unknown>> | null }> {
  switch (configuration.provider) {
    case "aws": return awsAccess(configuration, token, requester);
    case "azure": return azureAccess(configuration, token, requester);
    case "gcp": return gcpAccess(configuration, token, requester);
    case "vault": return vaultAccess(configuration, token, requester);
  }
}

function trustCheck(
  configuration: CredentialDoctorConfiguration,
  token: CredentialDoctorToken,
): CredentialDoctorCheck {
  const expectedAudience = credentialDoctorAudience(configuration.provider, configuration.values);
  const audience = token.claims["aud"];
  if (audience !== expectedAudience) return check("trust", "failed", "missing_trust", { expected_audience: expectedAudience, actual_audience: typeof audience === "string" ? audience : null });
  const expiresAt = safeNumber(token.claims["exp"]);
  if (expiresAt === undefined || expiresAt <= Math.floor(Date.now() / 1000)) return check("trust", "failed", "expired_credentials");
  const expectedSubject = valueAsString(configuration.values, "expected-subject", "subject");
  const subject = token.claims["sub"];
  if (expectedSubject !== undefined && subject !== expectedSubject) return check("trust", "failed", "missing_trust", { expected_subject: expectedSubject, actual_subject: typeof subject === "string" ? subject : null });
  if (expectedSubject === undefined) return check("trust", "warning", "trust_expectation_unconfigured", { audience: expectedAudience, subject: typeof subject === "string" ? subject : null });
  return check("trust", "passed", "trust_match", { audience: expectedAudience, subject: expectedSubject });
}

function overallStatus(checks: readonly CredentialDoctorCheck[]): "passed" | "warning" | "failed" {
  if (checks.some((item): boolean => item.status === "failed")) return "failed";
  if (checks.some((item): boolean => item.status === "warning")) return "warning";
  return "passed";
}

/** Run all safe, provider-specific checks for one ephemeral doctor token. */
export async function runCredentialDoctor(
  configuration: CredentialDoctorConfiguration,
  token: CredentialDoctorToken,
  requester: CredentialDoctorRequester,
): Promise<CredentialDoctorResult> {
  const tokenCheck = check("token_issuance", "passed", "issued", {
    audience: typeof token.claims["aud"] === "string" ? token.claims["aud"] : null,
    subject: typeof token.claims["sub"] === "string" ? token.claims["sub"] : null,
    issued_at: token.claims["iat"] ?? null,
    expires_at: token.claims["exp"] ?? null,
  });
  const trust = trustCheck(configuration, token);
  const network = await networkCheck(credentialDoctorNetworkEndpoint(configuration.provider, configuration.values), requester);
  if (network.status === "failed") {
    return {
      status: overallStatus([tokenCheck, trust, network]),
      checks: [tokenCheck, trust, network, check("provider_access", "skipped", network.code)],
      identity: null,
    };
  }
  const access = await providerAccess(configuration, token, requester);
  return {
    status: overallStatus([tokenCheck, trust, network, access.check]),
    checks: [tokenCheck, trust, network, access.check],
    identity: access.identity,
  };
}
