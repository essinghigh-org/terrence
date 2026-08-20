import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "./log";

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
// In-flight guard for the cold file-key load. Under test setups (and any burst
// of first-time encryptSecret calls) several callers can hit a missing key file
// concurrently; without a shared promise each one races the filesystem and the
// EEXIST fallback can read a half-written key (-> "Invalid encryption key").
// Serialize the create/read so only the first caller touches the file and every
// concurrent caller awaits the same result.
let cachedKeyInFlight: Promise<Buffer> | undefined;
let cachedKeyInFlightDir: string | undefined;
let cachedKdfSalt: Buffer | undefined;
let cachedKdfSaltStorageDir: string | undefined;
let cachedLegacyKey: Buffer | undefined;
let cachedLegacyPassword: string | undefined;

/** Equal to true after loadKdfSalt() had to create a new salt (no prior salt on disk). */
let saltWasRecreatedOnLoad = false;

/**
 * True when the current process created the KDF salt because none existed. A
 * fresh salt silently changes the derived key for every ENCRYPTION_PASSWORD,
 * which would make previously-encrypted secrets undecryptable — so callers
 * (startup/bootstrapping) can detect a lost or non-persistent STORAGE_DIR and
 * warn or abort. Only exported for startup diagnostics.
 */
export function didRecreateKdfSalt(): boolean {
  return saltWasRecreatedOnLoad;
}

/** Warning the operator sees if a KDF salt was freshly created this boot. */
export const KDF_SALT_RECREATED_WARNING =
  "[terrence] Created a new KDF salt in STORAGE_DIR. If this is not a fresh installation, STORAGE_DIR is not persistent and previously-encrypted secrets cannot be decrypted. Persist STORAGE_DIR (bind-mount/volume) whenever ENCRYPTION_PASSWORD is configured.";

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
      // We just minted a salt where none existed. If encrypted secrets already
      // exist this is a lost/non-persistent STORAGE_DIR and must be surfaced.
      saltWasRecreatedOnLoad = true;
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      // A concurrent process created the file. The concurrent writer may not
      // have finished writing yet (open(path, "wx") → write is not atomic with
      // creation), so retry a bounded number of times rather than treating a
      // transient partial/empty file as the final salt.
      cachedKdfSalt = await readExistingSaltWithRetry(saltPath);
    }
  }

  if (cachedKdfSalt.length < SALT_LENGTH) {
    throw new Error(`Invalid KDF salt in ${saltPath}`);
  }
  return cachedKdfSalt;
}

const SALT_READ_RETRIES = 20;
const SALT_READ_RETRY_DELAY_MS = 25;

// Key-file concurrent-read retry (todo 150): same bounded-retry contract as
// readExistingSaltWithRetry — a concurrent creator may not have finished
// writing when EEXIST is observed.
const KEY_READ_RETRIES = 20;
const KEY_READ_RETRY_DELAY_MS = 25;

async function readExistingKeyWithRetry(keyPath: string): Promise<Buffer> {
  for (let attempt = 0; attempt < KEY_READ_RETRIES; attempt += 1) {
    if (attempt > 0) await new Promise<void>((resolveDelay): void => { setTimeout(resolveDelay, KEY_READ_RETRY_DELAY_MS); });
    try {
      const key = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
      if (key.length === KEY_LENGTH) return key;
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
    }
  }
  throw new Error(`Invalid encryption key in ${keyPath} (concurrent write never completed)`);
}

async function readExistingSaltWithRetry(saltPath: string): Promise<Buffer> {
  for (let attempt = 0; attempt < SALT_READ_RETRIES; attempt += 1) {
    if (attempt > 0) await new Promise<void>((resolveDelay): void => { setTimeout(resolveDelay, SALT_READ_RETRY_DELAY_MS); });
    try {
      const salt = Buffer.from((await readFile(saltPath, "utf8")).trim(), "base64");
      if (salt.length >= SALT_LENGTH) return salt;
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
    }
  }
  // Give up: the file is persistently absent or below the valid length. Callers
  // surface the "Invalid KDF salt" error; failing closed is correct here.
  throw new Error(`Invalid KDF salt in ${saltPath} (concurrent write never completed)`);
}

function legacyEncryptionKey(password: string): Buffer {
  // Key is cached per password so a process that re-reads ENCRYPTION_PASSWORD
  // after a config change derives a fresh key instead of returning the stale
  // cached one (the decrypt fallback calls this with the current password).
  if (cachedLegacyPassword !== password || cachedLegacyKey === undefined) {
    cachedLegacyKey = scryptSync(password, LEGACY_KDF_SALT, KEY_LENGTH);
    cachedLegacyPassword = password;
  }
  return cachedLegacyKey;
}

