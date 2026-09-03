// Single endpoint-policy registry (todo 21).
//
// Today `app.ts` maintained a half dozen independent path Sets and regexes
// for rate-limit classification, body-limit bypass, and secret-response
// handling. That surface is drift-prone: a new route can be added without
// updating every classifier. This module is the single source of truth for
// endpoint policy so all classifiers derive from one declarative table.
//
// Each registry entry declares the dimensions called for in the todo:
// authentication, permission, rate-limit class, body limit, audit class,
// and secret-response status. Not every dimension is enforced yet — the
// registry is the declaration layer; enforcement migrates incrementally so a
// PR that adds a route must update one place and gets a failing test if it
// does not. Fields that are not yet enforced are optional and default to
// the current behaviour.

export type RateLimitClass =
  | "global"
  | "sensitive"
  | "sso-get"
  | "scim-settings"
  | "scim-mapping"
  | "workspace-run-history"
  | "metrics"
  | "none";

export type BodyLimitClass = "api" | "upload";
export type AuthClass = "public" | "authenticated" | "admin" | "system";
export type AuditClass = "auth" | "admin" | "workspace" | "run" | "none";

export type EndpointPolicy = Readonly<{
  id: string;
  /** Human-readable description for docs / audit. */
  description: string;
  /**
   * Match predicate. Returns the canonical rate-limit label when the request
   * matches this policy, or undefined otherwise. Returning the label directly
   * lets classifiers derive from the registry instead of re-encoding the same
   * Set/regex in two places (which would drift).
   */
  match: (request: Readonly<{ method: string; url: string }>) => string | undefined;
  rateLimit: RateLimitClass;
  bodyLimit: BodyLimitClass;
  auth: AuthClass;
  audit: AuditClass;
  /** Whether the response may contain a raw secret (token, key material). */
  secretResponse: boolean;
}>;

// ---------------------------------------------------------------------------
// Shared path constants — canonical lists, not duplicated per classifier.
// ---------------------------------------------------------------------------

export const SSO_AUTH_PATHS = [
  "/users/oidc/auth",
  "/users/oidc/callback",
  "/users/saml/auth",
  "/users/saml/logout",
  "/users/saml/slo",
] as const;

const SSO_AUTH_SET = new Set<string>(SSO_AUTH_PATHS);

export const SENSITIVE_API_PATHS = [
  "/admin/initial-admin-user",
  "/api/v2/tokens",
  "/api/v2/users",
  "/api/v2/users/login",
  "/api/v2/account/mfa/verify",
  "/api/v2/account/mfa",
  "/oauth/authorization",
  "/oauth/authorization/complete",
  "/oauth/token",
  ...SSO_AUTH_PATHS,
] as const;

const SENSITIVE_SET = new Set<string>(SENSITIVE_API_PATHS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathnameOf(request: Readonly<{ url: string }>): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    // Relative or malformed URL (e.g. "/api/v2/users/login?next=/x"): keep
    // only the path segment so Set/regex classifiers don't fail open on a
    // query string or fragment.
    const raw = request.url;
    const end = Math.min(
      ...[raw.indexOf("?"), raw.indexOf("#")].filter((index): boolean => index >= 0).concat([raw.length]),
    );
    return raw.slice(0, end);
  }
}

function isInvitationPath(pathname: string): boolean {
  return (
    (pathname.startsWith("/api/v2/organizations/") && pathname.includes("/organization-invitations")) ||
    pathname.startsWith("/api/v2/organization-invitations/")
  );
}

// ---------------------------------------------------------------------------
// Registry — one entry per rate-limit class. The global bucket is implicit
// (everything matching serverEndpoint) so it has no explicit entry; its
// matcher is serverEndpointPath() below. Every other bucket is explicit.
// ---------------------------------------------------------------------------

