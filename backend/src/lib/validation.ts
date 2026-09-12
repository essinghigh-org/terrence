import { databaseConstraint } from "./database-errors";
import {
  PERSISTED_JSON_SCHEMA_VERSION,
  PersistedJsonValidationError,
  readVersionedJson,
  versionedJson,
} from "./db-json";
import { decryptSecretSync, encryptSecret, isEncryptedSecret } from "./secrets";
import { join } from "node:path";

/**
 * Versioned representations for values that cross a database trust boundary.
 * The database schema keeps the original JSON columns for export/import
 * compatibility and stores the representation version beside each column.
 * Version 0 is the oldest raw representation; version 1 is the first typed
 * adapter and deliberately ignores unknown fields during execution while
 * retaining them in `extensions` for round trips.
 */
export const PERSISTED_RUN_INPUT_SCHEMA_VERSION = PERSISTED_JSON_SCHEMA_VERSION;
export const PERSISTED_ARTIFACT_SCHEMA_VERSION = PERSISTED_JSON_SCHEMA_VERSION;
export const PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION = PERSISTED_JSON_SCHEMA_VERSION;

export type PersistedRunVariable = Readonly<{
  key: string;
  value: string;
  category: "terraform" | "env";
  sensitive: boolean;
  valueEncrypted?: string;
  extensions?: Readonly<Record<string, unknown>>;
}>;

export type PersistedRunInputs = Readonly<{
  targetAddrs: readonly string[] | null;
  replaceAddrs: readonly string[] | null;
  invokeActionAddrs: readonly string[] | null;
  variables: readonly PersistedRunVariable[] | null;
  extensions?: Readonly<Record<string, unknown>>;
}>;

export type PersistedStatusMetadata = Readonly<Record<string, string>>;
export type PersistedArtifact = Readonly<Record<string, unknown>>;
export type PersistedJobPayload = Readonly<Record<string, unknown>>;

type PersistedContext = Readonly<{ field: string; rowId?: string; schemaVersion?: number }>;

function persistedContext(field: string, rowId?: string, schemaVersion?: number): PersistedContext {
  return { field, ...(rowId === undefined ? {} : { rowId }), ...(schemaVersion === undefined ? {} : { schemaVersion }) };
}

function persistedFailure(
  context: PersistedContext,
  code: PersistedJsonValidationError["code"],
  detail: string,
): never {
  throw new PersistedJsonValidationError(context.field, code, detail, {
    ...(context.rowId === undefined ? {} : { rowId: context.rowId }),
    ...(context.schemaVersion === undefined ? {} : { schemaVersion: context.schemaVersion }),
  });
}

function persistedVersion(version: number | undefined, field: string, rowId?: string): 0 | 1 {
  if (version === undefined) return 0;
  if (!Number.isSafeInteger(version) || version < 0) persistedFailure(persistedContext(field, rowId, version), "version", "schema version must be a non-negative integer");
  if (version !== 0 && version !== PERSISTED_JSON_SCHEMA_VERSION) {
    persistedFailure(persistedContext(field, rowId, version), "version", `unsupported schema version ${version}`);
  }
  return version === 0 ? 0 : 1;
}

function persistedRecord(value: unknown, context: PersistedContext): Readonly<Record<string, unknown>> {
  if (value === undefined) persistedFailure(context, "missing", "value is missing");
  if (value === null) persistedFailure(context, "null", "value is null");
  if (!isRecordObject(value)) persistedFailure(context, "type", "value must be an object");
  return value;
}

function persistedStringArray(
  value: unknown,
  context: PersistedContext,
  nullable: boolean,
): readonly string[] | null {
  if (value === null && nullable) return null;
  if (value === undefined) persistedFailure(context, "missing", "value is missing");
  if (!Array.isArray(value)) persistedFailure(context, value === null ? "null" : "type", "value must be an array or null");
  if (!value.every((entry: unknown): entry is string => typeof entry === "string")) {
    persistedFailure(context, "field", "array entries must be strings");
  }
  return value;
}

function recordExtensions(
  record: Readonly<Record<string, unknown>>,
  declaredExtensions: unknown,
  known: ReadonlySet<string>,
  context: PersistedContext,
): Record<string, unknown> {
  if (declaredExtensions !== undefined && !isRecordObject(declaredExtensions)) {
    persistedFailure(context, "field", "extensions must be an object");
  }
  return {
    ...(declaredExtensions ?? {}),
    ...Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key))),
  };
}