async function loadEncryptionKey(): Promise<Buffer> {
  const currentStorageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"));
  if (cachedStorageDir !== currentStorageDir) {
    cachedKey = undefined;
    cachedKeyInFlight = undefined;
    cachedKeyInFlightDir = undefined;
    cachedStorageDir = currentStorageDir;
  }
  if (cachedKey !== undefined) return cachedKey;

  const password = process.env.ENCRYPTION_PASSWORD;
  if (password !== undefined && password !== "") {
    cachedKey = scryptSync(password, await loadKdfSalt(), KEY_LENGTH);
    if (saltWasRecreatedOnLoad) {
      log.warn(KDF_SALT_RECREATED_WARNING);
      saltWasRecreatedOnLoad = false; // warn once per boot
    }
    return cachedKey;
  }

  // Join an in-flight cold load for the same directory instead of racing the
  // filesystem (a second reader could observe a half-written key file).
  if (cachedKeyInFlight !== undefined && cachedKeyInFlightDir === currentStorageDir) {
    return cachedKeyInFlight;
  }

  cachedKeyInFlightDir = currentStorageDir;
  cachedKeyInFlight = (async (): Promise<Buffer> => {
    const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"));
    const keyPath = join(storageDir, KEY_FILE_NAME);
    await mkdir(storageDir, { recursive: true });

    let key: Buffer;
    try {
      key = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
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
        key = generated;
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
        // Another caller created the file concurrently. Like the KDF salt
        // path (todo 150), the concurrent writer may not have finished
        // writing (open "wx" → write is not atomic with creation), so retry
        // a bounded number of times instead of treating a transient
        // partial/empty file as the final key.
        key = await readExistingKeyWithRetry(keyPath);
      }
    }

    if (key.length !== KEY_LENGTH) {
      throw new Error(`Invalid encryption key in ${keyPath}`);
    }
    return key;
  })().finally(() => {
    if (cachedKeyInFlightDir === currentStorageDir) {
      cachedKeyInFlight = undefined;
      cachedKeyInFlightDir = undefined;
    }
  });

  cachedKey = await cachedKeyInFlight;
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

/**
 * Synchronous counterpart of decryptSecret, used at boot time by the boot
 * configuration resolver (lib/boot-config.ts). db/index.ts must stay
 * synchronous (a top-level await made it a TLA module and broke Bun worker
 * threads), so URL secrets cannot go through the async fs/promises path.
 *
 * Unlike the async loader, this never CREATES key material: a missing key
 * or salt at boot is a configuration error (the file was written by the
 * wizard through encryptSecret, which mints the key/salt first). Fail fast
 * with a message naming the missing file.
 */
export function decryptSecretSync(value: string, storageDir: string): string {
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
    return decrypt(loadEncryptionKeySync(storageDir));
  } catch (error) {
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

function loadEncryptionKeySync(storageDir: string): Buffer {
  const resolvedDir = resolve(storageDir);

  // Reuse the async loader's cache when the directory matches: a key
  // already loaded by encryptSecret/decryptSecret is valid here too.
  if (cachedKey !== undefined && cachedStorageDir === resolvedDir) {
    return cachedKey;
  }

  const password = process.env.ENCRYPTION_PASSWORD;
  if (password !== undefined && password !== "") {
    const saltPath = join(resolvedDir, SALT_FILE_NAME);
    let saltText: string;
    try {
      saltText = readFileSync(saltPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Cannot decrypt storage secret: KDF salt not found at ${saltPath}. ` +
          "Persist STORAGE_DIR whenever ENCRYPTION_PASSWORD is configured.",
        );
      }
      throw error;
    }
    const salt = Buffer.from(saltText.trim(), "base64");
    if (salt.length < SALT_LENGTH) {
      throw new Error(`Invalid KDF salt in ${saltPath}`);
    }
    const key = scryptSync(password, salt, KEY_LENGTH);
    cachedKey = key;
    cachedStorageDir = resolvedDir;
    return key;
  }

  const keyPath = join(resolvedDir, KEY_FILE_NAME);
  let keyText: string;
  try {
    keyText = readFileSync(keyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Cannot decrypt storage secret: encryption key not found at ${keyPath}. ` +
        "The boot config references a URL secret, but no key exists in storage.",
      );
    }
    throw error;
  }
  const key = Buffer.from(keyText.trim(), "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Invalid encryption key in ${keyPath}`);
  }
  cachedKey = key;
  cachedStorageDir = resolvedDir;
  return key;
}
