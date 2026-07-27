export function validVariableAttributes(attributes: unknown, partial = false): boolean {
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"];
  const fields = Object.keys(attributes);
  const attrs = attributes as Record<string, unknown>;
  const { key, value, category, sensitive, hcl, description } = attrs;
  return fields.every((field: string): boolean => allowedFields.includes(field))
    && (!partial || fields.length > 0)
    && (partial || value !== undefined)
    && ((partial && key === undefined) || (typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)))
    && (value === undefined || typeof value === "string")
    && (category === undefined || category === "terraform" || category === "env")
    && (sensitive === undefined || typeof sensitive === "boolean")
    && (hcl === undefined || typeof hcl === "boolean")
    && (description === undefined || description === null || typeof description === "string");
}

export function validVariableSetVariableAttributes(attributes: unknown, partial = false): boolean {
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const attrs = attributes as Record<string, unknown>;
  const { key, value, category, sensitive, hcl, description } = attrs;
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"];
  const fields = Object.keys(attrs);
  return fields.every((field: string): boolean => allowedFields.includes(field))
    && (!partial || fields.length > 0)
    && ((partial && key === undefined) || (typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)))
    && (value === undefined || typeof value === "string")
    && (category === undefined || category === "terraform" || category === "env")
    && (sensitive === undefined || typeof sensitive === "boolean")
    && (hcl === undefined || hcl === false)
    && (description === undefined || description === null || typeof description === "string");
}

export function validVariableSetAttributes(attributes: unknown, partial = false): boolean {
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const attrs = attributes as Record<string, unknown>;
  const { name, description, global, priority } = attrs;
  const fields = Object.keys(attrs);
  return fields.length > 0
    && fields.every((field: string): boolean => ["name", "description", "global", "priority"].includes(field))
    && ((partial && name === undefined) || (typeof name === "string" && name.trim() !== ""))
    && (description === undefined || description === null || typeof description === "string")
    && (global === undefined || typeof global === "boolean")
    && (priority === undefined || typeof priority === "boolean");
}

export function isUniqueConstraintError(error: unknown): boolean {
  const items: unknown[] = [error, (error as Record<string, unknown> | undefined)?.cause];
  return items.some((item: unknown): boolean => {
    const i = item as Record<string, unknown> | undefined;
    return i?.code === "SQLITE_CONSTRAINT_UNIQUE"
      || (typeof i?.message === "string" && i.message.includes("UNIQUE constraint failed"));
  });
}

export function tokenExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return Number.NaN;
  return Date.parse(value);
}

export function decodeStatePayload(state: unknown): string {
  if (typeof state !== "string") return JSON.stringify(state);
  try {
    JSON.parse(state);
    return state;
  } catch {
    try {
      const decoded = Buffer.from(state, "base64").toString("utf8");
      JSON.parse(decoded);
      return decoded;
    } catch {
      return state;
    }
  }
}

export function parseStatePayload(payload: string | null): Record<string, unknown> | null {
  try {
    const state = JSON.parse(payload ?? "{}") as unknown;
    return state !== null && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