function assertVariableCategory(value: unknown, context: PersistedContext): asserts value is "terraform" | "env" | undefined {
  if (value !== undefined && value !== "terraform" && value !== "env") {
    persistedFailure(context, "field", "variable category must be terraform or env");
  }
}

function assertVariableSensitive(value: unknown, context: PersistedContext): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    persistedFailure(context, "field", "variable sensitive must be boolean");
  }
}

function assertVariableValueEncrypted(value: unknown, context: PersistedContext): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || !isEncryptedSecret(value))) {
    persistedFailure(context, "field", "variable valueEncrypted must be an encrypted secret");
  }
}

function persistedRunVariable(value: unknown, context: PersistedContext): PersistedRunVariable {
  const record = persistedRecord(value, context);
  if (typeof record["key"] !== "string" || record["key"] === "") persistedFailure(context, "field", "variable key must be a non-empty string");
  if (typeof record["value"] !== "string") persistedFailure(context, "field", "variable value must be a string");
  assertVariableCategory(record["category"], context);
  assertVariableSensitive(record["sensitive"], context);
  assertVariableValueEncrypted(record["valueEncrypted"], context);
  const extensions = recordExtensions(record, record["extensions"], new Set(["key", "value", "category", "sensitive", "valueEncrypted", "extensions"]), context);
  return {
    key: record["key"],
    value: record["value"],
    category: record["category"] ?? "terraform",
    sensitive: record["sensitive"] ?? false,
    ...(record["valueEncrypted"] === undefined ? {} : { valueEncrypted: record["valueEncrypted"] }),
    ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
  };
}

/** Adapt the oldest run input representation to the execution-safe shape. */
export function parsePersistedRunInputs(raw: unknown, schemaVersion = 0, rowId?: string): PersistedRunInputs {
  const version = persistedVersion(schemaVersion, "runs.inputs", rowId);
  const context = persistedContext("runs.inputs", rowId, version);
  const record = persistedRecord(raw, context);
  const declaredExtensions = record["extensions"];
  if (declaredExtensions !== undefined && !isRecordObject(declaredExtensions)) persistedFailure(context, "field", "extensions must be an object");
  const known = new Set(["targetAddrs", "replaceAddrs", "invokeActionAddrs", "variables", "extensions"]);
  const extensions = {
    ...(declaredExtensions ?? {}),
    ...Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key))),
  };
  const variables = record["variables"] === null ? null : (() => {
    if (!Array.isArray(record["variables"])) persistedFailure(persistedContext("runs.variables", rowId, version), "type", "variables must be an array or null");
    return record["variables"].map((entry: unknown, index: number) => persistedRunVariable(entry, persistedContext(`runs.variables[${index}]`, rowId, version)));
  })();
  return {
    targetAddrs: persistedStringArray(record["targetAddrs"], persistedContext("runs.targetAddrs", rowId, version), true),
    replaceAddrs: persistedStringArray(record["replaceAddrs"], persistedContext("runs.replaceAddrs", rowId, version), true),
    invokeActionAddrs: persistedStringArray(record["invokeActionAddrs"], persistedContext("runs.invokeActionAddrs", rowId, version), true),
    variables,
    ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
  };
}

export function encodePersistedRunInputs(value: PersistedRunInputs, extensions?: Readonly<Record<string, unknown>>): ReturnType<typeof versionedJson<PersistedRunInputs>> {
  return versionedJson(value, extensions);
}

export function decodePersistedRunInputs(raw: unknown, rowId?: string): Readonly<{ value: PersistedRunInputs; schemaVersion: number; extensions: Readonly<Record<string, unknown>> }> {
  const decoded = readVersionedJson<PersistedRunInputs>(raw, "runs.inputs", (value, context) => parsePersistedRunInputs(value, PERSISTED_RUN_INPUT_SCHEMA_VERSION, context.rowId), { rowId });
  if (decoded.value === null) persistedFailure(persistedContext("runs.inputs", rowId, decoded.schemaVersion), "null", "run inputs cannot be null");
  return { value: decoded.value, schemaVersion: decoded.schemaVersion, extensions: decoded.extensions };
}

/** Validate status metadata once when it is read from a persisted row. */
export function parsePersistedStatusMetadata(
  raw: unknown,
  schemaVersion = 0,
  rowId?: string,
  nullable = true,
): PersistedStatusMetadata | null {
  const version = persistedVersion(schemaVersion, "statusTimestamps", rowId);
  if ((raw === null || raw === undefined) && nullable) return null;
  const record = persistedRecord(raw, persistedContext("statusTimestamps", rowId, version));
  for (const [key, value] of Object.entries(record)) {
    if (key === "extensions") continue;
    if (typeof value !== "string") persistedFailure(persistedContext(`statusTimestamps.${key}`, rowId, version), "field", "status metadata values must be strings");
  }
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "extensions")) as PersistedStatusMetadata;
}

