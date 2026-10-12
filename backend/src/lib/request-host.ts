import { isIP } from "node:net";
import { executionSetting, networkSetting } from "./runtime-config";
import { isTrustedProxyPeer, socketPeerAddress } from "./client-ip";

type HostRequest = Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>;

function allowedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  // Literal addresses cannot be rebound through DNS. Local development and
  // health probes remain usable before the operator configures a public URL.
  if (host === "localhost" || isIP(host.replace(/^\[|\]$/g, "")) !== 0) return true;
  const publicUrl = executionSetting("PUBLIC_URL");
  if (publicUrl !== null && new URL(publicUrl).hostname.toLowerCase().replace(/\.$/, "") === host) return true;
  return networkSetting("TERRENCE_ALLOWED_HOSTS").includes(host);
}

function allowedAuthority(authority: string): boolean {
  if (authority === "" || /[\s,/@\\?#]/.test(authority)) return false;
  try {
    return allowedHostname(new URL(`http://${authority}`).hostname);
  } catch {
    return false;
  }
}

/** Validate before authentication, cookies, redirects, or serving the SPA. */
export function requestHostAllowed(request: HostRequest, server?: unknown): boolean {
  if (!allowedHostname(new URL(request.url).hostname)) return false;
  const host = request.headers.get("host");
  if (host !== null && !allowedAuthority(host)) return false;
  const forwarded = request.headers.get("x-forwarded-host");
  return forwarded === null || !isTrustedProxyPeer(socketPeerAddress(request, server)) || allowedAuthority(forwarded);
}
