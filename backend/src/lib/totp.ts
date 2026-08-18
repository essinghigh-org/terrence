import { createHmac, randomBytes } from "node:crypto";

// RFC 6238 TOTP — HMAC-SHA1, 6 digits, 30s period. No external deps.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(bytes = 20): string {
  const buffer = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? "";
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function otpauthUrl(secret: string, account: string, issuer = "Terrence"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer is the idiomatic HMAC key type and Readonly<Buffer> is rejected by node:crypto.
function hotp(key: Buffer, counter: number): number {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary = (((hmac[offset] ?? 0) & 0x7f) << 24)
    | (((hmac[offset + 1] ?? 0) & 0xff) << 16)
    | (((hmac[offset + 2] ?? 0) & 0xff) << 8)
    | ((hmac[offset + 3] ?? 0) & 0xff);
  return binary % 1_000_000;
}

export function verifyTotp(secret: string, code: string, window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secret);
  if (key.length === 0) return false;
  const counter = Math.floor(Date.now() / 30_000);
  const expected = Number.parseInt(code, 10);
  for (let offset = -window; offset <= window; offset++) {
    if (hotp(key, counter + offset) === expected) return true;
  }
  return false;
}

/** Generate a fresh TOTP code for a secret (used in tests). */
export function generateTotpCode(secret: string, atMs = Date.now(), offset = 0): string {
  const key = base32Decode(secret);
  const counter = Math.floor(atMs / 30_000) + offset;
  return hotp(key, counter).toString().padStart(6, "0");
}
