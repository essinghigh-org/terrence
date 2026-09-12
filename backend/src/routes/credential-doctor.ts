import { hostname } from "node:os";
import jwt from "jsonwebtoken";
import { and, desc, eq, gte } from "drizzle-orm";
import { Elysia } from "elysia";
import { authPlugin } from "../auth";
import { db } from "../db";
import { agentPools, agents, oidcConfigs, organizations, type users } from "../db/schema";
import { auditLog, apiError, checkOrganizationPermission, notFound } from "../lib/utils";
import { fetchResolvedExternalUrl, resolveExternalUrl } from "../lib/url-safety";
import { forwardFetch } from "../lib/agent-forwarding";
import {
  credentialDoctorAudience,
  credentialDoctorNetworkEndpoint,
  providerForOidcConfigType,
  runCredentialDoctor,
  type CredentialDoctorRequest,
  type CredentialDoctorRequester,
} from "../lib/credential-doctor";
import { issueCredentialDoctorIdentityToken } from "../lib/workload-identity";

type SetObject = Readonly<{
  status?: number | string;
  headers: Readonly<Record<string, string | number>>;
}>;

type ParamContext = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  request: Readonly<{ headers: Readonly<Headers> }>;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObject;
}>;

type AgentContext = Readonly<{
  kind: "worker" | "agent_pool";
  node: string;
  processId: string;
  agentPoolId: string | null;
  agentId: string | null;
}>;

function dataAttributes(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const data = (body as Record<string, unknown>)["data"];
  if (typeof data !== "object" || data === null) return {};
  const attrs = (data as Record<string, unknown>)["attributes"];
  return typeof attrs === "object" && attrs !== null && !Array.isArray(attrs) ? attrs as Record<string, unknown> : {};
}

function safeSubject(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  // Provider subject values are identifiers. Reject control characters before
  // they can enter a JWT claim or an audit/UI response.
  if (!/^[\x21-\x7e]+$/.test(value) || /^Bearer\s+/i.test(value) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return undefined;
  return value;
}

function safeClaims(token: string): Record<string, unknown> {
  const decoded = jwt.decode(token);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return {};
  const record = decoded as Record<string, unknown>;
  const claims: Record<string, unknown> = {};
  for (const key of ["iss", "aud", "sub", "iat", "nbf", "exp", "jti"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") claims[key] = value;
  }
  return claims;
}

function localRequester(): CredentialDoctorRequester {
  return async (request: CredentialDoctorRequest): Promise<Response> => {
    const destination = await resolveExternalUrl(request.url, false);
    if ("error" in destination) throw new Error(destination.error);
    return fetchResolvedExternalUrl(destination.target, {
      method: request.method,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      timeoutMs: 5_000,
      maxResponseBytes: 64 * 1024,
    });
  };
}

function agentRequester(agentPoolId: string): CredentialDoctorRequester {
  return async (request: CredentialDoctorRequest): Promise<Response> => forwardFetch(agentPoolId, request.url, {
    method: request.method,
    ...(request.headers === undefined ? {} : { headers: request.headers }),
    ...(request.body === undefined ? {} : { body: request.body }),
  }, { sensitive: true });
}

async function activeAgentForPool(poolId: string): Promise<Readonly<typeof agents.$inferSelect> | undefined> {
  const cutoff = Date.now() - 90_000;
  const candidates = await db.query.agents.findMany({
    where: and(eq(agents.agentPoolId, poolId), gte(agents.lastPingAt, cutoff)),
    orderBy: [desc(agents.lastPingAt)],
  });
  return candidates.find((agent): boolean => agent.requestForwarding === true || agent.hyok === true);
}

function resultResource(
  id: string,
  configurationId: string,
  provider: string,
  startedAt: number,
  completedAt: number,
  context: AgentContext,
  claims: Readonly<Record<string, unknown>>,
  result: Awaited<ReturnType<typeof runCredentialDoctor>>,
): Record<string, unknown> {
  return {
    id,
    type: "credential-doctor-runs",
    attributes: {
      "configuration-id": configurationId,
      provider,
      status: result.status,
      "started-at": new Date(startedAt).toISOString(),
      "completed-at": new Date(completedAt).toISOString(),
      timestamp: new Date(completedAt).toISOString(),
      "execution-context": {
        kind: context.kind,
        node: context.node,
        "process-id": context.processId,
        "agent-pool-id": context.agentPoolId,
        "agent-id": context.agentId,
      },
      claims,
      checks: result.checks,
      identity: result.identity,
      caveat: "A successful identity/read probe does not prove authorization for every later resource operation.",
    },
    relationships: {
      "oidc-configuration": { data: { id: configurationId, type: "oidc-configurations" } },
    },
  };
}

type DoctorTarget = Readonly<{
  row: typeof oidcConfigs.$inferSelect;
  org: typeof organizations.$inferSelect;
  provider: NonNullable<ReturnType<typeof providerForOidcConfigType>>;
}>;

type DoctorFailure = { ok: false; response: unknown };

async function resolveDoctorTarget(
  params: Readonly<Record<string, string>>,
  user: ParamContext["user"],
  tokenOrgId: string | null,
  teamId: string | null,
  set: SetObject,
): Promise<{ ok: true; target: DoctorTarget } | DoctorFailure> {
  const configurationId = params["oidc_id"] ?? "";
  const row = await db.query.oidcConfigs.findFirst({ where: eq(oidcConfigs.id, configurationId) });
  if (row === undefined) return { ok: false, response: notFound(set) };
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, row.orgId) });
  if (org === undefined || !(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId, "manage-providers"))) return { ok: false, response: notFound(set) };
  const requestedOrgName = params["org_name"];
  if (requestedOrgName !== undefined && requestedOrgName !== org.name) return { ok: false, response: notFound(set) };
  const provider = providerForOidcConfigType(row.configType);
  if (provider === undefined) return { ok: false, response: apiError(set, 422, "Unprocessable Entity", "This OIDC configuration does not have a credential doctor probe") };
  return { ok: true, target: { row, org, provider } };
}

