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

function hasOnlyAllowedFields(fields: readonly string[], allowed: readonly string[]): boolean {
  return fields.every((field: string): boolean => allowed.includes(field));
}

function isValidKeyField(key: unknown, partial: boolean): boolean {
  if (partial && key === undefined) return true;
  return typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key);
}

function isValidOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isValidCategoryField(category: unknown): boolean {
  if (category === undefined) return true;
  return category === "terraform" || category === "env";
}

function isValidOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isValidDescriptionField(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isValidVariableName(name: unknown, partial: boolean): boolean {
  if (partial && name === undefined) return true;
  return typeof name === "string" && name.trim() !== "";
}

function isValidParentProjectId(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isRecordObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInvalidPartialEmpty(partial: boolean, fields: readonly string[]): boolean {
  return partial && fields.length === 0;
}

function isMissingRequiredValue(partial: boolean, value: unknown): boolean {
  return !partial && value === undefined;
}

export function validVariableAttributes(attributes: unknown, partial = false): boolean {
  if (!isRecordObject(attributes)) return false;
  const attrs = attributes as Record<string, unknown>;
  const fields = Object.keys(attrs);
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"] as const;
  if (!hasOnlyAllowedFields(fields, allowedFields)) return false;
  if (isInvalidPartialEmpty(partial, fields)) return false;
  if (isMissingRequiredValue(partial, attrs.value)) return false;
  if (!isValidKeyField(attrs.key, partial)) return false;
  if (!isValidOptionalString(attrs.value)) return false;
  if (!isValidCategoryField(attrs.category)) return false;
  if (!isValidOptionalBoolean(attrs.sensitive)) return false;
  if (!isValidOptionalBoolean(attrs.hcl)) return false;
  if (!isValidDescriptionField(attrs.description)) return false;
  return true;
}

export function validVariableSetVariableAttributes(attributes: unknown, partial = false): boolean {
  if (!isRecordObject(attributes)) return false;
  const attrs = attributes as Record<string, unknown>;
  const fields = Object.keys(attrs);
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"] as const;
  if (!hasOnlyAllowedFields(fields, allowedFields)) return false;
  if (isInvalidPartialEmpty(partial, fields)) return false;
  if (!isValidKeyField(attrs.key, partial)) return false;
  if (!isValidOptionalString(attrs.value)) return false;
  if (!isValidCategoryField(attrs.category)) return false;
  if (!isValidOptionalBoolean(attrs.sensitive)) return false;
  if (!isValidOptionalBoolean(attrs.hcl)) return false;
  if (!isValidDescriptionField(attrs.description)) return false;
  return true;
}

export function validVariableSetAttributes(attributes: unknown, partial = false): boolean {
  if (!isRecordObject(attributes)) return false;
  const attrs = attributes as Record<string, unknown>;
  const fields = Object.keys(attrs);
  if (fields.length === 0) return false;
  const allowed = ["name", "description", "global", "priority", "parent-project-id"] as const;
  if (!hasOnlyAllowedFields(fields, allowed)) return false;
  if (!isValidVariableName(attrs.name, partial)) return false;
  if (!isValidDescriptionField(attrs.description)) return false;
  if (!isValidOptionalBoolean(attrs.global)) return false;
  if (!isValidOptionalBoolean(attrs.priority)) return false;
  if (!isValidParentProjectId(attrs["parent-project-id"])) return false;
  return true;
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
  if (isEncryptedSecret(state)) {
    const plaintext = decryptStatePayload(state);
    JSON.parse(plaintext);
    return plaintext;
  }
  let plaintext = state;
  try {
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
