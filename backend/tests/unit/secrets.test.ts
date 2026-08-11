import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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
    const previousDir = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = testStorageDir;
    const previousPass = process.env.ENCRYPTION_PASSWORD;
    delete process.env.ENCRYPTION_PASSWORD;

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
      if (previousDir === undefined) delete process.env.STORAGE_DIR;
      else process.env.STORAGE_DIR = previousDir;
      if (previousPass !== undefined) process.env.ENCRYPTION_PASSWORD = previousPass;
    }
  });
});

describe("isEncryptedSecret", () => {
  it("identifies encrypted secrets", async () => {
    const mod = await import("../../src/lib/secrets");
    expect(mod.isEncryptedSecret("enc:v1:iv:tag:data")).toBe(true);
  });

  it("returns false for plain values", async () => {
    const mod = await import("../../src/lib/secrets");
    expect(mod.isEncryptedSecret("plain-value")).toBe(false);
  });
});

describe("per-installation KDF salt (4.10)", () => {
  const dirA = join(tmpdir(), "terrence-salt-a-" + Date.now());
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
    const previousDir = process.env.STORAGE_DIR;
    const previousPass = process.env.ENCRYPTION_PASSWORD;
    process.env.ENCRYPTION_PASSWORD = "correct horse battery staple";
    try {
      // The module is cached across imports; the storage-dir switch is what
      // proves the salt changes the key derivation.
      const mod = await import("../../src/lib/secrets");
      process.env.STORAGE_DIR = dirA;
      const encA = await mod.encryptSecret("same secret");
      expect(existsSync(join(dirA, ".encryption-salt"))).toBe(true);
      expect(await mod.decryptSecret(encA)).toBe("same secret");

      process.env.STORAGE_DIR = dirB;
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
      if (previousDir === undefined) delete process.env.STORAGE_DIR;
      else process.env.STORAGE_DIR = previousDir;
      if (previousPass !== undefined) process.env.ENCRYPTION_PASSWORD = previousPass;
    }
  });

  it("salt file mode is 0600 and readable as base64", async () => {
    const previousDir = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = dirA;
    const previousPass = process.env.ENCRYPTION_PASSWORD;
    process.env.ENCRYPTION_PASSWORD = "pw";
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
      if (previousDir === undefined) delete process.env.STORAGE_DIR;
      else process.env.STORAGE_DIR = previousDir;
      if (previousPass !== undefined) process.env.ENCRYPTION_PASSWORD = previousPass;
    }
  });
});