function parseDoctorInput(
  body: unknown,
  orgName: string,
  set: SetObject,
): { ok: true; input: { agentPoolId: string | null; subject: string } } | DoctorFailure {
  const attrs = dataAttributes(body);
  const agentPoolValue = attrs["agent-pool-id"];
  if (agentPoolValue !== undefined && agentPoolValue !== null && typeof agentPoolValue !== "string") return { ok: false, response: apiError(set, 422, "Unprocessable Entity", "agent-pool-id must be a string or null") };
  const agentPoolId = typeof agentPoolValue === "string" && agentPoolValue.trim() !== "" ? agentPoolValue.trim() : null;
  const subjectValue = attrs["subject"];
  if (subjectValue !== undefined && subjectValue !== null && safeSubject(subjectValue) === undefined) return { ok: false, response: apiError(set, 422, "Unprocessable Entity", "subject must be a printable identifier of at most 512 characters") };
  const subject = safeSubject(subjectValue) ?? `organization:${orgName}:credential-doctor`;
  return { ok: true, input: { agentPoolId, subject } };
}

async function resolveDoctorExecution(
  orgId: string,
  agentPoolId: string | null,
  set: SetObject,
): Promise<{ ok: true; execution: { context: AgentContext; requester: CredentialDoctorRequester } } | DoctorFailure> {
  if (agentPoolId === null) {
    return {
      ok: true,
      execution: {
        context: { kind: "worker", node: hostname() || "unknown", processId: String(process.pid), agentPoolId: null, agentId: null },
        requester: localRequester(),
      },
    };
  }
  const pool = await db.query.agentPools.findFirst({ where: and(eq(agentPools.id, agentPoolId), eq(agentPools.orgId, orgId)) });
  if (pool === undefined) return { ok: false, response: notFound(set) };
  const agent = await activeAgentForPool(agentPoolId);
  if (agent === undefined) return { ok: false, response: apiError(set, 503, "Service Unavailable", "No active request-forwarding agent is available in the selected agent pool") };
  return {
    ok: true,
    execution: {
      context: { kind: "agent_pool", node: pool.id, processId: "agent", agentPoolId: pool.id, agentId: agent.id },
      requester: agentRequester(pool.id),
    },
  };
}

async function runDoctorDiagnostic(
  target: DoctorTarget,
  configurationId: string,
  subject: string,
  context: AgentContext,
  requester: CredentialDoctorRequester,
  userId: string | null,
  set: SetObject,
): Promise<unknown> {
  const { row, provider } = target;
  // Validate the configured endpoint before minting a token. This gives an
  // operator a clear configuration error and ensures the only user-supplied
  // destination (Vault) passes the same URL policy as every probe request.
  const endpoint = credentialDoctorNetworkEndpoint(provider, row.config);
  if ("error" in endpoint) return apiError(set, 422, "Unprocessable Entity", endpoint.error);
  const startedAt = Date.now();
  const audience = credentialDoctorAudience(provider, row.config);
  let issued;
  try {
    issued = await issueCredentialDoctorIdentityToken({
      organizationId: row.orgId,
      organizationName: target.org.name,
      audience,
      subject,
      ttlSeconds: 300,
    });
  } catch {
    return apiError(set, 503, "Service Unavailable", "Unable to issue a workload identity token for this diagnostic");
  }
  const claims = safeClaims(issued.token);
  const result = await runCredentialDoctor({ provider, values: row.config }, { token: issued.token, claims }, requester);
  const completedAt = Date.now();
  const id = crypto.randomUUID();
  await auditLog("credential_doctor.run", "oidc-configuration", configurationId, userId, row.orgId, {
    provider,
    status: result.status,
    executionContext: context.kind,
    agentPoolId: context.agentPoolId,
  });
  return { data: resultResource(id, configurationId, provider, startedAt, completedAt, context, claims, result) };
}

async function handleCredentialDoctor({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamContext): Promise<unknown> {
  const target = await resolveDoctorTarget(params, user, tokenOrgId, teamId, set);
  if (!target.ok) return target.response;
  const input = parseDoctorInput(body, target.target.org.name, set);
  if (!input.ok) return input.response;
  const execution = await resolveDoctorExecution(target.target.row.orgId, input.input.agentPoolId, set);
  if (!execution.ok) return execution.response;
  const configurationId = params["oidc_id"] ?? "";
  return runDoctorDiagnostic(target.target, configurationId, input.input.subject, execution.execution.context, execution.execution.requester, user?.id ?? null, set);
}

export const credentialDoctorRoutes = new Elysia({ name: "credential-doctor" })
  .use(authPlugin)
  .post("/api/v2/organizations/:org_name/oidc-configurations/:oidc_id/credential-doctor", handleCredentialDoctor)
  .post("/api/v2/oidc-configurations/:oidc_id/credential-doctor", handleCredentialDoctor)
  // The diagnostics alias is useful to API clients that group all read-only
  // checks under one action namespace while keeping the explicit doctor path.
  .post("/api/v2/organizations/:org_name/oidc-configurations/:oidc_id/diagnostics", handleCredentialDoctor)
  .post("/api/v2/oidc-configurations/:oidc_id/diagnostics", handleCredentialDoctor);
