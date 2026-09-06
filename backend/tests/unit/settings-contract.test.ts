import { describe, expect, test } from "bun:test";
import { throws } from "node:assert/strict";
import { configurationReportValue, SettingsValidationError, validateSettings } from "../../src/lib/settings-contract";

describe("persisted configuration contract", (): void => {
  test("validates maintenance clocks, timezones, and webhook URLs", (): void => {
    const window = { days: [1, 2], "start-time": "09:00", "end-time": "17:00", timezone: "Europe/London" };
    validateSettings("maintenance-windows", { enabled: true, windows: [window] });
    for (const invalid of [{ ...window, timezone: "private-marker" }, { ...window, days: [7] }, { ...window, "start-time": "25:00" }]) {
      throws((): void => { validateSettings("maintenance-windows", { windows: [invalid] }); }, (error: unknown): boolean => error instanceof SettingsValidationError && !error.message.includes("private-marker"));
    }
    throws((): void => { validateSettings("approval-webhook", { url: "https://user:private-marker@example.com" }); }, SettingsValidationError);
    validateSettings("approval-webhook", { url: "https://example.com/hook?token=value" });
    throws((): void => { validateSettings("plan-explainer", { "reasoning-effort": "hgh" }); }, SettingsValidationError);
    throws((): void => { validateSettings("logging", { error: "caller metadata" }); }, SettingsValidationError);
  });
  test("rejects incomplete or contradictory enabled authentication", (): void => {
    for (const values of [
      { enabled: true },
      { enabled: true, issuer: "https://example.com", "client-id": "client" },
      { enabled: true, issuer: "https://example.com", "client-id": "client", "pkce-method": "S256", "signing-alg": "HS256" },
      { issuer: "https://user:private-marker@example.com" },
      { "signing-alg": "none" },
    ]) throws((): void => { validateSettings("oidc", values, true); }, SettingsValidationError);
    validateSettings("oidc", { enabled: true, issuer: "https://example.com", "client-id": "client", "pkce-method": "S256" });
    throws((): void => { validateSettings("ldap", { enabled: true, host: "ldap.example.com", "base-dn": "dc=example", "bind-dn": "cn=service" }); }, SettingsValidationError);
    validateSettings("ldap", { enabled: true, host: "ldap.example.com", "base-dn": "dc=example" });
    expect(configurationReportValue("oidc", "client-secret", "private-marker")).toBe("[redacted]");
    expect(configurationReportValue("ldap", "bind-password", "private-marker")).toBe("[redacted]");
  });
  test("validates SMTP enums and ports and redacts report strings", (): void => {
    for (const values of [{ port: 0 }, { port: 65536 }, { encryption: "starttl" }, { auth: "private-marker" }, { password: 123 }]) {
      throws((): void => { validateSettings("smtp", values, true); }, (error: unknown): boolean => error instanceof SettingsValidationError && !error.message.includes("private-marker"));
    }
    validateSettings("smtp", { port: 465, encryption: "tls", auth: "login", password: "private-marker" });
    expect(configurationReportValue("smtp", "password", "private-marker")).toBe("[redacted]");
    expect(configurationReportValue("smtp", "password", null)).toBeNull();
    expect(configurationReportValue("smtp", "port", 465)).toBe(465);
  });
  test("rejects invalid types, ranges, names, and header syntax", (): void => {
    for (const values of [
      { "plan-timeout": 0 }, { "plan-timeout": -1 }, { "apply-timeout": 1.5 },
      { "api-rate-limit": Infinity }, { "local-auth-enabled": "false" },
      { "local-signup-enabled": "private-marker" }, { "private-marker": true },
      { "trusted-client-ip-headers": ["x-forwarded-for\r\nprivate-marker"] },
      JSON.parse('{"__proto__":[]}') as Record<string, unknown>,
    ]) {
      throws((): void => { validateSettings("general", values, true); }, (error: unknown): boolean => {
        return error instanceof SettingsValidationError && error.status === 422 && !error.message.includes("private-marker");
      });
    }
    validateSettings("general", { "plan-timeout": 60, "local-signup-enabled": null, "trusted-client-ip-headers": ["x-forwarded-for"] });
    validateSettings("retention", { "delete-older-than-n-days": null });
  });

  test("distinguishes broken stored configuration from rejected input", (): void => {
    throws((): void => { validateSettings("general", { "plan-timeout": -1 }); }, (error: unknown): boolean => {
      return error instanceof SettingsValidationError && error.status === 503;
    });
    expect((): void => { validateSettings("retention", { "delete-older-than-n-days": 7 }); }).not.toThrow();
  });
});
