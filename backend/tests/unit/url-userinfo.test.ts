import { describe, expect, it } from "bun:test";
import { resolveExternalUrl } from "../../src/lib/url-safety";

describe("URL userinfo rejection (kanban 18)", () => {
  it("rejects user:password@host URLs", async (): Promise<void> => {
    const result = await resolveExternalUrl("https://user:password@example.com/webhook");
    expect("error" in result && result.error.includes("embedded credentials")).toBeTrue();
  });

  it("rejects bare user@host URLs even without a password", async (): Promise<void> => {
    const result = await resolveExternalUrl("https://user@example.com/hook");
    expect("error" in result && result.error.includes("embedded credentials")).toBeTrue();
  });

  it("rejects password-only userinfo", async (): Promise<void> => {
    const result = await resolveExternalUrl("https://:secret@example.com/hook");
    expect("error" in result && result.error.includes("embedded credentials")).toBeTrue();
  });

  it("still accepts plain https URLs with @ elsewhere in the query", async (): Promise<void> => {
    // The @ sits in the query string, not the authority component.
    const result = await resolveExternalUrl("https://example.com/hook?email=a@b.example");
    expect("target" in result).toBeTrue();
  });

  it("still rejects private hosts before userinfo would matter (order irrelevant, both fail)", async (): Promise<void> => {
    const withCreds = await resolveExternalUrl("https://user:pass@169.254.169.254/latest/meta-data");
    expect("error" in withCreds).toBeTrue();
    // With allowPrivate the userinfo check still applies.
    const credsAllowed = await resolveExternalUrl("https://user:pass@127.0.0.1/x", true);
    expect("error" in credsAllowed && credsAllowed.error.includes("embedded credentials")).toBeTrue();
  });
});
