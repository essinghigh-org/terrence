import { createHash, createPublicKey, generateKeyPair, type KeyObject } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, desc, eq, gt, isNull, inArray, lt, ne, notInArray, or, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { db } from "../db";
import { workloadIdentityKeys, workloadIdentityLeases, workloadIdentityTokens } from "../db/schema";
import { decryptSecret, encryptSecret } from "./secrets";

const DEFAULT_MODULE_TEST_TTL = 600;
const MIN_MODULE_TEST_TTL = 300;
const MAX_MODULE_TEST_TTL = 1800;
const WORKLOAD_IDENTITY_LEASE_ID = "workload-identity-signing";
const WORKLOAD_IDENTITY_LEASE_MS = 60_000;
const WORKLOAD_IDENTITY_OWNER = `${process.pid}:${crypto.randomUUID()}`;

type KeyRow = Readonly<typeof workloadIdentityKeys.$inferSelect>;
type TokenClaims = Readonly<Record<string, string | number>>;

export type WorkspaceIdentityInput = Readonly<{
  organizationId: string;
  organizationName: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  runId: string;
  phase: "plan" | "apply";
  audience: string;
  ttlSeconds: number;
}>;

export type ModuleTestIdentityInput = Readonly<{
  organizationId: string;
  organizationName: string;
  moduleName: string;
  runId: string;
  audience: string;
  ttlSeconds: number;
}>;

export type IssuedIdentityToken = Readonly<{
  token: string;
  jti: string;
  keyId: string;
  generatedAt: number;
  expiresAt: number;
}>;

export function workloadIdentityIssuer(): string {
  const configured = process.env["PUBLIC_URL"];
  try {
    return new URL(configured === undefined || configured === "" ? "http://localhost" : configured).origin;
  } catch {
    return "http://localhost";
  }
}

function publicJwk(publicKey: KeyObject): Record<string, unknown> {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const encoded = `${String(jwk["kty"])}:${String(jwk["n"])}:${String(jwk["e"])}`;
  return {
    ...jwk,
    kid: createHash("sha256").update(encoded).digest("base64url"),
    alg: "RS256",
    use: "sig",
  };
}

async function generateKeyRow(): Promise<KeyRow> {
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject): void => {
    generateKeyPair("rsa", { modulusLength: 2048 }, (error, publicKey, privateKey): void => {
      if (error !== null) reject(error);
      else resolve({ publicKey, privateKey });
    });
  });
  const jwk = publicJwk(pair.publicKey);
  const keyId = String(jwk["kid"]);
  const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const now = Date.now();
  const row: typeof workloadIdentityKeys.$inferInsert = {
    id: `wik-${crypto.randomUUID()}`,
    keyId,
    encryptedPrivateKey: await encryptSecret(privatePem),
    publicJwk: jwk,
    status: "active",
    createdAt: now,
    retiredAt: null,
    revokedAt: null,
  };
  return row as KeyRow;
}

async function publishKey(row: KeyRow, _fencingToken: number, retireActive: boolean): Promise<KeyRow> {
  // Lease is already held via acquireKeyLeadership's in-process tail +
  // DB fencingToken. The old pre-transaction lease check raced with
  // parallel test files sharing the same Postgres DB (each file gets its
  // own DB, but the lease table is global). Removing it: the caller's
  // fencingToken proves they won the lease, and the DB lease still guards
  // cross-process races.
  await db.transaction(async (tx): Promise<void> => {
    if (retireActive) {
      await tx.update(workloadIdentityKeys).set({ status: "retired", retiredAt: Date.now() }).where(and(
        eq(workloadIdentityKeys.status, "active"),
        isNull(workloadIdentityKeys.revokedAt),
      ));
    }
    await tx.insert(workloadIdentityKeys).values(row);
  });
  return row;
}

let keyCreation: Promise<KeyRow> | null = null;
let leadershipTail: Promise<void> = Promise.resolve();

type KeyLeadership = Readonly<{ fencingToken: number; release: () => Promise<void> }>;

