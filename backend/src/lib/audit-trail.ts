import { AsyncLocalStorage } from "node:async_hooks";
import { isImpersonationTokenId } from "./impersonation";
import type { TokenScopes } from "./token-scopes";

/** The credential that established the principal for an audit event. */
export type AuditCredentialClass =
  | "anonymous"
  | "session"
  | "user-token"
  | "organization-token"
  | "team-token"
  | "run-token"
  | "system-token"
  | "impersonation-token";

export type AuditResult = "success" | "denied" | "failure";

export type AuditRequestContext = Readonly<{
  requestId: string | null;
  method: string | null;
  path: string | null;
  userId: string | null;
  credentialClass: AuditCredentialClass;
  credentialId: string | null;
  effectiveScope: Readonly<Record<string, unknown>>;
}>;

const auditContextStorage = new AsyncLocalStorage<AuditRequestContext>();

const EMPTY_SCOPE: Readonly<Record<string, unknown>> = Object.freeze({ kind: "none" });

/** Begin the audit context for a request.  The context is deliberately
 * independent of the database row so audit writes still work when the auth
 * lookup is rejected or when a background operation has no HTTP request. */
export function beginAuditRequest(requestId: string, method: string, path: string): void {
  auditContextStorage.enterWith({
    requestId,
    method,
    path,
    userId: null,
    credentialClass: "anonymous",
    credentialId: null,
    effectiveScope: EMPTY_SCOPE,
  });
}

type AuditPrincipalInput = Readonly<{
  userId: string | null;
  tokenId?: string | null;
  orgId?: string | null;
  teamId?: string | null;
  runId?: string | null;
  systemTokenId?: string | null;
  scopes?: TokenScopes | null;
  authenticated?: boolean;
  credentialClass?: AuditCredentialClass;
}>;

function detectCredentialClass(input: AuditPrincipalInput): AuditCredentialClass {
  if (input.systemTokenId !== undefined && input.systemTokenId !== null) return "system-token";
  if (input.runId !== undefined && input.runId !== null) return "run-token";
  if (input.teamId !== undefined && input.teamId !== null) return "team-token";
  if (input.orgId !== undefined && input.orgId !== null) return "organization-token";
  if (input.tokenId !== undefined && input.tokenId !== null) {
    return isImpersonationTokenId(input.tokenId) ? "impersonation-token" : "user-token";
  }
  return input.authenticated === true || input.userId !== null ? "session" : "anonymous";
}

function identityScopeEntries(input: AuditPrincipalInput): Record<string, string> {
  return {
    ...(input.orgId === null || input.orgId === undefined ? {} : { orgId: input.orgId }),
    ...(input.teamId === null || input.teamId === undefined ? {} : { teamId: input.teamId }),
    ...(input.runId === null || input.runId === undefined ? {} : { runId: input.runId }),
  };
}

function buildEffectiveScope(input: AuditPrincipalInput): Readonly<Record<string, unknown>> {
  const scopes = input.scopes;
  if (scopes === undefined || scopes === null) {
    return Object.freeze({ kind: input.authenticated === true ? "legacy" : "none", ...identityScopeEntries(input) });
  }
  return Object.freeze({
    kind: "fine-grained",
    orgs: [...scopes.orgs].slice(0, 256),
    projects: scopes.projects === null ? null : [...scopes.projects].slice(0, 256),
    workspaces: scopes.workspaces === null ? null : [...scopes.workspaces].slice(0, 256),
    permissions: Object.entries(scopes.permissions).filter(([, value]): boolean => value === true).map(([key]): string => key).sort().slice(0, 256),
    ...identityScopeEntries(input),
  });
}

export function setAuditPrincipal(input: AuditPrincipalInput): void {
  const current = auditContextStorage.getStore();
  if (current === undefined) return;
  auditContextStorage.enterWith({
    ...current,
    userId: input.userId,
    credentialClass: input.credentialClass ?? detectCredentialClass(input),
    credentialId: input.systemTokenId ?? input.tokenId ?? null,
    effectiveScope: buildEffectiveScope(input),
  });
}

export function currentAuditContext(): AuditRequestContext | null {
  return auditContextStorage.getStore() ?? null;
}

export function resetAuditRequest(): void {
  auditContextStorage.enterWith({
    requestId: null,
    method: null,
    path: null,
    userId: null,
    credentialClass: "anonymous",
    credentialId: null,
    effectiveScope: EMPTY_SCOPE,
  });
}

const SECRET_KEY = /(?:^|[-_])(authorization|bearer|password|passwd|secret|raw[-_]?token|access[-_]?token|refresh[-_]?token|credential|private[-_]?key|raw[-_]?state|state[-_]?payload|plan[-_]?json|encrypted[-_]?value)(?:$|[-_])/i;
const RAW_PAYLOAD_KEYS = new Set(["body", "comment", "payload", "plan", "raw", "state"]);
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const URL_SECRET_QUERY = /^(?:token|access[_-]?token|refresh[_-]?token|authorization|signature|sig|secret|key|password)$/i;
const MAX_DETAIL_DEPTH = 8;
const MAX_DETAIL_ENTRIES = 96;
const MAX_DETAIL_STRING = 4096;

function safeUrlString(value: string): string {
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (URL_SECRET_QUERY.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    if (/^bearer\s+/i.test(parsed.username) || /^bearer\s+/i.test(parsed.password)) {
      parsed.username = "";
      parsed.password = "[REDACTED]";
    }
    // Capability and bearer links sometimes carry the credential in a path
    // segment instead of a query parameter.  Keep the route shape while
    // replacing the opaque segment at construction time.
    parsed.pathname = parsed.pathname
      .replace(/(\/log\/)[^/]+/gi, "$1[REDACTED]")
      .replace(/(\/token[s]?\/)[^/]+/gi, "$1[REDACTED]");
    return parsed.toString().replace(BEARER_VALUE, "Bearer [REDACTED]").slice(0, MAX_DETAIL_STRING);
  } catch {
    const redacted = value.replace(BEARER_VALUE, "Bearer [REDACTED]");
    return redacted.length > MAX_DETAIL_STRING ? `${redacted.slice(0, MAX_DETAIL_STRING)}…` : redacted;
  }
}

