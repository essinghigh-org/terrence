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
const SALT_FILE_NAME = ".encryption-salt";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// Salt used by installations created before per-installation KDF salts
// existed. Kept only to decrypt secrets written under the old scheme;
// new encryptions always use the per-installation random salt.
const LEGACY_KDF_SALT = "terrence:secrets:v1";

let cachedKey: Buffer | undefined;
let cachedStorageDir: string | undefined;
let cachedKdfSalt: Buffer | undefined;
let cachedKdfSaltStorageDir: string | undefined;
let cachedLegacyKey: Buffer | undefined;

/**
 * Per-installation random KDF salt for ENCRYPTION_PASSWORD-derived keys.
 * Stored next to the key file so every installation derives a different
 * key from the same password (task 4.10); created with O_EXCL so two
 * concurrent processes race safely.
 */
async function loadKdfSalt(): Promise<Buffer> {
  const currentStorageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"));
  if (cachedKdfSaltStorageDir !== currentStorageDir) {
    cachedKdfSalt = undefined;
    cachedKdfSaltStorageDir = currentStorageDir;
  }
  if (cachedKdfSalt !== undefined) return cachedKdfSalt;

  const saltPath = join(currentStorageDir, SALT_FILE_NAME);
  await mkdir(currentStorageDir, { recursive: true });

  try {
    cachedKdfSalt = Buffer.from((await readFile(saltPath, "utf8")).trim(), "base64");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    const generated = randomBytes(SALT_LENGTH);
    try {
      const saltFile = await open(saltPath, "wx", 0o600);
      try {
        await saltFile.writeFile(generated.toString("base64"));
      } finally {
        await saltFile.close();
      }
      cachedKdfSalt = generated;
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      cachedKdfSalt = Buffer.from((await readFile(saltPath, "utf8")).trim(), "base64");
    }
  }

  if (cachedKdfSalt.length < SALT_LENGTH) {
    throw new Error(`Invalid KDF salt in ${saltPath}`);
  }
  return cachedKdfSalt;
}

function legacyEncryptionKey(password: string): Buffer {
  cachedLegacyKey ??= scryptSync(password, LEGACY_KDF_SALT, KEY_LENGTH);
  return cachedLegacyKey;
}

async function loadEncryptionKey(): Promise<Buffer> {
  const currentStorageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"));
  if (cachedStorageDir !== currentStorageDir) {
    cachedKey = undefined;
    cachedStorageDir = currentStorageDir;
  }
  if (cachedKey !== undefined) return cachedKey;

  const password = process.env.ENCRYPTION_PASSWORD;
  if (password !== undefined && password !== "") {
    cachedKey = scryptSync(password, await loadKdfSalt(), KEY_LENGTH);
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

  const iv = Buffer.from(ivEncoded, "base64");
  const tag = Buffer.from(tagEncoded, "base64");
  const ciphertext = Buffer.from(ciphertextEncoded, "base64");

  const decrypt = (key: Buffer): string => {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  };

  try {
    return decrypt(await loadEncryptionKey());
  } catch (error) {
    // Secrets written before per-installation KDF salts derived the key
    // from a static salt. GCM authentication makes a wrong key fail here,
    // so retry with the legacy derivation before surfacing the error.
    const password = process.env.ENCRYPTION_PASSWORD;
    if (password !== undefined && password !== "") {
      try {
        return decrypt(legacyEncryptionKey(password));
      } catch {
        // fall through to the primary error
      }
    }
    throw error;
  }
}