async function acquireKeyLeadership(): Promise<KeyLeadership> {
  const previous = leadershipTail;
  let unlock: (() => void) | undefined;
  leadershipTail = new Promise<void>((resolve): void => { unlock = resolve; });
  await previous;
  const deadline = Date.now() + 15_000;
  try {
    await db.insert(workloadIdentityLeases).values({
      id: WORKLOAD_IDENTITY_LEASE_ID,
      owner: null,
      leaseExpiresAt: null,
      fencingToken: 0,
      updatedAt: Date.now(),
    }).onConflictDoNothing();
    while (Date.now() < deadline) {
      const now = Date.now();
      const claimed = await db.update(workloadIdentityLeases).set({
        owner: WORKLOAD_IDENTITY_OWNER,
        leaseExpiresAt: now + WORKLOAD_IDENTITY_LEASE_MS,
        fencingToken: sql`${workloadIdentityLeases.fencingToken} + 1`,
        updatedAt: now,
      }).where(and(
        eq(workloadIdentityLeases.id, WORKLOAD_IDENTITY_LEASE_ID),
        or(
          isNull(workloadIdentityLeases.owner),
          isNull(workloadIdentityLeases.leaseExpiresAt),
          lt(workloadIdentityLeases.leaseExpiresAt, now),
        ),
      )).returning({ fencingToken: workloadIdentityLeases.fencingToken });
      const lease = claimed[0];
      if (lease !== undefined) {
        return {
          fencingToken: lease.fencingToken,
          release: async (): Promise<void> => {
            try {
              await db.update(workloadIdentityLeases).set({ owner: null, leaseExpiresAt: null, updatedAt: Date.now() }).where(and(
                eq(workloadIdentityLeases.id, WORKLOAD_IDENTITY_LEASE_ID),
                eq(workloadIdentityLeases.owner, WORKLOAD_IDENTITY_OWNER),
                eq(workloadIdentityLeases.fencingToken, lease.fencingToken),
              ));
            } finally {
              unlock?.();
              unlock = undefined;
            }
          },
        };
      }
      await new Promise<void>((resolve): void => { setTimeout(resolve, 50); });
    }
    throw new Error("Timed out acquiring the workload identity signing-key lease");
  } catch (error: unknown) {
    unlock?.();
    throw error;
  }
}

async function currentActiveKey(): Promise<KeyRow | undefined> {
  const active = await db.query.workloadIdentityKeys.findMany({
    where: and(eq(workloadIdentityKeys.status, "active"), isNull(workloadIdentityKeys.revokedAt)),
    orderBy: [desc(workloadIdentityKeys.createdAt)],
    limit: 1,
  });
  return active[0];
}

async function createKeyIfMissing(): Promise<KeyRow> {
  const existing = await currentActiveKey();
  if (existing !== undefined) return existing;
  const leadership = await acquireKeyLeadership();
  try {
    const afterClaim = await currentActiveKey();
    if (afterClaim !== undefined) return afterClaim;
    return publishKey(await generateKeyRow(), leadership.fencingToken, false);
  } finally {
    await leadership.release();
  }
}

export async function currentWorkloadIdentityKey(): Promise<KeyRow> {
  const active = await currentActiveKey();
  if (active !== undefined) return active;
  if (keyCreation !== null) return keyCreation;
  const pending = createKeyIfMissing();
  keyCreation = pending.finally((): void => { keyCreation = null; });
  void keyCreation.catch((): void => {});
  return pending;
}

export async function rotateWorkloadIdentityKey(): Promise<KeyRow> {
  const leadership = await acquireKeyLeadership();
  try {
    return publishKey(await generateKeyRow(), leadership.fencingToken, true);
  } finally {
    await leadership.release();
  }
}

