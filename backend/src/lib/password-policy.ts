// Configurable local password policy (kanban 5.5).
//
// The default policy keeps the long-standing minimum of 10 characters, so
// behavior is unchanged unless an operator opts into stricter rules via env
// vars. Rules are additive and per-instance:
//
//   TERRENCE_PASSWORD_MIN_LENGTH        minimum rune length (default 10)
//   TERRENCE_PASSWORD_REQUIRE_UPPER     require >= 1 uppercase [A-Z]      (default false)
//   TERRENCE_PASSWORD_REQUIRE_LOWER     require >= 1 lowercase [a-z]      (default false)
//   TERRENCE_PASSWORD_REQUIRE_DIGIT     require >= 1 digit [0-9]          (default false)
//   TERRENCE_PASSWORD_REQUIRE_SYMBOL    require >= 1 non-alphanumeric     (default false)
//   TERRENCE_PASSWORD_DISALLOW_USERNAME reject passwords containing the    (default false)
//                                        username (case-insensitive) when set
//
// All configuration is read once at module load. This module is pure and
// framework-free so it can be unit-tested without a server.

export interface PasswordPolicyRules {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  disallowUsername: boolean;
}

export function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function loadPasswordPolicy(): PasswordPolicyRules {
  const rawMin = process.env.TERRENCE_PASSWORD_MIN_LENGTH;
  const parsedMin = rawMin === undefined || rawMin === "" ? NaN : Number(rawMin);
  const minLength = Number.isFinite(parsedMin) && parsedMin >= 1 ? Math.floor(parsedMin) : 10;
  return {
    minLength,
    requireUpper: boolEnv("TERRENCE_PASSWORD_REQUIRE_UPPER", false),
    requireLower: boolEnv("TERRENCE_PASSWORD_REQUIRE_LOWER", false),
    requireDigit: boolEnv("TERRENCE_PASSWORD_REQUIRE_DIGIT", false),
    requireSymbol: boolEnv("TERRENCE_PASSWORD_REQUIRE_SYMBOL", false),
    disallowUsername: boolEnv("TERRENCE_PASSWORD_DISALLOW_USERNAME", false),
  };
}

export interface PasswordCheckResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a candidate password against the configured policy. `username` is
 * only consulted when the disallow-username rule is enabled.
 */
export function checkPasswordPolicy(
  policy: PasswordPolicyRules,
  password: string,
  username?: string,
): PasswordCheckResult {
  const errors: string[] = [];
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);

  if (password.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters`);
  }
  if (policy.requireUpper && !hasUpper) {
    errors.push("Password must contain at least one uppercase letter");
  }
  if (policy.requireLower && !hasLower) {
    errors.push("Password must contain at least one lowercase letter");
  }
  if (policy.requireDigit && !hasDigit) {
    errors.push("Password must contain at least one digit");
  }
  if (policy.requireSymbol && !hasSymbol) {
    errors.push("Password must contain at least one symbol");
  }
  if (policy.disallowUsername && username !== undefined && username.length > 0) {
    const lower = username.toLowerCase();
    if (password.toLowerCase().includes(lower)) {
      errors.push("Password must not contain the username");
    }
  }
  return { ok: errors.length === 0, errors };
}

export const defaultPasswordPolicy: PasswordPolicyRules = {
  minLength: 10,
  requireUpper: false,
  requireLower: false,
  requireDigit: false,
  requireSymbol: false,
  disallowUsername: false,
};