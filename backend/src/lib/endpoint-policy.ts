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
  | "none";

export type BodyLimitClass = "api" | "upload";
export type AuthClass = "public" | "authenticated" | "admin" | "system";
export type AuditClass = "auth" | "admin" | "workspace" | "run" | "none";

export type EndpointPolicy = Readonly<{
  id: string;
  /** Human-readable description for docs / audit. */
  description: string;
  /** Match predicate — replaces the scattered path Sets/regexes in app.ts. */
  match: (request: Readonly<{ method: string; url: string }>) => boolean;
  /** Canonical label returned by the classifier (what rate-limit keys group on). */
  label: string;
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
  "/oauth/authorization",
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
    return request.url;
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
    description: "Credential-bearing or secret-issuing endpoints (login, token issuance, invitation).",
    label: "sensitive",
    rateLimit: "sensitive",
    bodyLimit: "api",
    auth: "public",
    audit: "auth",
    secretResponse: true,
    match: (request): boolean => {
      const path = pathnameOf(request);
      if (request.method === "PATCH" && path === "/api/v2/account/password") return true;
      if (isInvitationPath(path)) return true;
      if (request.method !== "POST") return false;
      if (SENSITIVE_SET.has(path)) return true;
      if (/^\/api\/v2\/notification-configurations\/[^/]+\/actions\/verify$/.test(path)) return true;
      if (
        /^\/api\/v2\/(?:agent-pools|teams)\/[^/]+\/authentication-tokens?$/.test(path) ||
        /^\/api\/v2\/organizations\/[^/]+\/authentication-token$/.test(path)
      ) {
        return true;
      }
      return false;
    },
  },
  {
    id: "sso-get",
    description: "SSO challenge GETs that mutate server state and need a separate bucket.",
    label: "sso-get",
    rateLimit: "sso-get",
    bodyLimit: "api",
    auth: "public",
    audit: "auth",
    secretResponse: false,
    match: (request): boolean => request.method === "GET" && SSO_AUTH_SET.has(pathnameOf(request)),
  },
  {
    id: "scim-settings",
    description: "SCIM admin settings endpoint.",
    label: "scim-settings",
    rateLimit: "scim-settings",
    bodyLimit: "api",
    auth: "admin",
    audit: "admin",
    secretResponse: false,
    match: (request): boolean => {
      const path = pathnameOf(request);
      if (path !== "/api/v2/admin/scim-settings") return false;
      return request.method === "GET" || request.method === "PATCH" || request.method === "DELETE";
    },
  },
  {
    id: "scim-mapping",
    description: "SCIM group mapping mutations.",
    label: "scim-mapping",
    rateLimit: "scim-mapping",
    bodyLimit: "api",
    auth: "admin",
    audit: "admin",
    secretResponse: false,
    match: (request): boolean => {
      if (request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") return false;
      return /^\/api\/v2\/admin\/teams\/[^/]+\/scim-group-mapping$/.test(pathnameOf(request));
    },
  },
  {
    id: "workspace-run-history",
    description: "Workspace run listing (separate bucket per TFE reference).",
    label: "workspace-run-history",
    rateLimit: "workspace-run-history",
    bodyLimit: "api",
    auth: "authenticated",
    audit: "none",
    secretResponse: false,
    match: (request): boolean =>
      request.method === "GET" && /^\/api\/v2\/workspaces\/[^/]+\/runs$/.test(pathnameOf(request)),
  },
] as const;

// ---------------------------------------------------------------------------
// Derived classifiers — thin wrappers so app.ts calls a single import.
// ---------------------------------------------------------------------------

/** Canonical label for the sensitive bucket, or undefined when not sensitive. */
export function sensitivePath(request: Readonly<{ method: string; url: string }>): string | undefined {
  const path = pathnameOf(request);
  // Preserve the exact label shapes the previous implementation returned so
  // rate-limit keys stay stable across the refactor.
  if (request.method === "PATCH" && path === "/api/v2/account/password") return path;
  if (isInvitationPath(path)) return "/api/v2/organization-invitations/*";
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
}

export function sensitiveSsoPath(request: Readonly<{ method: string; url: string }>): string | undefined {
  const path = pathnameOf(request);
  if (request.method === "GET" && SSO_AUTH_SET.has(path)) return path;
  return undefined;
}

export function scimSettingsPath(request: Readonly<{ method: string; url: string }>): string | undefined {
  const path = pathnameOf(request);
  if (path !== "/api/v2/admin/scim-settings") return undefined;
  const m = request.method;
  return m === "GET" || m === "PATCH" || m === "DELETE" ? path : undefined;
}

export function scimMappingPath(request: Readonly<{ method: string; url: string }>): string | undefined {
  const m = request.method;
  if (m !== "POST" && m !== "PATCH" && m !== "DELETE") return undefined;
  const path = pathnameOf(request);
  return /^\/api\/v2\/admin\/teams\/[^/]+\/scim-group-mapping$/.test(path) ? path : undefined;
}

export function workspaceRunHistoryPath(request: Readonly<{ method: string; url: string }>): string | undefined {
  if (request.method !== "GET") return undefined;
  const path = pathnameOf(request);
  return /^\/api\/v2\/workspaces\/[^/]+\/runs$/.test(path) ? path : undefined;
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

/** Whether the request targets an archive upload (keeps the 100 MiB body limit). */
export function isUploadPath(pathname: string): boolean {
  return pathname.endsWith("/upload") || pathname.endsWith("/json-upload");
}

/** Resolve the rate-limit class for a request (first matching registry entry wins, else global/none). */
export function rateLimitClassFor(request: Readonly<{ method: string; url: string }>): RateLimitClass {
  for (const entry of ENDPOINT_POLICIES) {
    if (entry.match(request)) return entry.rateLimit;
  }
  return serverEndpointPath(request) !== undefined ? "global" : "none";
}