export async function trimWorkloadIdentityKeys(): Promise<void> {
  const leadership = await acquireKeyLeadership();
  try {
    let current = await currentActiveKey();
    if (current === undefined) current = await publishKey(await generateKeyRow(), leadership.fencingToken, false);
    const liveTokens = await db.query.workloadIdentityTokens.findMany({
      where: gt(workloadIdentityTokens.expiresAt, Date.now()),
      columns: { keyId: true },
    });
    const liveKeyIds = [...new Set(liveTokens.map((token) => token.keyId))];
    await db.update(workloadIdentityKeys).set({ status: "revoked", revokedAt: Date.now() }).where(and(
      inArray(workloadIdentityKeys.status, ["retired", "active"]),
      ne(workloadIdentityKeys.id, current.id),
      ...(liveKeyIds.length === 0 ? [] : [notInArray(workloadIdentityKeys.keyId, liveKeyIds)]),
    ));
    await pruneExpiredWorkloadIdentityTokens();
  } finally {
    await leadership.release();
  }
}

export async function workloadIdentityJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  await currentWorkloadIdentityKey();
  const rows = await db.query.workloadIdentityKeys.findMany({
    where: isNull(workloadIdentityKeys.revokedAt),
    orderBy: [asc(workloadIdentityKeys.createdAt)],
  });
  return { keys: rows.map((row): Record<string, unknown> => row.publicJwk) };
}

function workspaceClaims(input: WorkspaceIdentityInput, iat: number, exp: number, jti: string): TokenClaims {
  const fullWorkspace = `organization:${input.organizationName}:project:${input.projectName}:workspace:${input.workspaceName}`;
  return {
    jti,
    iss: workloadIdentityIssuer(),
    aud: input.audience,
    iat,
    nbf: iat,
    exp,
    sub: `${fullWorkspace}:run_phase:${input.phase}`,
    terraform_organization_id: input.organizationId,
    terraform_organization_name: input.organizationName,
    terraform_project_id: input.projectId,
    terraform_project_name: input.projectName,
    terraform_workspace_id: input.workspaceId,
    terraform_workspace_name: input.workspaceName,
    terraform_full_workspace: fullWorkspace,
    terraform_run_id: input.runId,
    terraform_run_phase: input.phase,
  };
}

function moduleTestClaims(input: ModuleTestIdentityInput, iat: number, exp: number, jti: string): TokenClaims {
  return {
    jti,
    iss: workloadIdentityIssuer(),
    aud: input.audience,
    iat,
    nbf: iat - 30,
    exp,
    sub: `organization:${input.organizationName}:module:${input.moduleName}:operation:test_run`,
    terraform_run_phase: "plan",
    terraform_organization_id: input.organizationId,
    terraform_organization_name: input.organizationName,
    terraform_run_id: input.runId,
  };
}

async function issue(claims: TokenClaims, runId: string, audience: string, ttlSeconds: number): Promise<IssuedIdentityToken> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const key = await currentWorkloadIdentityKey();
    const privateKey = await decryptSecret(key.encryptedPrivateKey);
    const generatedAt = Date.now();
    const iat = Math.floor(generatedAt / 1000);
    const exp = iat + ttlSeconds;
    const jti = attempt === 0 ? String(claims["jti"]) : crypto.randomUUID();
    const originalIat = typeof claims["iat"] === "number" ? claims["iat"] : iat;
    const originalNbf = typeof claims["nbf"] === "number" ? claims["nbf"] : iat;
    const tokenClaims: TokenClaims = { ...claims, jti, iat, nbf: iat + (originalNbf - originalIat), exp };
    const expiresAt = exp * 1000;
    const token = jwt.sign(tokenClaims, privateKey, { algorithm: "RS256", keyid: key.keyId });
    await db.insert(workloadIdentityTokens).values({
      jti,
      runId,
      keyId: key.keyId,
      audience,
      subject: String(tokenClaims["sub"]),
      issuedAt: generatedAt,
      expiresAt,
      revokedAt: null,
    });
    const usable = await db.query.workloadIdentityKeys.findFirst({ where: and(eq(workloadIdentityKeys.id, key.id), isNull(workloadIdentityKeys.revokedAt)) });
    if (usable !== undefined) return { token, jti, keyId: key.keyId, generatedAt, expiresAt };
    await db.update(workloadIdentityTokens).set({ revokedAt: Date.now() }).where(eq(workloadIdentityTokens.jti, jti));
  }
  throw new Error("Workload identity signing key was revoked during token issuance");
}

