// Canonical identity helpers: single source for email/username normalization
// so invite + SCIM + SSO converge deterministically (todo #2, #11).
// Duplicate of sso.ts logic is intentional - sso.ts re-exports for compat
// but this module is the canonical import for routes that don't want a
// transitive sso dependency cycle.

export function sanitizeUsername(value: string): string | null {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]/g, "");
  if (cleaned === "" || cleaned.length > 100) return null;
  return cleaned;
}

export function normalizeUsername(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return sanitizeUsername(value);
}

export function validEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  return validEmail(value);
}