export const ENDPOINT_POLICIES: readonly EndpointPolicy[] = [
  {
    id: "sensitive",
    description: "Credential-bearing or secret-issuing endpoints (OAuth authorization, login, tokens, MFA, invitations).",
    rateLimit: "sensitive",
    bodyLimit: "api",
    auth: "public",
    audit: "auth",
    secretResponse: true,
    match: (request): string | undefined => {
      const path = pathnameOf(request);
      if (request.method === "PATCH" && path === "/api/v2/account/password") return path;
      if (isInvitationPath(path)) return "/api/v2/organization-invitations/*";
      if (request.method === "GET" && (path === "/oauth/authorization" || path === "/oauth/authorization/complete")) {
        return path;
      }
      if (request.method === "DELETE" && path === "/api/v2/account/mfa") return path;
      if (request.method !== "POST") return undefined;
      if (SENSITIVE_SET.has(path)) return path;
      if (/^\/api\/v2\/notification-configurations\/[^/]+\/actions\/verify$/.test(path)) {
        return "/api/v2/notification-configurations/*/actions/verify";
      }
      if (
        /^\/api\/v2\/(?:agent-pools|teams)\/[^/]+\/authentication-tokens?$/.test(path) ||
        /^\/api\/v2\/organizations\/[^/]+\/authentication-token$/.test(path)
      ) {
        return "/api/v2/*/authentication-tokens";
      }
      return undefined;
    },
  },
  {
    id: "sso-get",
    description: "SSO challenge GETs that mutate server state and need a separate bucket.",
    rateLimit: "sso-get",
    bodyLimit: "api",
    auth: "public",
    audit: "auth",
    secretResponse: false,
    match: (request): string | undefined => {
      const path = pathnameOf(request);
      return request.method === "GET" && SSO_AUTH_SET.has(path) ? path : undefined;
    },
  },
  {
    id: "scim-settings",
    description: "SCIM admin settings endpoint.",
    rateLimit: "scim-settings",
    bodyLimit: "api",
    auth: "admin",
    audit: "admin",
    secretResponse: false,
    match: (request): string | undefined => {
      const path = pathnameOf(request);
      if (path !== "/api/v2/admin/scim-settings") return undefined;
      const m = request.method;
      return m === "GET" || m === "PATCH" || m === "DELETE" ? path : undefined;
    },
  },
  {
    id: "scim-mapping",
    description: "SCIM group mapping mutations.",
    rateLimit: "scim-mapping",
    bodyLimit: "api",
    auth: "admin",
    audit: "admin",
    secretResponse: false,
    match: (request): string | undefined => {
      const m = request.method;
      if (m !== "POST" && m !== "PATCH" && m !== "DELETE") return undefined;
      const path = pathnameOf(request);
      return /^\/api\/v2\/admin\/teams\/[^/]+\/scim-group-mapping$/.test(path) ? path : undefined;
    },
  },
  {
    id: "metrics",
    description: "Metrics endpoint (service-token / scoped-token auth).",
    rateLimit: "metrics",
    bodyLimit: "api",
    auth: "authenticated",
    audit: "none",
    secretResponse: true,
    match: (request): string | undefined => {
      const p = pathnameOf(request);
      return p === "/metrics" || p.startsWith("/metrics?") ? "/metrics" : undefined;
    },
  },
  {
    id: "workspace-run-history",
    description: "Workspace run listing (separate bucket per TFE reference).",
    rateLimit: "workspace-run-history",
    bodyLimit: "api",
    auth: "authenticated",
    audit: "none",
    secretResponse: false,
    match: (request): string | undefined =>
      request.method === "GET" && /^\/api\/v2\/workspaces\/[^/]+\/runs$/.test(pathnameOf(request))
        ? "/api/v2/workspaces/*/runs"
        : undefined,
  },
] as const;

// ---------------------------------------------------------------------------
// Derived classifiers — delegate to the registry so the two can never drift.
// ---------------------------------------------------------------------------

function labelFor(
  id: EndpointPolicy["id"],
  request: Readonly<{ method: string; url: string }>,
): string | undefined {
  const entry = ENDPOINT_POLICIES.find((candidate): boolean => candidate.id === id);
  return entry?.match(request);
}

/** Canonical label for the sensitive bucket, or undefined when not sensitive. */
export function sensitivePath(request: Readonly<{ method: string; url: string }>): string | undefined {
  return labelFor("sensitive", request);
}

export function sensitiveSsoPath(request: Readonly<{ method: string; url: string }>): string | undefined {
  return labelFor("sso-get", request);
}

export function scimSettingsPath(request: Readonly<{ method: string; url: string }>): string | undefined {
  return labelFor("scim-settings", request);
}

export function scimMappingPath(request: Readonly<{ method: string; url: string }>): string | undefined {
  return labelFor("scim-mapping", request);
}

export function workspaceRunHistoryPath(request: Readonly<{ method: string; url: string }>): string | undefined {
  return labelFor("workspace-run-history", request);
}

/**
 * Paths that count toward the global API rate limit. Everything else (SPA
 * shell, /assets/*, favicon) is static content and must not consume the
 * bucket. /api/v2/ping is explicitly exempt (go-tfe feature detection).
 */
export function serverEndpointPath(request: Readonly<{ method: string; url: string }>): string | undefined {
  const path = pathnameOf(request);
  if (path === "/api/v2/ping") return undefined;
  if (
    path.startsWith("/api/") ||
    path.startsWith("/oauth/") ||
    path.startsWith("/users/") ||
    path.startsWith("/admin/")
  ) {
    return path;
  }
  return undefined;
}

/** Whether the request targets an archive upload (keeps the 100 MiB body limit). */export { isUploadPath } from "./body-limit";

/** Resolve the rate-limit class for a request (first matching registry entry wins, else global/none). */
/** @public Intentional surface: registry consumer for future enforcement layer. */
export function rateLimitClassFor(request: Readonly<{ method: string; url: string }>): RateLimitClass {
  for (const entry of ENDPOINT_POLICIES) {
    if (entry.match(request) !== undefined) return entry.rateLimit;
  }
  return serverEndpointPath(request) !== undefined ? "global" : "none";
}
