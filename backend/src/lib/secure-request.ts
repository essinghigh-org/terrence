import { trustedForwardedProtocol } from "./client-ip";

type RequestInfo = Readonly<{ url: string }>;

// PUBLIC_URL is the source of truth when a proxy terminates TLS. It is parsed
// once so malformed configuration cannot turn into a per-request exception.
const publicUrl = (() => {
  const raw = process.env.PUBLIC_URL;
  if (raw === undefined || raw === "") return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
})();

export function secureRequest(request: RequestInfo | undefined, server?: unknown): boolean {
  if (publicUrl !== null) return publicUrl.protocol === "https:";
  if (request === undefined) return false;
  if (trustedForwardedProtocol(request, server) === "https") return true;
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}
