import { db } from "../db";

export function validVariableAttributes(attributes: any, partial = false) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"];
  const fields = Object.keys(attributes);
  const { key, value, category, sensitive, hcl, description } = attributes;
  return fields.every(field => allowedFields.includes(field))
    && (!partial || fields.length > 0)
    && (partial || value !== undefined)
    && (partial && key === undefined || typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))
    && (value === undefined || typeof value === "string")
    && (category === undefined || category === "terraform" || category === "env")
    && (sensitive === undefined || typeof sensitive === "boolean")
    && (hcl === undefined || typeof hcl === "boolean")
    && (description === undefined || description === null || typeof description === "string");
}

export function validVariableSetVariableAttributes(attributes: any, partial = false) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const { key, value, category, sensitive, hcl, description } = attributes;
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"];
  const fields = Object.keys(attributes);
  return fields.every(field => allowedFields.includes(field))
    && (!partial || fields.length > 0)
    && (partial && key === undefined || typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))
    && (value === undefined || typeof value === "string")
    && (category === undefined || category === "terraform" || category === "env")
    && (sensitive === undefined || typeof sensitive === "boolean")
    && (hcl === undefined || hcl === false)
    && (description === undefined || description === null || typeof description === "string");
}

export function validVariableSetAttributes(attributes: any, partial = false) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const { name, description, global, priority } = attributes;
  const fields = Object.keys(attributes);
  return fields.length > 0
    && fields.every(field => ["name", "description", "global", "priority"].includes(field))
    && (partial && name === undefined || typeof name === "string" && Boolean(name.trim()))
    && (description === undefined || description === null || typeof description === "string")
    && (global === undefined || typeof global === "boolean")
    && (priority === undefined || typeof priority === "boolean");
}

export function isUniqueConstraintError(error: any) {
  return [error, error?.cause].some(item =>
    item?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || item?.message?.includes("UNIQUE constraint failed")
  );
}

export function tokenExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return Number.NaN;
  return Date.parse(value);
}

export function decodeStatePayload(state: unknown) {
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

export function parseStatePayload(payload: string | null) {
  try {
    const state = JSON.parse(payload || "{}");
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}