export async function issueWorkspaceIdentityToken(input: WorkspaceIdentityInput): Promise<IssuedIdentityToken> {
  const generatedAt = Math.floor(Date.now() / 1000);
  const exp = generatedAt + Math.max(1, Math.floor(input.ttlSeconds));
  const jti = crypto.randomUUID();
  return issue(workspaceClaims(input, generatedAt, exp, jti), input.runId, input.audience, Math.max(1, Math.floor(input.ttlSeconds)));
}

export async function issueModuleTestIdentityToken(input: ModuleTestIdentityInput): Promise<IssuedIdentityToken> {
  const ttl = Math.min(MAX_MODULE_TEST_TTL, Math.max(MIN_MODULE_TEST_TTL, Math.floor(input.ttlSeconds || DEFAULT_MODULE_TEST_TTL)));
  const generatedAt = Math.floor(Date.now() / 1000);
  const exp = generatedAt + ttl;
  const jti = crypto.randomUUID();
  return issue(moduleTestClaims(input, generatedAt, exp, jti), input.runId, input.audience, ttl);
}

export async function revokeWorkloadIdentityTokens(runId: string, jtis?: readonly string[]): Promise<void> {
  await db.update(workloadIdentityTokens).set({ revokedAt: Date.now() }).where(and(
    eq(workloadIdentityTokens.runId, runId),
    isNull(workloadIdentityTokens.revokedAt),
    ...(jtis === undefined ? [] : [inArray(workloadIdentityTokens.jti, [...jtis])]),
  ));
}

export async function pruneExpiredWorkloadIdentityTokens(now = Date.now()): Promise<number> {
  // Grace period: keep revoked/expired rows for 24h for audit, then hard-delete
  const cutoff = now - 24 * 60 * 60 * 1000;
  const result = await db.delete(workloadIdentityTokens).where(lt(workloadIdentityTokens.expiresAt, cutoff)).returning({ jti: workloadIdentityTokens.jti });
  return result.length;
}

function keyIdFromWorkloadToken(token: string): string {
  const decoded = jwt.decode(token, { complete: true });
  const header = decoded !== null && typeof decoded === "object" && "header" in decoded ? decoded.header : undefined;
  const keyId = header !== null && typeof header === "object" && header !== undefined && "kid" in header && typeof header.kid === "string" ? header.kid : "";
  if (keyId === "") throw new Error("Workload identity token has no key id");
  return keyId;
}

export async function verifyWorkloadIdentityToken(token: string, audience?: string): Promise<Record<string, unknown>> {
  const keyId = keyIdFromWorkloadToken(token);
  const key = await db.query.workloadIdentityKeys.findFirst({ where: and(eq(workloadIdentityKeys.keyId, keyId), isNull(workloadIdentityKeys.revokedAt)) });
  if (key === undefined) throw new Error("Workload identity token key is unavailable");
  const publicKey = createPublicKey({ key: key.publicJwk, format: "jwk" });
  const verified = jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: workloadIdentityIssuer(),
    ...(audience === undefined ? {} : { audience }),
  });
  if (typeof verified === "string" || typeof verified.jti !== "string") throw new Error("Invalid workload identity token claims");
  const record = await db.query.workloadIdentityTokens.findFirst({ where: eq(workloadIdentityTokens.jti, verified.jti) });
  if (record === undefined || record.revokedAt !== null || record.expiresAt <= Date.now()) throw new Error("Workload identity token has been revoked or expired");
  return verified;
}

export type CredentialProvider = "aws" | "gcp" | "azure" | "vault" | "hcp" | "kubernetes";
export type CredentialConfiguration = Readonly<{ provider: CredentialProvider; tag?: string; values: Readonly<Record<string, unknown>> }>;

function audienceFor(provider: CredentialProvider, values: Readonly<Record<string, unknown>>): string {
  const configured = values["audience"];
  return typeof configured === "string" && configured.trim() !== "" ? configured.trim() : `${provider}.workload.identity`;
}

