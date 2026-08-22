// Client-IP resolution that honors a configurable, priority-ordered list of
// trusted proxy headers (e.g. ["CF-Connecting-IP", "X-Forwarded-For"]).
//
// Rationale: behind a reverse proxy (Cloudflare etc.) the peer socket address
// is the proxy's, so browser sessions / audit records / rate limits would all
// key on the proxy instead of the real client. The admin can opt in to trusting
// specific forwarded headers via the `general` settings key
// `trusted-client-ip-headers` (highest priority first). When that list is
// empty (default) the trusted peer address is authoritative and forwarded
// headers are ignored — the secure default.
//
// The trusted list is cached in memory and refreshed at server startup and
// after any admin settings write, so the sync rate-limit path can read it
// without an async DB query per request.
import { getSettings } from "./settings";

type PeelServer = Readonly<{ readonly requestIP?: (request: unknown) => Readonly<{ readonly address?: string }> | null }> | null;

let cachedTrustedHeaders: string[] = [];
/** Re-read the trusted-header list from settings (startup + admin writes). */
export async function refreshTrustedClientIpHeaders(): Promise<void> {
  try {
    const next = await getSettings("general");
    const raw = next["trusted-client-ip-headers"];
    if (Array.isArray(raw)) {
      cachedTrustedHeaders = raw.filter((name): name is string => typeof name === "string" && name.trim() !== "");
    } else {
      cachedTrustedHeaders = [];
    }
  } catch {
    cachedTrustedHeaders = [];
  }
}

/** Synchronous read of the configured header list (for the rate-limit path). */
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function trustedClientIpHeaders(): readonly string[] {
  return cachedTrustedHeaders;
}

/** Synchronously resolve a request's IP from the configured trusted headers
 * (empty when no header matches the configured priority list). */
export function syncedTrustedClientIp(request: unknown): string | null {
  if (cachedTrustedHeaders.length === 0) return null;
  return trustedHeaderValue(request);
}

/**
 * Whether the current request was served over HTTPS.
 * Respects X-Forwarded-Proto when the admin has configured trusted proxy headers,
 * otherwise checks the URL scheme directly. Trusting the forwarded header only
 * when the proxy is configured prevents an off-proxy client from spoofing HTTPS.
 */
/** @public Intentional surface: used by security-headers HSTS check. */
export function requestIsHttps(request: Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>): boolean {
  try {
    if (new URL(request.url).protocol === "https:") return true;
  } catch { /* fall through to header check */ }
  // Only trust X-Forwarded-Proto when a trusted header list is configured (proxy in front).
  if (cachedTrustedHeaders.length === 0) return false;
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return forwarded === "https";
}

function headerValue(request: unknown, name: string): string | null {
  const value = (request as { headers?: { get?: (k: string) => string | null } } | null)?.headers?.get?.(name);
  if (value === undefined || value === null || value === "") return null;
  // A proxy appends the peer chain as "client, proxy1, proxy2" — the leftmost
  // entry is the client per RFC 7239 / standard proxy behavior.
  return value.split(",")[0]?.trim() ?? null;
}

function trustedHeaderValue(request: unknown): string | null {
  for (const name of cachedTrustedHeaders) {
    const value = headerValue(request, name);
    if (value !== null) return value;
  }
  return null;
}

function peerAddress(request: unknown, server: unknown): string | null {
  const peel = server as PeelServer;
  try {
    const socket = typeof peel?.requestIP === "function" ? peel.requestIP(request) : null;
    const address = socket?.address;
    return typeof address === "string" && address !== "" ? address : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the client IP for a request.
 * - When trusted headers are configured: return the first configured header's
 *   value, falling back to the peer address.
 * - Otherwise the peer (socket) address is authoritative. The app.handle()
 *   test-only path (no peer) falls back to X-Forwarded-For / X-Real-IP so a
 *   simulated client address can be supplied in tests.
 */
export async function resolveClientIp(request: unknown, server: unknown): Promise<string | null> {
  const peer = peerAddress(request, server);
  if (peer !== null) {
    if (cachedTrustedHeaders.length > 0) {
      const trusted = trustedHeaderValue(request);
      if (trusted !== null) return trusted;
    }
    return peer;
  }
  if (server !== null) return null;
  if (cachedTrustedHeaders.length > 0) {
    const trusted = trustedHeaderValue(request);
    if (trusted !== null) return trusted;
  }
  const forwarded = headerValue(request, "x-forwarded-for");
  if (forwarded !== null) return forwarded;
  return headerValue(request, "x-real-ip");
}