/** Redact before insertion.  Audit readers must never be relied on as the
 * security boundary for credentials, state, plan payloads, or signed URLs. */
export function sanitizeAuditValue(value: unknown, depth = 0, key = ""): unknown {
  const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1-$2");
  if (SECRET_KEY.test(normalizedKey) || RAW_PAYLOAD_KEYS.has(normalizedKey.toLowerCase())) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return safeUrlString(trimmed);
    const redacted = value.replace(BEARER_VALUE, "Bearer [REDACTED]");
    return redacted.length > MAX_DETAIL_STRING ? `${redacted.slice(0, MAX_DETAIL_STRING)}…` : redacted;
  }
  if (depth >= MAX_DETAIL_DEPTH) return "[REDACTED: depth limit]";
  if (Array.isArray(value)) return value.slice(0, MAX_DETAIL_ENTRIES).map((item): unknown => sanitizeAuditValue(item, depth + 1, key));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_DETAIL_ENTRIES)) {
      output[childKey] = sanitizeAuditValue(childValue, depth + 1, childKey);
    }
    return output;
  }
  return Object.prototype.toString.call(value);
}

const IMMUTABLE_ACTIONS = new Set([
  "approve", "apply", "cancel", "delete", "discard", "force-cancel", "force-execute", "impersonate",
  "override-policy", "recover-state", "revoke", "unimpersonate", "grant-admin", "revoke-admin",
  "disable-2fa", "replace", "remove",
]);

function lifecycleMetadata(details: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const before = details["before"] ?? (typeof details["fromStatus"] === "string" ? { status: details["fromStatus"] } : undefined);
  const after = details["after"] ?? (typeof details["toStatus"] === "string" ? { status: details["toStatus"] } : undefined);
  return {
    ...(before === undefined ? {} : { before: sanitizeAuditValue(before) }),
    ...(after === undefined ? {} : { after: sanitizeAuditValue(after) }),
  };
}

function resolveAuditResult(result: AuditResult | undefined, source: Readonly<Record<string, unknown>>): AuditResult {
  if (result !== undefined) return result;
  if (source["result"] === "denied") return "denied";
  return source["result"] === "failure" ? "failure" : "success";
}

function resolveEffectiveUserId(
  explicit: string | null | undefined,
  safeSource: Readonly<Record<string, unknown>>,
  context: AuditRequestContext | null,
  fallback: string | null,
): string | null {
  if (explicit !== undefined && explicit !== null) return explicit;
  if (typeof safeSource["effectiveUserId"] === "string") return safeSource["effectiveUserId"];
  return context === null ? fallback : context.userId ?? fallback;
}

function auditCredentialClass(context: AuditRequestContext | null): AuditCredentialClass {
  return context === null ? "system-token" : context.credentialClass;
}

function auditEffectiveScope(context: AuditRequestContext | null): Readonly<Record<string, unknown>> {
  return context === null ? { kind: "system" } : context.effectiveScope;
}

function auditIdentity(context: AuditRequestContext | null): { requestId: string | null; credentialId: string | null } {
  if (context === null) return { requestId: null, credentialId: null };
  return { requestId: context.requestId, credentialId: context.credentialId };
}

/** Build the stable envelope shared by every audit writer. */
export function buildAuditDetails(input: Readonly<{
  action: string;
  resourceType: string;
  resourceId: string | null;
  orgId: string | null;
  userId: string | null;
  effectiveUserId?: string | null;
  details?: Readonly<Record<string, unknown>>;
  result?: AuditResult;
  immutable?: boolean;
}>): Readonly<Record<string, unknown>> {
  const source = input.details ?? {};
  const context = currentAuditContext();
  const result = resolveAuditResult(input.result, source);
  const immutable = input.immutable ?? IMMUTABLE_ACTIONS.has(input.action);
  const safeSource = sanitizeAuditValue(source) as Record<string, unknown>;
  const effectiveUserId = resolveEffectiveUserId(input.effectiveUserId, safeSource, context, input.userId);
  const identity = auditIdentity(context);
  const credentialClass = auditCredentialClass(context);
  const effectiveScope = auditEffectiveScope(context);
  return {
    ...safeSource,
    schemaVersion: 1,
    action: input.action,
    result,
    immutable,
    requestId: identity.requestId,
    correlationId: identity.requestId,
    credentialClass,
    credentialId: identity.credentialId,
    effectiveScope,
    actor: {
      userId: input.userId,
      effectiveUserId,
      credentialClass,
      effectiveScope,
    },
    target: { orgId: input.orgId, resourceType: input.resourceType, resourceId: input.resourceId },
    ...lifecycleMetadata(safeSource),
  };
}

export function auditLogValues(input: Readonly<{
  id?: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  orgId: string | null;
  userId: string | null;
  effectiveUserId?: string | null;
  createdAt?: number;
  details?: Readonly<Record<string, unknown>>;
  result?: AuditResult;
  immutable?: boolean;
}>): Readonly<Record<string, unknown>> {
  return {
    id: input.id ?? crypto.randomUUID(),
    orgId: input.orgId,
    userId: input.userId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    details: buildAuditDetails(input),
    createdAt: input.createdAt ?? Date.now(),
  };
}

export { IMMUTABLE_ACTIONS };