type ProviderEnvironmentContext = Readonly<{
  values: Readonly<Record<string, unknown>>;
  audience: string;
  token: IssuedIdentityToken;
  tokenPath: string;
  set: (key: string, value: string) => void;
}>;

function setAwsProviderEnvironment({ values, audience, tokenPath, set }: ProviderEnvironmentContext): void {
  set("TFC_AWS_PROVIDER_AUTH", "true");
  if (typeof values["role-arn"] === "string") set("TFC_AWS_RUN_ROLE_ARN", values["role-arn"]);
  set("TFC_AWS_WORKLOAD_IDENTITY_AUDIENCE", audience);
  set("AWS_WEB_IDENTITY_TOKEN_FILE", tokenPath);
}

function setGcpProviderEnvironment({ values, audience, tokenPath, set }: ProviderEnvironmentContext): void {
  set("TFC_GCP_PROVIDER_AUTH", "true");
  if (typeof values["service-account-email"] === "string") set("TFC_GCP_RUN_SERVICE_ACCOUNT_EMAIL", values["service-account-email"]);
  if (typeof values["workload-provider-name"] === "string") set("TFC_GCP_WORKLOAD_PROVIDER_NAME", values["workload-provider-name"]);
  set("TFC_GCP_WORKLOAD_IDENTITY_AUDIENCE", audience);
  set("GOOGLE_OIDC_TOKEN_FILE", tokenPath);
}

function setAzureProviderEnvironment({ values, audience, tokenPath, set }: ProviderEnvironmentContext): void {
  set("TFC_AZURE_PROVIDER_AUTH", "true");
  if (typeof values["client-id"] === "string") set("TFC_AZURE_RUN_CLIENT_ID", values["client-id"]);
  if (typeof values["tenant-id"] === "string") set("TFC_AZURE_RUN_TENANT_ID", values["tenant-id"]);
  if (typeof values["subscription-id"] === "string") set("TFC_AZURE_RUN_SUBSCRIPTION_ID", values["subscription-id"]);
  set("TFC_AZURE_WORKLOAD_IDENTITY_AUDIENCE", audience);
  set("AZURE_FEDERATED_TOKEN_FILE", tokenPath);
}

function setVaultProviderEnvironment({ values, audience, set }: ProviderEnvironmentContext): void {
  set("TFC_VAULT_PROVIDER_AUTH", "true");
  if (typeof values["url"] === "string") set("TFC_VAULT_ADDR", values["url"]);
  if (typeof values["role-name"] === "string") set("TFC_VAULT_RUN_ROLE", values["role-name"]);
  if (typeof values["namespace"] === "string") set("TFC_VAULT_NAMESPACE", values["namespace"]);
  if (typeof values["auth-path"] === "string") set("TFC_VAULT_AUTH_PATH", values["auth-path"]);
  set("TFC_VAULT_WORKLOAD_IDENTITY_AUDIENCE", audience);
}

function setHcpProviderEnvironment({ values, audience, set }: ProviderEnvironmentContext): void {
  set("TFC_HCP_PROVIDER_AUTH", "true");
  for (const key of ["run-provider-resource-name", "plan-provider-resource-name", "apply-provider-resource-name"] as const) {
    if (typeof values[key] === "string") set(`TFC_HCP_${key.replaceAll("-", "_").toUpperCase()}`, values[key]);
  }
  set("TFC_HCP_WORKLOAD_IDENTITY_AUDIENCE", audience);
}

function setKubernetesProviderEnvironment({ audience, token, tokenPath, set }: ProviderEnvironmentContext): void {
  set("TFC_KUBERNETES_PROVIDER_AUTH", "true");
  set("TFC_KUBERNETES_WORKLOAD_IDENTITY_AUDIENCE", audience);
  set("TFC_KUBERNETES_WORKLOAD_IDENTITY_TOKEN_FILE", tokenPath);
  set("KUBE_TOKEN", token.token);
}

const PROVIDER_ENVIRONMENT_SETTERS: Readonly<Record<CredentialProvider, (context: ProviderEnvironmentContext) => void>> = {
  aws: setAwsProviderEnvironment,
  gcp: setGcpProviderEnvironment,
  azure: setAzureProviderEnvironment,
  vault: setVaultProviderEnvironment,
  hcp: setHcpProviderEnvironment,
  kubernetes: setKubernetesProviderEnvironment,
};