/** Artifact JSON is intentionally opaque to execution, but must be an object. */
export function parsePersistedArtifact(
  raw: unknown,
  schemaVersion = 0,
  rowId?: string,
  nullable = true,
): PersistedArtifact | null {
  const version = persistedVersion(schemaVersion, "assessmentResults.artifact", rowId);
  if (raw === null && nullable) return null;
  return persistedRecord(raw, persistedContext("assessmentResults.artifact", rowId, version));
}

export function encodePersistedArtifact(value: PersistedArtifact, extensions?: Readonly<Record<string, unknown>>): ReturnType<typeof versionedJson<PersistedArtifact>> {
  return versionedJson(value, extensions);
}

export function decodePersistedArtifact(raw: unknown, rowId?: string): Readonly<{ value: PersistedArtifact | null; schemaVersion: number; extensions: Readonly<Record<string, unknown>> }> {
  const decoded = readVersionedJson<PersistedArtifact>(raw, "assessmentResults.artifact", (value, context) => {
    const parsed = parsePersistedArtifact(value, PERSISTED_ARTIFACT_SCHEMA_VERSION, context.rowId);
    if (parsed === null) persistedFailure(persistedContext("assessmentResults.artifact", context.rowId), "null", "artifact envelope cannot contain null data");
    return parsed;
  }, { rowId, nullable: true });
  return { value: decoded.value, schemaVersion: decoded.schemaVersion, extensions: decoded.extensions };
}

type JobPayloadReaders = Readonly<{
  record: Readonly<Record<string, unknown>>;
  known: Record<string, unknown>;
  context: PersistedContext;
  rowId: string | undefined;
  version: 0 | 1;
  requiredString: (field: string) => string;
  optionalBoolean: (field: string) => boolean | undefined;
}>;

function parseExplorerCatalogPayload(readers: JobPayloadReaders): void {
  readers.known["orgId"] = readers.requiredString("orgId");
  const backfill = readers.optionalBoolean("backfill");
  if (backfill !== undefined) readers.known["backfill"] = backfill;
}

function parsePlanExplanationPayload(readers: JobPayloadReaders): void {
  readers.known["runId"] = readers.requiredString("runId");
  const explanationKind = readers.requiredString("kind");
  if (explanationKind !== "plan" && explanationKind !== "apply") {
    persistedFailure(persistedContext(`${readers.context.field}.kind`, readers.rowId, readers.version), "field", "kind must be plan or apply");
  }
  readers.known["kind"] = explanationKind;
}

function parseVcsWebhookPayload(readers: JobPayloadReaders): void {
  const provider = readers.requiredString("provider");
  if (provider !== "github" && provider !== "gitlab" && provider !== "bitbucket") {
    persistedFailure(persistedContext(`${readers.context.field}.provider`, readers.rowId, readers.version), "field", "provider must be github, gitlab, or bitbucket");
  }
  readers.known["provider"] = provider;
  readers.known["eventName"] = readers.requiredString("eventName");
  const payload = persistedRecord(readers.record["payload"], persistedContext(`${readers.context.field}.payload`, readers.rowId, readers.version));
  readers.known["payload"] = payload;
  const deliveryId = readers.record["deliveryId"];
  if (deliveryId === undefined) persistedFailure(persistedContext(`${readers.context.field}.deliveryId`, readers.rowId, readers.version), "missing", "deliveryId is missing");
  if (deliveryId !== null && typeof deliveryId !== "string") persistedFailure(persistedContext(`${readers.context.field}.deliveryId`, readers.rowId, readers.version), "field", "deliveryId must be a string or null");
  readers.known["deliveryId"] = deliveryId;
}

/**
 * Job payloads are validated before a worker handler sees them. The payload's
 * known top-level fields are retained for the handler; future fields survive
 * export/import but are never promoted into execution instructions by this
 * adapter.
 */
