import { encryptSecret, decryptSecret, isEncryptedSecret } from "./secrets";

// Sensitive-variable value encryption (todo 167-169): `sensitive=true` rows
// store their value ONLY in value_encrypted (enc:v1); the plaintext column
// keeps "". Non-sensitive rows keep plaintext in `value` with a null
// encrypted column. Plaintext sensitive rows written before this shipped
// are migrated on next write (see migrateSensitiveVariableValue).

export type EncryptedVariableWrite = {
  value: string;
  valueEncrypted: string | null;
};

/** Encrypt a variable value for persistence when sensitive. */
export async function variableValueForWrite(
  sensitive: boolean,
  plaintext: string,
): Promise<EncryptedVariableWrite> {
  if (!sensitive) return { value: plaintext, valueEncrypted: null };
  return { value: "", valueEncrypted: await encryptSecret(plaintext) };
}

/**
 * Resolve the effective plaintext of a variable row: the encrypted column
 * when present, else the legacy plaintext column.
 */
export async function variableValueForRead(row: {
  readonly value: string;
  readonly valueEncrypted?: string | null;
}): Promise<string> {
  if (row.valueEncrypted !== null && row.valueEncrypted !== undefined && row.valueEncrypted !== "") {
    return decryptSecret(row.valueEncrypted);
  }
  return row.value;
}

/**
 * True when a row still stores its sensitive value in the legacy plaintext
 * column (needs migration on next write).
 */
export function sensitiveValueNeedsMigration(row: {
  readonly value: string;
  readonly valueEncrypted?: string | null;
  readonly sensitive?: boolean | null;
}): boolean {
  return row.sensitive === true && !isEncryptedSecret(row.valueEncrypted ?? "") && row.value !== "";
}