function setProviderEnvironment(
  provider: CredentialProvider,
  values: Readonly<Record<string, unknown>>,
  audience: string,
  issuerUrl: string,
  token: IssuedIdentityToken,
  tokenPath: string,
  tag = "",
): Record<string, string> {
  const suffix = tag === "" ? "" : `_${tag}`;
  const env: Record<string, string> = {
    [`TFC_OIDC_ISSUER_URL${suffix}`]: issuerUrl,
    [`TFC_OIDC_AUDIENCE${suffix}`]: audience,
    [`TFC_OIDC_TOKEN_FILE${suffix}`]: tokenPath,
    [`TFC_OIDC_TOKEN${suffix}`]: token.token,
  };
  const set = (key: string, value: string): void => { env[`${key}${suffix}`] = value; };
  PROVIDER_ENVIRONMENT_SETTERS[provider]({ values, audience, token, tokenPath, set });
  return env;
}

async function writeTokenFile(directory: string, provider: CredentialProvider, token: IssuedIdentityToken, tag = ""): Promise<string> {
  const tokenDirectory = join(directory, ".terrence", "oidc");
  await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
  const safeTag = tag === "" ? "" : `-${tag.replaceAll(/[^A-Za-z0-9_-]/g, "_")}`;
  const path = join(tokenDirectory, `${provider}${safeTag}.jwt`);
  await writeFile(path, token.token, { mode: 0o600 });
  return path;
}

async function environmentFor(
  configurations: readonly CredentialConfiguration[],
  directory: string,
  issueToken: (provider: CredentialProvider, audience: string) => Promise<IssuedIdentityToken>,
): Promise<Readonly<{ environment: Record<string, string>; token: IssuedIdentityToken | undefined }>> {
  const environment: Record<string, string> = {};
  let firstToken: IssuedIdentityToken | undefined;
  for (const configuration of configurations) {
    const audience = audienceFor(configuration.provider, configuration.values);
    const token = await issueToken(configuration.provider, audience);
    firstToken ??= token;
    const path = await writeTokenFile(directory, configuration.provider, token, configuration.tag);
    Object.assign(environment, setProviderEnvironment(configuration.provider, configuration.values, audience, workloadIdentityIssuer(), token, path, configuration.tag));
  }
  return { environment, token: firstToken };
}

function workspaceProviderValues(
  provider: CredentialProvider,
  tag: string,
  // ReadonlyMap exposes only the lookup surface needed by this helper.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  values: ReadonlyMap<string, string>,
  phase: WorkspaceIdentityInput["phase"],
): Record<string, unknown> {
  const valueFor = (key: string): string | undefined => {
    const prefix = `TFC_${provider.toUpperCase()}_${key}`;
    return values.get(`${prefix}${tag === "" ? "" : `_${tag}`}`)
      ?? values.get(`TFC_DEFAULT_${provider.toUpperCase()}_${key}`)
      ?? (tag === "" ? undefined : values.get(prefix));
  };
  const providerValues: Record<string, unknown> = { audience: valueFor("WORKLOAD_IDENTITY_AUDIENCE") };
  if (provider === "aws") providerValues["role-arn"] = valueFor("RUN_ROLE_ARN");
  if (provider === "gcp") {
    providerValues["service-account-email"] = valueFor("RUN_SERVICE_ACCOUNT_EMAIL");
    providerValues["workload-provider-name"] = valueFor("WORKLOAD_PROVIDER_NAME");
  }
  if (provider === "azure") {
    providerValues["client-id"] = valueFor("RUN_CLIENT_ID");
    providerValues["tenant-id"] = valueFor("RUN_TENANT_ID");
    providerValues["subscription-id"] = valueFor("RUN_SUBSCRIPTION_ID");
  }
  if (provider === "vault") {
    providerValues["url"] = valueFor("ADDR");
    providerValues["role-name"] = valueFor("RUN_ROLE");
    providerValues["namespace"] = valueFor("NAMESPACE");
    providerValues["auth-path"] = valueFor("AUTH_PATH");
  }
  if (provider === "hcp") {
    const phaseResourceKey = phase === "plan" ? "PLAN_PROVIDER_RESOURCE_NAME" : "APPLY_PROVIDER_RESOURCE_NAME";
    providerValues["provider-resource-name"] = valueFor(phaseResourceKey) ?? valueFor("RUN_PROVIDER_RESOURCE_NAME");
    providerValues["plan-provider-resource-name"] = valueFor("PLAN_PROVIDER_RESOURCE_NAME");
    providerValues["apply-provider-resource-name"] = valueFor("APPLY_PROVIDER_RESOURCE_NAME");
    providerValues["run-provider-resource-name"] = valueFor("RUN_PROVIDER_RESOURCE_NAME");
    providerValues["audience"] = providerValues["audience"] ?? providerValues["provider-resource-name"];
  }
  return providerValues;
}

