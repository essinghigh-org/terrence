import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ENCRYPTED_PREFIX = "enc:v1";
const KEY_FILE_NAME = ".encryption-key";
const KEY_LENGTH = 32;

let cachedKey: Buffer | undefined;

async function loadEncryptionKey(): Promise<Buffer> {
  if (cachedKey !== undefined) return cachedKey;

  const password = process.env.ENCRYPTION_PASSWORD;
  if (password !== undefined && password !== "") {
    cachedKey = scryptSync(password, "terrence:secrets:v1", KEY_LENGTH);
    return cachedKey;
  }

  const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"));
  const keyPath = join(storageDir, KEY_FILE_NAME);
  await mkdir(storageDir, { recursive: true });

  try {
    cachedKey = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    const generated = randomBytes(KEY_LENGTH);
    try {
      const keyFile = await open(keyPath, "wx", 0o600);
      try {
        await keyFile.writeFile(generated.toString("base64"));
      } finally {
        await keyFile.close();
      }
      cachedKey = generated;
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      cachedKey = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
    }
  }

  if (cachedKey.length !== KEY_LENGTH) {
    throw new Error(`Invalid encryption key in ${keyPath}`);
  }
  return cachedKey;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${ENCRYPTED_PREFIX}:`);
}

export async function encryptSecret(value: string): Promise<string> {
  if (isEncryptedSecret(value)) return value;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await loadEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTED_PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export async function decryptSecret(value: string): Promise<string> {
  if (!isEncryptedSecret(value)) return value;

  const [, , ivEncoded, tagEncoded, ciphertextEncoded] = value.split(":");
  if (ivEncoded === undefined || tagEncoded === undefined || ciphertextEncoded === undefined) {
    throw new Error("Invalid encrypted secret");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    await loadEncryptionKey(),
    Buffer.from(ivEncoded, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