export function parsePersistedJobPayload(
  kind: string,
  raw: unknown,
  schemaVersion = 0,
  rowId?: string,
): PersistedJobPayload {
  const version = persistedVersion(schemaVersion, `durableJobs.${kind}.payload`, rowId);
  const context = persistedContext(`durableJobs.${kind}.payload`, rowId, version);
  const record = persistedRecord(raw, context);
  const requiredString = (field: string): string => {
    const value = record[field];
    if (typeof value !== "string" || value === "") persistedFailure(persistedContext(`${context.field}.${field}`, rowId, version), "field", `${field} must be a non-empty string`);
    return value;
  };
  const optionalBoolean = (field: string): boolean | undefined => {
    const value = record[field];
    if (value !== undefined && typeof value !== "boolean") persistedFailure(persistedContext(`${context.field}.${field}`, rowId, version), "field", `${field} must be boolean`);
    return value;
  };
  const known: Record<string, unknown> = {};
  const readers: JobPayloadReaders = { record, known, context, rowId, version, requiredString, optionalBoolean };
  switch (kind) {
    case "module-test":
      known["runId"] = requiredString("runId");
      break;
    case "stack-configuration":
      known["configurationId"] = requiredString("configurationId");
      break;
    case "stack-deployment":
      known["runId"] = requiredString("runId");
      break;
    case "explorer-inventory":
      known["workspaceId"] = requiredString("workspaceId");
      break;
    case "explorer-catalog":
      parseExplorerCatalogPayload(readers);
      break;
    case "plan-explanation":
      parsePlanExplanationPayload(readers);
      break;
    case "vcs-webhook":
      parseVcsWebhookPayload(readers);
      break;
    case "outbox-delivery":
      known["eventId"] = requiredString("eventId");
      break;
    default:
      persistedFailure(context, "field", `unsupported durable job kind ${kind}`);
  }
  const extensions = recordExtensions(record, record["extensions"], new Set([...Object.keys(known), "extensions"]), context);
  return { ...known, ...(Object.keys(extensions).length === 0 ? {} : { extensions }) };
}

export function encodePersistedJobPayload(value: PersistedJobPayload, extensions?: Readonly<Record<string, unknown>>): ReturnType<typeof versionedJson<PersistedJobPayload>> {
  return versionedJson(value, extensions);
}

export function decodePersistedJobPayload(kind: string, raw: unknown, rowId?: string): Readonly<{ value: PersistedJobPayload; schemaVersion: number; extensions: Readonly<Record<string, unknown>> }> {
  const decoded = readVersionedJson<PersistedJobPayload>(raw, `durableJobs.${kind}.payload`, (value, context) => parsePersistedJobPayload(kind, value, PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION, context.rowId), { rowId });
  if (decoded.value === null) persistedFailure(persistedContext(`durableJobs.${kind}.payload`, rowId, decoded.schemaVersion), "null", "job payload cannot be null");
  return { value: decoded.value, schemaVersion: decoded.schemaVersion, extensions: decoded.extensions };
}

function stateStorageDir(): string {
  return process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage");
}

/** Encrypt state fields at rest while keeping the API/parser representation plain. */
export async function encryptStatePayload(payload: string | null): Promise<string | null> {
  return payload === null ? null : encryptSecret(payload);
}

