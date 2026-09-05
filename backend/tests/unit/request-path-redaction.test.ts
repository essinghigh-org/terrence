import { describe, expect, it } from "bun:test";
import { redactPathSecrets } from "../../src/app";

// Issue #609: replayable bearer material in URL paths must never reach log
// sinks verbatim — the never-expiring run log capability token (polled
// repeatedly by the UI) and the invitation accept token.
describe("request path secret redaction (#609)", () => {
  it("redacts run log capability tokens", () => {
    expect(redactPathSecrets("/api/v2/runs/abc123/plan/log/secret-token-value")).toBe(
      "/api/v2/runs/abc123/plan/log/[REDACTED]",
    );
    expect(redactPathSecrets("/api/v2/runs/abc123/apply/log/secret-token-value")).toBe(
      "/api/v2/runs/abc123/apply/log/[REDACTED]",
    );
  });

  it("redacts invitation accept tokens", () => {
    expect(redactPathSecrets("/api/v2/organization-invitations/invite-token-xyz/accept")).toBe(
      "/api/v2/organization-invitations/[REDACTED]/accept",
    );
  });

  it("leaves ordinary paths and query strings alone", () => {
    expect(redactPathSecrets("/api/v2/workspaces/ws-1/runs")).toBe("/api/v2/workspaces/ws-1/runs");
    expect(redactPathSecrets("/api/v2/runs/abc123/plan/log")).toBe("/api/v2/runs/abc123/plan/log");
    expect(redactPathSecrets("/healthz")).toBe("/healthz");
    expect(redactPathSecrets("/api/v2/runs/abc123/apply/log/tok?token=abc")).toBe(
      "/api/v2/runs/abc123/apply/log/[REDACTED]?token=abc",
    );
  });
});
