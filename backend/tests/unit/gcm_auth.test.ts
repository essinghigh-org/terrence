import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("GCM auth-tag failure handling (#312)", () => {
  const dir = mkdtempSync(join(tmpdir(), "terrence-gcm-"));
  let previousDir: string | undefined;
  let previousPass: string | undefined;

  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    previousDir = process.env.STORAGE_DIR;
    previousPass = process.env.ENCRYPTION_PASSWORD;
    process.env.STORAGE_DIR = dir;
    delete process.env.ENCRYPTION_PASSWORD;
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousDir;
    if (previousPass === undefined) delete process.env.ENCRYPTION_PASSWORD;
    else process.env.ENCRYPTION_PASSWORD = previousPass;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });

  it("tampered ciphertext is not returned as plaintext (fail-closed)", async () => {
    const { encryptSecret } = await import("../../src/lib/secrets");
    const { decodeStatePayload } = await import("../../src/lib/validation");

    const encrypted = await encryptSecret(JSON.stringify({ version: 4, serial: 1 }));
    expect(encrypted.startsWith("enc:v1:")).toBe(true);

    // Tamper with the tag (flip a byte) - should cause GCM auth failure
    const parts = encrypted.split(":");
    expect(parts.length).toBe(5);
    const tag = Buffer.from(parts[3]!, "base64");
    tag[0] = tag[0]! ^ 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${tag.toString("base64")}:${parts[4]}`;

    let threw = false;
    try {
      decodeStatePayload(tampered);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Ensure it is not silently returned as the envelope
    if (!threw) {
      const result = decodeStatePayload(tampered);
      expect(result).not.toBe(tampered);
    }
  });

  it("valid encrypted payload still decodes", async () => {
    const { encryptSecret } = await import("../../src/lib/secrets");
    const { decodeStatePayload, parseStatePayload } = await import("../../src/lib/validation");

    const payload = JSON.stringify({ version: 4, resources: [] });
    const encrypted = await encryptSecret(payload);
    const decoded = decodeStatePayload(encrypted);
    expect(decoded).toBe(payload);
    expect(parseStatePayload(encrypted)).toEqual(JSON.parse(payload));
  });

  it("plain JSON still decodes and tampered plain is not misclassified as encrypted", async () => {
    const { decodeStatePayload } = await import("../../src/lib/validation");
    const plain = JSON.stringify({ version: 4 });
    expect(decodeStatePayload(plain)).toBe(plain);
    // enc-like but not valid GCM (short parts) should be treated as plain, not throw as encrypted
    const fake = "enc:v1:short:short:short";
    expect(decodeStatePayload(fake)).toBe(fake);
  });
});
