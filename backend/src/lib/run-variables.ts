import { storageDir } from "../db/driver";
import { decryptSecretSync, encryptSecret, isEncryptedSecret } from "./secrets";

/** Input has already passed the run API validator; never accept client ciphertext. */
export async function runVariablesForWrite(variables: readonly { readonly key: string; readonly value: string; readonly category?: string; readonly sensitive?: boolean }[]): Promise<{ key: string; value: string; category?: string; sensitive?: boolean; valueEncrypted?: string }[]> {
  return Promise.all(variables.map(async ({ key, value, category, sensitive }) => ({
    key,
    value: sensitive === true ? "" : value,
    ...(category === undefined ? {} : { category }),
    ...(sensitive === undefined ? {} : { sensitive }),
    ...(sensitive === true ? { valueEncrypted: await encryptSecret(value, { force: true }) } : {}),
  })));
}

export function normalizeRunVariables(variables: unknown): { key: string; value: string; category: string; sensitive: boolean }[] {
  if (!Array.isArray(variables)) return [];
  const normalized: { key: string; value: string; category: string; sensitive: boolean }[] = [];
  for (const item of variables) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Readonly<Record<string, unknown>>;
    if (typeof record["key"] !== "string" || typeof record["value"] !== "string") continue;
    if (record["valueEncrypted"] !== undefined && (typeof record["valueEncrypted"] !== "string" || !isEncryptedSecret(record["valueEncrypted"]))) {
      throw new Error("Invalid encrypted run variable");
    }
    normalized.push({
      key: record["key"],
      value: typeof record["valueEncrypted"] === "string"
        ? decryptSecretSync(record["valueEncrypted"], storageDir)
        : record["value"],
      category: record["category"] === "env" ? "env" : "terraform",
      sensitive: record["sensitive"] === true,
    });
  }
  return normalized;
}
