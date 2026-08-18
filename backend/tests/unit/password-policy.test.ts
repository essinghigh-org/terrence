import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  checkPasswordPolicy,
  defaultPasswordPolicy,
  loadPasswordPolicy,
  type PasswordPolicyRules,
} from "../../src/lib/password-policy";

describe("Configurable password policy (kanban 5.5)", () => {
  describe("default policy", () => {
    it("enforces at least 10 characters by default (unchanged behavior)", () => {
      expect(checkPasswordPolicy(defaultPasswordPolicy, "short").ok).toBeFalse();
      expect(checkPasswordPolicy(defaultPasswordPolicy, "1234567890").ok).toBeTrue();
    });

    it("does not require upper/lower/digit/symbol by default", () => {
      // 10 lowercase letters satisfy the default policy.
      expect(checkPasswordPolicy(defaultPasswordPolicy, "abcdefghij").ok).toBeTrue();
    });
  });

  describe("strict rules", () => {
    const strict: PasswordPolicyRules = {
      ...defaultPasswordPolicy,
      requireUpper: true,
      requireLower: true,
      requireDigit: true,
      requireSymbol: true,
    };

    it("accepts a password satisfying every rule", () => {
      const result = checkPasswordPolicy(strict, "Abcdef1!xyz");
      expect(result.ok).toBeTrue();
      expect(result.errors).toHaveLength(0);
    });

    it("rejects a password missing each required class with a specific message", () => {
      expect(checkPasswordPolicy(strict, "ABCDEF1!XYZ").errors).toContain("Password must contain at least one lowercase letter");
      expect(checkPasswordPolicy(strict, "abcdef1!xyz").errors).toContain("Password must contain at least one uppercase letter");
      expect(checkPasswordPolicy(strict, "Abcdef!xyz").errors).toContain("Password must contain at least one digit");
      expect(checkPasswordPolicy(strict, "Abcdef1xyz").errors).toContain("Password must contain at least one symbol");
    });

    it("aggregates multiple failures into a single result", () => {
      const result = checkPasswordPolicy(strict, "abcdef");
      expect(result.ok).toBeFalse();
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("bcrypt 72-byte input limit", () => {
    it("rejects passwords exceeding 72 UTF-8 bytes", () => {
      const longAscii = "a".repeat(73);
      expect(checkPasswordPolicy(defaultPasswordPolicy, longAscii).ok).toBeFalse();
      expect(checkPasswordPolicy(defaultPasswordPolicy, longAscii).errors).toContain("Password must be at most 72 bytes when encoded as UTF-8");
    });

    it("accepts a password of exactly 72 bytes", () => {
      expect(checkPasswordPolicy(defaultPasswordPolicy, "a".repeat(72)).ok).toBeTrue();
    });

    it("counts multibyte characters by encoded byte length, not string length", () => {
      // 24 emoji (empty "😀" is 4 bytes) => 96 UTF-8 bytes, well over 72, but
      // only 24 JS code units.
      const multibyte = "😀".repeat(24);
      expect(multibyte.length).toBeLessThan(72);
      expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(72);
      expect(checkPasswordPolicy(defaultPasswordPolicy, multibyte).ok).toBeFalse();
    });
  });

  describe("configurable minimum length", () => {
    it("uses the configured minimum length", () => {
      const tight: PasswordPolicyRules = { ...defaultPasswordPolicy, minLength: 16 };
      expect(checkPasswordPolicy(tight, "123456789012345").ok).toBeFalse();
      expect(checkPasswordPolicy(tight, "1234567890123456").ok).toBeTrue();
    });
  });

  describe("disallow-username rule", () => {
    const noUsername: PasswordPolicyRules = { ...defaultPasswordPolicy, disallowUsername: true };

    it("rejects a password containing the username (case-insensitive)", () => {
      expect(checkPasswordPolicy(noUsername, "henry-auth-token-123", "henry").ok).toBeFalse();
      expect(checkPasswordPolicy(noUsername, "HENRY-auth-token-123", "henry").ok).toBeFalse();
    });

    it("ignores the username when disallow rule is off", () => {
      expect(checkPasswordPolicy(defaultPasswordPolicy, "henry-auth-token-123", "henry").ok).toBeTrue();
    });
  });

  describe("env-driven policy loading", () => {
    const originalEnv: Record<string, string | undefined> = {
      TERRENCE_PASSWORD_MIN_LENGTH: process.env.TERRENCE_PASSWORD_MIN_LENGTH,
      TERRENCE_PASSWORD_REQUIRE_UPPER: process.env.TERRENCE_PASSWORD_REQUIRE_UPPER,
      TERRENCE_PASSWORD_REQUIRE_LOWER: process.env.TERRENCE_PASSWORD_REQUIRE_LOWER,
      TERRENCE_PASSWORD_REQUIRE_DIGIT: process.env.TERRENCE_PASSWORD_REQUIRE_DIGIT,
      TERRENCE_PASSWORD_REQUIRE_SYMBOL: process.env.TERRENCE_PASSWORD_REQUIRE_SYMBOL,
      TERRENCE_PASSWORD_DISALLOW_USERNAME: process.env.TERRENCE_PASSWORD_DISALLOW_USERNAME,
    };

    beforeAll(() => {
      process.env.TERRENCE_PASSWORD_MIN_LENGTH = "14";
      process.env.TERRENCE_PASSWORD_REQUIRE_UPPER = "true";
      process.env.TERRENCE_PASSWORD_REQUIRE_DIGIT = "1";
    });

    afterAll(() => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("loads policy from env vars", () => {
      const policy = loadPasswordPolicy();
      expect(policy.minLength).toBe(14);
      expect(policy.requireUpper).toBeTrue();
      expect(policy.requireDigit).toBeTrue();
      expect(policy.requireLower).toBeFalse();
      expect(policy.requireSymbol).toBeFalse();
      // The effective policy rejects a 10-char password.
      expect(checkPasswordPolicy(policy, "1234567890").ok).toBeFalse();
    });
  });
});