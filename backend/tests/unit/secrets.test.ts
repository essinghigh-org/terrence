import { createCipheriv, scryptSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testStorageDir = join(tmpdir(), "terrence-secrets-test-" + Date.now());

describe("loadEncryptionKey ENOENT handling", () => {
  beforeEach(() => {
    if (existsSync(testStorageDir)) rmSync(testStorageDir, { recursive: true, force: true });
    mkdirSync(testStorageDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testStorageDir)) rmSync(testStorageDir, { recursive: true, force: true });
  });

  it("generates a new key file when none exists (ENOENT path)", async () => {
    const previousDir = process.env["STORAGE_DIR"];
    process.env["STORAGE_DIR"] = testStorageDir;
    const previousPass = process.env["ENCRYPTION_PASSWORD"];
    delete process.env["ENCRYPTION_PASSWORD"];

    try {
      const mod = await import("../../src/lib/secrets");

      const keyPath = join(testStorageDir, ".encryption-key");
      expect(existsSync(keyPath)).toBe(false);

      const encrypted = await mod.encryptSecret("hello");
      expect(typeof encrypted).toBe("string");
      expect(encrypted.startsWith("enc:v1:")).toBe(true);
      expect(existsSync(keyPath)).toBe(true);

      const decrypted = await mod.decryptSecret(encrypted);
      expect(decrypted).toBe("hello");
    } finally {
      if (previousDir === undefined) delete process.env["STORAGE_DIR"];
      else process.env["STORAGE_DIR"] = previousDir;
      if (previousPass !== undefined) process.env["ENCRYPTION_PASSWORD"] = previousPass;
    }
  });
});

describe("isEncryptedSecret", () => {
  it("identifies encrypted secrets", async () => {
    const mod = await import("../../src/lib/secrets");
    expect(mod.isEncryptedSecret(`enc:v1:${Buffer.alloc(12).toString("base64")}:${Buffer.alloc(16).toString("base64")}:data`)).toBe(true);
  });

  it("returns false for plain values", async () => {
    const mod = await import("../../src/lib/secrets");
    expect(mod.isEncryptedSecret("plain-value")).toBe(false);
  });
  it("force-encrypts plaintext that mimics an encrypted envelope", async () => {
    const mod = await import("../../src/lib/secrets");
    const forged = `enc:v1:${Buffer.alloc(12).toString("base64")}:${Buffer.alloc(16).toString("base64")}:plaintext-secret`;

    expect(await mod.encryptSecret(forged)).toBe(forged);
    const encrypted = await mod.encryptSecret(forged, { force: true });
    expect(encrypted).not.toBe(forged);
    expect(mod.isEncryptedSecret(encrypted)).toBe(true);
    expect(await mod.decryptSecret(encrypted)).toBe(forged);
  });
});