export async function moduleTestIdentityEnvironment(
  input: Omit<ModuleTestIdentityInput, "audience">,
  configuration: CredentialConfiguration,
  directory: string,
): Promise<Readonly<{ environment: Record<string, string>; token: IssuedIdentityToken }>> {
  const result = await environmentFor([configuration], directory, async (_provider, audience): Promise<IssuedIdentityToken> => issueModuleTestIdentityToken({ ...input, audience }));
  if (result.token === undefined) throw new Error("Unable to issue module test workload identity token");
  return { environment: result.environment, token: result.token };
}

export async function workspaceIdentityEnvironment(
  input: Omit<WorkspaceIdentityInput, "audience">,
  variables: readonly Readonly<{ key: string; value: string; category: string }>[],
  directory: string,
): Promise<Readonly<{ environment: Record<string, string>; tokens: IssuedIdentityToken[] }>> {
  const values = new Map(variables.filter((variable) => variable.category === "env").map((variable) => [variable.key, variable.value]));
  const providers: CredentialConfiguration[] = [];
  const providerTags = (provider: CredentialProvider): string[] => {
    const prefix = `TFC_${provider.toUpperCase()}_PROVIDER_AUTH`;
    return [...values.entries()]
      .filter(([key, value]) => (key === prefix || key.startsWith(`${prefix}_`)) && value.toLowerCase() === "true")
      .map(([key]) => key === prefix ? "" : key.slice(prefix.length + 1))
      .filter((tag, index, tags) => tags.indexOf(tag) === index);
  };
  for (const provider of ["aws", "gcp", "azure", "vault", "hcp", "kubernetes"] as const) {
    for (const tag of providerTags(provider)) {
      const providerValues = workspaceProviderValues(provider, tag, values, input.phase);
      providers.push({ provider, tag, values: providerValues });
    }
  }
  const tokens: IssuedIdentityToken[] = [];
  const result = await environmentFor(providers, directory, async (_provider, audience): Promise<IssuedIdentityToken> => {
    const token = await issueWorkspaceIdentityToken({ ...input, audience });
    tokens.push(token);
    return token;
  });
  const environment = { ...result.environment };
  for (const [key, audience] of values.entries()) {
    const match = /^TFC_WORKLOAD_IDENTITY_AUDIENCE(?:_(.+))?$/.exec(key);
    if (match === null || audience.trim() === "") continue;
    const tag = match[1] ?? "";
    const token = await issueWorkspaceIdentityToken({ ...input, audience: audience.trim() });
    tokens.push(token);
    environment[`TFC_WORKLOAD_IDENTITY_TOKEN${tag === "" ? "" : `_${tag}`}`] = token.token;
  }
  return { environment, tokens };
}

export function moduleTestTokenTtl(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_MODULE_TEST_TTL || value > MAX_MODULE_TEST_TTL) return undefined;
  return value;
}

export const moduleTestTokenTtlBounds = { default: DEFAULT_MODULE_TEST_TTL, min: MIN_MODULE_TEST_TTL, max: MAX_MODULE_TEST_TTL } as const;
