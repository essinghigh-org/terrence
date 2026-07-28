import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
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