describe("per-installation KDF salt (4.10)", () => {
  const dirA = mkdtempSync(join(tmpdir(), "terrence-salt-a-"));
  const dirB = join(tmpdir(), "terrence-salt-b-" + Date.now());

  beforeEach(() => {
    for (const dir of [dirA, dirB]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    for (const dir of [dirA, dirB]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a .encryption-salt file and derives a deterministic key per engine instance", async () => {
    const previousDir = process.env["STORAGE_DIR"];
    const previousPass = process.env["ENCRYPTION_PASSWORD"];
    process.env["ENCRYPTION_PASSWORD"] = "correct horse battery staple";
    try {
      // The module is cached across imports; the storage-dir switch is what
      // proves the salt changes the key derivation.
      const mod = await import("../../src/lib/secrets");
      process.env["STORAGE_DIR"] = dirA;
      const encA = await mod.encryptSecret("same secret");
      expect(existsSync(join(dirA, ".encryption-salt"))).toBe(true);
      expect(await mod.decryptSecret(encA)).toBe("same secret");

      process.env["STORAGE_DIR"] = dirB;
      const encB = await mod.encryptSecret("same secret");
      expect(existsSync(join(dirB, ".encryption-salt"))).toBe(true);
      expect(await mod.decryptSecret(encB)).toBe("same secret");

      // Salt files are random and differ across storage dirs, so the same
      // password derives different keys: each ciphertext must decrypt under
      // its own dir but cross-decryption must fail (wrong key).
      const saltA = readFileSync(join(dirA, ".encryption-salt"), "utf8");
      const saltB = readFileSync(join(dirB, ".encryption-salt"), "utf8");
      expect(saltA).not.toBe(saltB);
    } finally {
      if (previousDir === undefined) delete process.env["STORAGE_DIR"];
      else process.env["STORAGE_DIR"] = previousDir;
      if (previousPass !== undefined) process.env["ENCRYPTION_PASSWORD"] = previousPass;
    }
  });

  it("salt file mode is 0600 and readable as base64", async () => {
    const previousDir = process.env["STORAGE_DIR"];
    process.env["STORAGE_DIR"] = dirA;
    const previousPass = process.env["ENCRYPTION_PASSWORD"];
    process.env["ENCRYPTION_PASSWORD"] = "pw";
    try {
      const mod = await import("../../src/lib/secrets");
      await mod.encryptSecret("hello");
      const saltPath = join(dirA, ".encryption-salt");
      const { statSync, readFileSync } = await import("node:fs");
      const st = statSync(saltPath);
      // 0600 (owner read/write only)
      expect(st.mode & 0o777).toBe(0o600);
      const salt = readFileSync(saltPath, "utf8").trim();
      expect(() => Buffer.from(salt, "base64")).not.toThrow();
      expect(Buffer.from(salt, "base64").length).toBeGreaterThanOrEqual(16);
    } finally {
      if (previousDir === undefined) delete process.env["STORAGE_DIR"];
      else process.env["STORAGE_DIR"] = previousDir;
      if (previousPass !== undefined) process.env["ENCRYPTION_PASSWORD"] = previousPass;
    }
  });
});

describe("concurrent cold-start key creation (policy_vcs_sync regression)", () => {
  it("serializes concurrent encryptSecret calls on a fresh storage dir so none reads a half-written key", async () => {
    const previousDir = process.env["STORAGE_DIR"];
    const previousPass = process.env["ENCRYPTION_PASSWORD"];
    // A unique fresh dir ensures a true cold start (no pre-existing key).
    const coldDir = join(tmpdir(), "terrence-concurrent-cold-" + Date.now() + "-" + crypto.randomUUID());
    process.env["STORAGE_DIR"] = coldDir;
    delete process.env["ENCRYPTION_PASSWORD"];

    try {
      const mod = await import("../../src/lib/secrets");

      // Fire many callers at once on a missing key file, mirroring the
      // Promise.all(providers.map(... encryptSecret ...)) in policy_vcs_sync.
      const values = Array.from({ length: 16 }, (_, i) => `payload-${i}`);
      const results = await Promise.all(values.map((v) => mod.encryptSecret(v)));

      // Every call must round-trip under the same key.
      const decrypts = await Promise.all(results.map((c) => mod.decryptSecret(c).then((d) => d)));
      expect(decrypts).toEqual(values);

      // The key file is present, exactly one, and has the correct length.
      const keyPath = join(coldDir, ".encryption-key");
      expect(existsSync(keyPath)).toBe(true);
      const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
      expect(key.length).toBe(32); // KEY_LENGTH

      expect(results.length).toBe(16);
    } finally {
      if (previousDir === undefined) delete process.env["STORAGE_DIR"];
      else process.env["STORAGE_DIR"] = previousDir;
      if (previousPass === undefined) delete process.env["ENCRYPTION_PASSWORD"];
      else process.env["ENCRYPTION_PASSWORD"] = previousPass;
      rmSync(coldDir, { recursive: true, force: true });
    }
  });
});

describe("password-derived KDF parameters", () => {
  it("uses memory-hard parameters stronger than the legacy Node defaults", async () => {
    const mod = await import("../../src/lib/secrets");
    expect(mod.PASSWORD_KDF_OPTIONS).toMatchObject({ N: 2 ** 17, r: 8, p: 1 });
    expect(mod.PASSWORD_KDF_OPTIONS.maxmem).toBeGreaterThan(128 * 1024 * 1024);
  });

  it("decrypts ciphertext made with the legacy KDF parameters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terrence-legacy-kdf-"));
    const previousDir = process.env["STORAGE_DIR"];
    const previousPass = process.env["ENCRYPTION_PASSWORD"];
    const password = "legacy-kdf-password";
    const plaintext = "state encrypted before the KDF upgrade";
    const salt = Buffer.alloc(16, 7);
    const iv = Buffer.alloc(12, 9);
    process.env["STORAGE_DIR"] = dir;
    process.env["ENCRYPTION_PASSWORD"] = password;

    try {
      writeFileSync(join(dir, ".encryption-salt"), salt.toString("base64"), { mode: 0o600 });
      const legacyKey = scryptSync(password, salt, 32, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const envelope = [
        "enc:v1",
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        ciphertext.toString("base64"),
      ].join(":");
      const mod = await import("../../src/lib/secrets");

      expect(await mod.decryptSecret(envelope)).toBe(plaintext);
      expect(mod.decryptSecretSync(envelope, dir)).toBe(plaintext);
    } finally {
      if (previousDir === undefined) delete process.env["STORAGE_DIR"];
      else process.env["STORAGE_DIR"] = previousDir;
      if (previousPass === undefined) delete process.env["ENCRYPTION_PASSWORD"];
      else process.env["ENCRYPTION_PASSWORD"] = previousPass;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
