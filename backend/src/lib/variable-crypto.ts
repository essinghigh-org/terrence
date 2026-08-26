import { encryptSecret, decryptSecret } from "./secrets";

// Sensitive-variable value encryption: `sensitive=true` rows store their
// value ONLY in value_encrypted (enc:v1); the plaintext column keeps "".
// Non-sensitive rows keep plaintext in `value` with a null encrypted column.
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
 * Resolve the effective plaintext of a variable row: decrypt the encrypted
 * column for sensitive rows; non-sensitive rows are stored plaintext.
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
