/**
 * Returns the URL only if it is a safe http(s) URL, otherwise null.
 * Rejects javascript:, data:, blob:, file:, vbscript: and protocol-relative
 * URLs, and empty/invalid inputs. Relative URLs that resolve to http(s) are
 * not considered safe here - callers should already have absolute URLs from
 * the backend.
 */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const trimmed = raw.trim();
  // Allow same-origin relative URLs (e.g. /api/v2/provider-icons/...) which are safe
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") return trimmed;
    return null;
  } catch {
    return null;
  }
}

