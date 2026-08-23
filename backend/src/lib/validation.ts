import { decryptSecretSync, encryptSecret, isEncryptedSecret } from "./secrets";
import { join } from "node:path";

function stateStorageDir(): string {
  return process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage");
}

/** Encrypt state fields at rest while keeping the API/parser representation plain. */
export async function encryptStatePayload(payload: string | null): Promise<string | null> {
  return payload === null ? null : encryptSecret(payload);
}

function decryptStatePayload(payload: string): string {
  return isEncryptedSecret(payload) ? decryptSecretSync(payload, stateStorageDir()) : payload;
}

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
    && (hcl === undefined || typeof hcl === "boolean")
    && (description === undefined || description === null || typeof description === "string");
}

export function validVariableSetAttributes(attributes: unknown, partial = false): boolean {
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const attrs = attributes as Record<string, unknown>;
  const { name, description, global, priority, "parent-project-id": parentProjectId } = attrs;
  const fields = Object.keys(attrs);
  return fields.length > 0
    && fields.every((field: string): boolean =>
      ["name", "description", "global", "priority", "parent-project-id"].includes(field))
    && ((partial && name === undefined) || (typeof name === "string" && name.trim() !== ""))
    && (description === undefined || description === null || typeof description === "string")
    && (global === undefined || typeof global === "boolean")
    && (priority === undefined || typeof priority === "boolean")
    && (parentProjectId === undefined || parentProjectId === null || typeof parentProjectId === "string");
}

export function isUniqueConstraintError(error: unknown): boolean {
  const items: unknown[] = [error, (error as Record<string, unknown> | undefined)?.cause];
  return items.some((item: unknown): boolean => {
    const i = item as Record<string, unknown> | undefined;
    return i?.code === "SQLITE_CONSTRAINT_UNIQUE"
      || i?.code === "23505" // PostgreSQL unique_violation
      || (typeof i?.message === "string" && i.message.includes("UNIQUE constraint failed"))
      || (typeof i?.message === "string" && i.message.includes("duplicate key value violates unique constraint"));
  });
}

export function tokenExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return Number.NaN;
  return Date.parse(value);
}

export function decodeStatePayload(state: unknown): string {
  if (typeof state !== "string") return JSON.stringify(state);
  let plaintext = state;
  try {
    plaintext = decryptStatePayload(state);
    JSON.parse(plaintext);
    return plaintext;
  } catch {
    try {
      const decoded = Buffer.from(plaintext, "base64").toString("utf8");
      JSON.parse(decoded);
      return decoded;
    } catch {
      return plaintext;
    }
  }
}

export function parseStatePayload(payload: string | null): Record<string, unknown> | null {
  try {
    const state = JSON.parse(payload === null ? "{}" : decodeStatePayload(payload)) as unknown;
    return state !== null && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTerraformStateInstance(value: unknown): boolean {
  if (!isObjectRecord(value) || !isObjectRecord(value.attributes)) return false;
  return (value.schema_version === undefined || Number.isSafeInteger(value.schema_version))
    && (value.sensitive_attributes === undefined || Array.isArray(value.sensitive_attributes))
    && (value.dependencies === undefined || Array.isArray(value.dependencies));
}

function isTerraformStateResource(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (value.mode === "managed" || value.mode === "data")
    && typeof value.type === "string"
    && value.type !== ""
    && typeof value.name === "string"
    && value.name !== ""
    && typeof value.provider === "string"
    && value.provider !== ""
    && Array.isArray(value.instances)
    && value.instances.every((instance: unknown): boolean => isTerraformStateInstance(instance));
}

/** Validate the core Terraform/OpenTofu v4 state shape without rejecting optional fields. */
export function parseTerraformStatePayload(payload: string | null): Record<string, unknown> | null {
  const state = parseStatePayload(payload);
  if (
    state === null
    || state.version !== 4
    || !Number.isSafeInteger(state.serial)
    || (state.serial as number) < 0
    || typeof state.lineage !== "string"
    || state.lineage === ""
    || !Array.isArray(state.resources)
    || !state.resources.every((resource: unknown): boolean => isTerraformStateResource(resource))
  ) return null;

  if (state.terraform_version !== undefined && typeof state.terraform_version !== "string") return null;
  if (state.outputs !== undefined && !isObjectRecord(state.outputs)) return null;
  return state;
}
