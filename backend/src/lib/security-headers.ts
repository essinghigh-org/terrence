// Browser/shell hardening headers for the Terrence serving layer.
//
// CSP is scoped to the actual SPA: everything is same-origin; theme colors are
// applied via the CSSOM (element.style.setProperty / classList), which CSP does
// not police, and a small set of components use dynamic inline `style={}` props,
// so we allow inline styles ('unsafe-inline' in style-src ONLY) while keeping
// script-src strict ('self' — no inline/eval).
//
// Avatars (Gravatar, GitHub/GitLab/Bitbucket, self-hosted VCS) are fetched
// server-side by the /api/v2/avatars/<opaque-key> proxy, so img-src stays
// same-origin and no remote image host ever needs to be allow-listed.
const DEFAULT_IMG_SRC = ["'self'", "data:"];

// The policy is static per process: build it once and serve the same string
// on every response instead of re-joining arrays per request (this function
// runs once per HTTP response). Kept as a function so tests can still call
// it; the memo is reset only by the test reset below.
let memoizedCsp: string | null = null;

/** Build the CSP (memoized; the policy is static per process). */
export function buildContentSecurityPolicy(options?: Readonly<{ strict?: boolean }>): string {
  const strict = options?.strict ?? process.env["TERRENCE_CSP_STRICT"] === "1";
  if (memoizedCsp !== null && !strict) return memoizedCsp;
  const imgSrc = DEFAULT_IMG_SRC.join(" ");
  const styleSrc = strict
    ? "style-src 'self'"
    : "style-src 'self' 'unsafe-inline'";
  const policy = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "connect-src 'self'",
    `img-src ${imgSrc}`,
    "media-src 'self'",
    "font-src 'self'",
    "script-src 'self'",
    styleSrc,
  ].join("; ");
  if (!strict) memoizedCsp = policy;
  return policy;
}

/** Test-only reset so a mutated DEFAULT_IMG_SRC cannot leak across tests. */
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function resetContentSecurityPolicyCache(): void {
  memoizedCsp = null;
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  // Clickjacking: CSP frame-ancestors is the modern control; keep the legacy
  // X-Frame-Options for older browsers that ignore frame-ancestors.
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  // Authenticated app: don't want search engines referencing it.
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  // Browser capabilities Terrence does not use (clipboard deliberately left
  // enabled — the UI writes tokens/config to the clipboard).
  "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=(), serial=(), bluetooth=(), battery=(), accelerometer=(), gyroscope=(), magnetometer=(), xr-spatial-tracking=(), display-capture=(), idle-detection=(), gamepad=(), picture-in-picture=()",
};

const IMMUTABLE_ASSET_AGE = 31_536_000; // 1 year, hashed filenames never change
const SHORT_ASSET_AGE = 86_400; // 1 day for favicon/icons

/**
 * Cache-Control policy for static responses keyed by path.
 * - Bundler emits hashed files under /assets/<name>-<hash>.<ext>: immutable.
 * - index.html is revalidated so a new deploy (with new hashes) is picked up.
 * - favicon/manifest/icons: short-lived public cache (revalidate occasionally).
 * `undefined` means "leave the framework default" (API/uncategorised paths).
 */
export function staticCacheControl(pathname: string): string | undefined {
  if (pathname.startsWith("/assets/")) return `public, max-age=${IMMUTABLE_ASSET_AGE}, immutable`;
  if (pathname === "/favicon.svg" || pathname.startsWith("/icons/")) return `public, max-age=${SHORT_ASSET_AGE}`;
  if (pathname === "/manifest.webmanifest") return "no-cache";
  if (pathname === "/" || pathname === "/login" || pathname === "/register" || pathname.startsWith("/app")) {
    return "no-cache";
  }
  return undefined;
}

export function applySecurityHeaders(target: Record<string, string | number>): void {
  target["Content-Security-Policy"] ??= buildContentSecurityPolicy();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (target[name] === undefined) target[name] = value;
  }
}

/** HSTS value when Terrence knows it is being served over HTTPS (includeSubDomains, 1 year). */
export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/** Whether a response should carry HSTS. Caller passes the request so we can check the scheme / X-Forwarded-Proto. */
export function shouldSendHsts(request: Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>): boolean {
  // Import lazily to avoid circular deps at module load.
  try {
    const { requestIsHttps } = require("./client-ip") as { requestIsHttps: (r: unknown) => boolean };
    return requestIsHttps(request);
  } catch {
    try {
      return new URL(request.url).protocol === "https:";
    } catch {
      return false;
    }
  }
}

// Static assets served by the Elysia static plugin arrive without a
// Content-Type; with X-Content-Type-Options: nosniff (and module-script MIME
// rules) that breaks stylesheets and JS modules. Assign explicit MIME types.
const STATIC_MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

export function staticMimeFor(pathname: string): string | undefined {
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return undefined;
  return STATIC_MIME_TYPES[pathname.slice(dot).toLowerCase()];
}