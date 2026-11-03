/** An explicit allowlist keeps admin settings and internal links off public pages. */
const publicKeys = [
  "support-email-address",
  "support-url-address",
  "login-help",
  "footer",
  "error",
  "new-user",
] as const;
const internalKeys = ["internal-support-url", "internal-documentation-url", "internal-tutorials-url"] as const;

export function gravatarEnabled(settings: Readonly<Record<string, unknown>>): boolean {
  const sources = settings["avatar-sources"];
  return (
    Array.isArray(sources) &&
    sources.some((item: unknown): boolean => {
      if (typeof item !== "object" || item === null) return false;
      const source = item as Record<string, unknown>;
      return source["source"] === "gravatar" && source["enabled"] === true;
    })
  );
}

export function presentationSettings(
  settings: Readonly<Record<string, unknown>>,
  authenticated: boolean,
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = { "gravatar-enabled": gravatarEnabled(settings) };
  for (const key of [...publicKeys, ...(authenticated ? internalKeys : [])]) {
    const value = settings[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function visibleBanner(value: unknown, authenticated: boolean, now = Date.now()): unknown {
  if (typeof value !== "object" || value === null) return null;
  const banner = value as Record<string, unknown>;
  const attrs = banner["attributes"];
  if (typeof attrs !== "object" || attrs === null) return null;
  const attributes = attrs as Record<string, unknown>;
  if (attributes["audience"] !== "all_users" && !authenticated) return null;
  const start = attributes["scheduled-publish-at"];
  const end = attributes["scheduled-expire-at"];
  if (typeof start === "string" && (!Number.isFinite(Date.parse(start)) || now < Date.parse(start))) return null;
  if (typeof end === "string" && (!Number.isFinite(Date.parse(end)) || now >= Date.parse(end))) return null;
  return banner;
}
