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

export const ENCRYPTED_PREFIX = "enc:v1";
const KEY_FILE_NAME = ".encryption-key";
const SALT_FILE_NAME = ".encryption-salt";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

type PasswordKdfOptions = Readonly<{ ["N"]: number; r: number; p: number; maxmem: number }>;

// scrypt's memory cost is intentionally explicit. Node's default N=2^14 is
// too small for a key protecting Terraform state; these parameters use the
// current OWASP baseline while staying within a bounded 256 MiB allocation.
export const PASSWORD_KDF_OPTIONS: PasswordKdfOptions = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
};

// Existing installations used Node's implicit N=2^14 setting. Keep this only
// for read compatibility; all newly derived keys use PASSWORD_KDF_OPTIONS.
const LEGACY_PASSWORD_KDF_OPTIONS: PasswordKdfOptions = {
  N: 2 ** 14,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

let cachedKey: Buffer | undefined;
let cachedStorageDir: string | undefined;
let cachedLegacyPasswordKey: Buffer | undefined;
let cachedLegacyPasswordKeyStorageDir: string | undefined;
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

/** Equal to true after loadKdfSalt() had to create a new salt (no prior salt on disk). */
let saltWasRecreatedOnLoad = false;

/**
 * True when the current process created the KDF salt because none existed. A
 * fresh salt silently changes the derived key for every ENCRYPTION_PASSWORD,
 * which would make previously-encrypted secrets undecryptable — so callers
 * (startup/bootstrapping) can detect a lost or non-persistent STORAGE_DIR and
 * warn or abort. Only exported for startup diagnostics.
 */
/** @public Intentional surface: benchmark/test hook or cross-module API. */
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
  const currentStorageDir = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"));
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
const SYNC_READ_RETRIES = 20;
const SYNC_READ_RETRY_DELAY_MS = 25;

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

async function loadEncryptionKey(): Promise<Buffer> {
  const currentStorageDir = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"));
  if (cachedStorageDir !== currentStorageDir) {
    cachedKey = undefined;
    cachedKeyInFlight = undefined;
    cachedKeyInFlightDir = undefined;
    cachedLegacyPasswordKey = undefined;
    cachedLegacyPasswordKeyStorageDir = undefined;
    cachedStorageDir = currentStorageDir;
  }
  if (cachedKey !== undefined) return cachedKey;

  const password = process.env["ENCRYPTION_PASSWORD"];
  if (password !== undefined && password !== "") {
    cachedKey = scryptSync(password, await loadKdfSalt(), KEY_LENGTH, PASSWORD_KDF_OPTIONS);
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
    const storageDir = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"));
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
      // A concurrent creator may have written a truncated file; retry once
      // before failing so a transient partial write does not brick the node.
      key = await readExistingKeyWithRetry(keyPath);
      if (key.length !== KEY_LENGTH) throw new Error(`Invalid encryption key in ${keyPath}`);
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

async function loadLegacyPasswordKey(): Promise<Buffer> {
  const currentStorageDir = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"));
  if (cachedLegacyPasswordKey !== undefined && cachedLegacyPasswordKeyStorageDir === currentStorageDir) {
    return cachedLegacyPasswordKey;
  }
  const password = process.env["ENCRYPTION_PASSWORD"];
  if (password === undefined || password === "") {
    throw new Error("Legacy password-derived key requested without ENCRYPTION_PASSWORD");
  }
  cachedLegacyPasswordKey = scryptSync(password, await loadKdfSalt(), KEY_LENGTH, LEGACY_PASSWORD_KDF_OPTIONS);
  cachedLegacyPasswordKeyStorageDir = currentStorageDir;
  return cachedLegacyPasswordKey;
}

export function isEncryptedSecret(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== ENCRYPTED_PREFIX) return false;
  // Do not classify arbitrary user plaintext beginning with `enc:v1:` as a
  // ciphertext envelope. GCM envelopes always carry a 12-byte IV and 16-byte
  // authentication tag; an empty ciphertext is valid for an empty secret.
  return Buffer.from(parts[2] ?? "", "base64").length === 12
    && Buffer.from(parts[3] ?? "", "base64").length === 16;
}

export async function encryptSecret(value: string, options: Readonly<{ force?: boolean }> = {}): Promise<string> {
  if (options.force !== true && isEncryptedSecret(value)) return value;

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

  const primaryKey = await loadEncryptionKey();
  try {
    return decrypt(primaryKey);
  } catch (primaryError) {
    const password = process.env["ENCRYPTION_PASSWORD"];
    if (password === undefined || password === "") throw primaryError;
    try {
      return decrypt(await loadLegacyPasswordKey());
    } catch {
      throw primaryError;
    }
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

  const resolvedDir = resolve(storageDir);
  const primaryKey = loadEncryptionKeySync(resolvedDir);
  try {
    return decrypt(primaryKey);
  } catch (primaryError) {
    const password = process.env["ENCRYPTION_PASSWORD"];
    if (password === undefined || password === "") throw primaryError;
    try {
      return decrypt(loadPasswordDerivedKeySync(resolvedDir, password, LEGACY_PASSWORD_KDF_OPTIONS));
    } catch {
      throw primaryError;
    }
  }
}

type MaterialLengthMode = "minimum" | "exact";

function readBase64MaterialSync(path: string, expectedLength: number, lengthMode: MaterialLengthMode): Buffer | undefined {
  let material: Buffer | undefined;
  for (let attempt = 0; attempt < SYNC_READ_RETRIES; attempt += 1) {
    try {
      const candidate = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
      const valid = lengthMode === "minimum" ? candidate.length >= expectedLength : candidate.length === expectedLength;
      if (valid) {
        material = candidate;
        break;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EINTR") throw error;
    }
    if (attempt + 1 < SYNC_READ_RETRIES) Bun.sleepSync(SYNC_READ_RETRY_DELAY_MS);
  }
  return material;
}

function loadPasswordDerivedKeySync(
  resolvedDir: string,
  password: string,
  options: PasswordKdfOptions = PASSWORD_KDF_OPTIONS,
): Buffer {
  const saltPath = join(resolvedDir, SALT_FILE_NAME);
  let salt: Buffer | undefined;
  try {
    salt = readBase64MaterialSync(saltPath, SALT_LENGTH, "minimum");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Cannot decrypt storage secret: KDF salt not found at ${saltPath}. ` +
        "Persist STORAGE_DIR whenever ENCRYPTION_PASSWORD is configured.",
      );
    }
    throw error;
  }
  const resolvedSalt = salt ?? Buffer.alloc(0);
  if (resolvedSalt.length < SALT_LENGTH) {
    throw new Error(`Invalid KDF salt in ${saltPath}`);
  }
  if (saltWasRecreatedOnLoad) {
    log.warn(KDF_SALT_RECREATED_WARNING);
    saltWasRecreatedOnLoad = false;
  }
  return scryptSync(password, resolvedSalt, KEY_LENGTH, options);
}

function loadFileEncryptionKeySync(resolvedDir: string): Buffer {
  const keyPath = join(resolvedDir, KEY_FILE_NAME);
  let key: Buffer | undefined;
  try {
    key = readBase64MaterialSync(keyPath, KEY_LENGTH, "exact");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Cannot decrypt storage secret: encryption key not found at ${keyPath}. ` +
        "The boot config references a URL secret, but no key exists in storage.",
      );
    }
    throw error;
  }
  const resolvedKey = key ?? Buffer.alloc(0);
  if (resolvedKey.length !== KEY_LENGTH) {
    throw new Error(`Invalid encryption key in ${keyPath}`);
  }
  return resolvedKey;
}

function loadEncryptionKeySync(storageDir: string): Buffer {
  const resolvedDir = resolve(storageDir);

  // Reuse the async loader's cache when the directory matches: a key
  // already loaded by encryptSecret/decryptSecret is valid here too.
  if (cachedKey !== undefined && cachedStorageDir === resolvedDir) {
    return cachedKey;
  }

  const password = process.env["ENCRYPTION_PASSWORD"];
  const key = password !== undefined && password !== ""
    ? loadPasswordDerivedKeySync(resolvedDir, password)
    : loadFileEncryptionKeySync(resolvedDir);
  cachedKey = key;
  cachedStorageDir = resolvedDir;
  return key;
}
