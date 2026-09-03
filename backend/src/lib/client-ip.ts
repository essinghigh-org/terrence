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
import { isIPv4InCidr } from "./url-safety";

type PeelServer = Readonly<{ readonly requestIP?: (request: unknown) => Readonly<{ readonly address?: string }> | null }> | null;

let cachedTrustedHeaders: string[] = [];
let cachedTrustedProxyCidrs: string[] = [];
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
    const configuredCidrs = next["trusted-client-ip-cidrs"];
    const settingsCidrs = Array.isArray(configuredCidrs)
      ? configuredCidrs.filter((cidr): cidr is string => typeof cidr === "string" && cidr.trim() !== "")
      : [];
    cachedTrustedProxyCidrs = settingsCidrs.length > 0
      ? settingsCidrs
      : (process.env["TERRENCE_TRUSTED_PROXY_CIDRS"] ?? "").split(",").map((cidr): string => cidr.trim()).filter(Boolean);
  } catch {
    cachedTrustedHeaders = [];
    cachedTrustedProxyCidrs = [];
  }
}

/** Synchronous read of the configured header list (for the rate-limit path). */
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function trustedClientIpHeaders(): readonly string[] {
  return cachedTrustedHeaders;
}

/** Read a forwarded client address only when the actual socket peer is trusted. */
export function trustedClientIpForPeer(request: unknown, peer: string | null): string | null {
  return trustedProxy(peer) ? trustedHeaderValue(request) : null;
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
  // This helper has no socket peer, so it cannot authenticate a proxy. Callers
  // must use PUBLIC_URL when TLS terminates upstream; never trust a forwarded
  // scheme from an unbound request object.
  return false;
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

function trustedProxy(peer: string | null): boolean {
  if (peer === null || cachedTrustedProxyCidrs.length === 0) return false;
  return cachedTrustedProxyCidrs.some((cidr): boolean => isIPv4InCidr(peer, cidr));
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

export function trustedForwardedProtocol(request: unknown, server: unknown): string | null {
  const peer = peerAddress(request, server);
  if (!trustedProxy(peer)) return null;
  return headerValue(request, "x-forwarded-proto")?.toLowerCase() ?? null;
}

/**
 * Resolve the client IP for a request.
 * - When trusted headers are configured: return the first configured header's
 *   value, falling back to the peer address.
 * - Otherwise the peer (socket) address is authoritative. When it is
 *   unavailable, no forwarded address is trusted.
 */
export async function resolveClientIp(request: unknown, server: unknown): Promise<string | null> {
  const peer = peerAddress(request, server);
  if (peer !== null) {
    if (cachedTrustedHeaders.length > 0 && trustedProxy(peer)) {
      const trusted = trustedHeaderValue(request);
      if (trusted !== null) return trusted;
    }
    return peer;
  }
  return null;
}