export function decryptStatePayload(payload: string): string {
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

function isRecordObject(value: unknown): value is Readonly<Record<string, unknown>> {
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
  if (isMissingRequiredValue(partial, attrs["value"])) return false;
  if (!isValidKeyField(attrs["key"], partial)) return false;
  if (!isValidOptionalString(attrs["value"])) return false;
  if (!isValidCategoryField(attrs["category"])) return false;
  if (!isValidOptionalBoolean(attrs["sensitive"])) return false;
  if (!isValidOptionalBoolean(attrs["hcl"])) return false;
  if (!isValidDescriptionField(attrs["description"])) return false;
  return true;
}

export function validVariableSetVariableAttributes(attributes: unknown, partial = false): boolean {
  if (!isRecordObject(attributes)) return false;
  const attrs = attributes as Record<string, unknown>;
  const fields = Object.keys(attrs);
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"] as const;
  if (!hasOnlyAllowedFields(fields, allowedFields)) return false;
  if (isInvalidPartialEmpty(partial, fields)) return false;
  if (!isValidKeyField(attrs["key"], partial)) return false;
  if (!isValidOptionalString(attrs["value"])) return false;
  if (!isValidCategoryField(attrs["category"])) return false;
  if (!isValidOptionalBoolean(attrs["sensitive"])) return false;
  if (!isValidOptionalBoolean(attrs["hcl"])) return false;
  if (!isValidDescriptionField(attrs["description"])) return false;
  return true;
}

export function validVariableSetAttributes(attributes: unknown, partial = false): boolean {
  if (!isRecordObject(attributes)) return false;
  const attrs = attributes as Record<string, unknown>;
  const fields = Object.keys(attrs);
  if (fields.length === 0) return false;
  const allowed = ["name", "description", "global", "priority", "parent-project-id"] as const;
  if (!hasOnlyAllowedFields(fields, allowed)) return false;
  if (!isValidVariableName(attrs["name"], partial)) return false;
  if (!isValidDescriptionField(attrs["description"])) return false;
  if (!isValidOptionalBoolean(attrs["global"])) return false;
  if (!isValidOptionalBoolean(attrs["priority"])) return false;
  if (!isValidParentProjectId(attrs["parent-project-id"])) return false;
  return true;
}

export function isUniqueConstraintError(error: unknown): boolean {
  if (databaseConstraint(error) === "unique") return true;
  const items: unknown[] = [error, (error as Record<string, unknown> | undefined)?.["cause"]];
  return items.some((item: unknown): boolean => {
    const i = item as Record<string, unknown> | undefined;
    return i?.["code"] === "SQLITE_CONSTRAINT_UNIQUE"
      || i?.["code"] === "23505" // PostgreSQL unique_violation
      || (typeof i?.["message"] === "string" && i["message"].includes("UNIQUE constraint failed"))
      || (typeof i?.["message"] === "string" && i["message"].includes("duplicate key value violates unique constraint"));
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
  const plaintext = state;
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

export const CLIENT_ENCRYPTED_STATE_ERROR = "Client-encrypted OpenTofu state is unsupported. Keep the encrypted state and its keys in an encryption-capable backend; Terrence requires plaintext v4 state for indexing and serial-safe recovery. See /app/docs/state.";

/** The OpenTofu envelope is JSON, but its contents cannot be inspected without client keys. */
export function isClientEncryptedState(payload: string | null): boolean {
  const state = parseStatePayload(payload);
  return state !== null && ("encryption_version" in state || "encrypted_data" in state);
}

export function statePayloadError(payload: string | null): string {
  return isClientEncryptedState(payload) ? CLIENT_ENCRYPTED_STATE_ERROR : "State content must be a valid plaintext Terraform/OpenTofu v4 state file";
}

function isTerraformStateInstance(value: unknown): boolean {
  if (!isObjectRecord(value) || !isObjectRecord(value["attributes"])) return false;
  return (value["schema_version"] === undefined || Number.isSafeInteger(value["schema_version"]))
    && (value["sensitive_attributes"] === undefined || Array.isArray(value["sensitive_attributes"]))
    && (value["dependencies"] === undefined || Array.isArray(value["dependencies"]));
}

function isTerraformStateResource(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (value["mode"] === "managed" || value["mode"] === "data")
    && typeof value["type"] === "string"
    && value["type"] !== ""
    && typeof value["name"] === "string"
    && value["name"] !== ""
    && typeof value["provider"] === "string"
    && value["provider"] !== ""
    && Array.isArray(value["instances"])
    && value["instances"].every((instance: unknown): boolean => isTerraformStateInstance(instance));
}

/** Validate the core Terraform/OpenTofu v4 state shape without rejecting optional fields. */
export function parseTerraformStatePayload(payload: string | null): Record<string, unknown> | null {
  const state = parseStatePayload(payload);
  if (
    state === null
    || "encryption_version" in state
    || "encrypted_data" in state
    || state["version"] !== 4
    || !Number.isSafeInteger(state["serial"])
    || (state["serial"] as number) < 0
    || typeof state["lineage"] !== "string"
    || state["lineage"] === ""
    || !Array.isArray(state["resources"])
    || !state["resources"].every((resource: unknown): boolean => isTerraformStateResource(resource))
  ) return null;

  if (state["terraform_version"] !== undefined && typeof state["terraform_version"] !== "string") return null;
  if (state["outputs"] !== undefined && !isObjectRecord(state["outputs"])) return null;
  return state;
}


/** Change state metadata without rounding arbitrary resource numbers through JS floats. */
export function statePayloadWithSerial(payload: string, serial: number): string {
  if (!Number.isSafeInteger(serial) || serial < 0) throw new Error("Invalid state serial");
  // Bun exposes the native JSON source-text proposal; TypeScript's JSON type lags it.
  const rawJson = JSON as typeof JSON & { rawJSON: (source: string) => unknown };
  const state = JSON.parse(payload, (_key: string, value: unknown, context?: Readonly<{ source?: string }>): unknown =>
    typeof value === "number" && context?.source !== undefined ? rawJson.rawJSON(context.source) : value) as Record<string, unknown>;
  return JSON.stringify({ ...state, serial });
}
