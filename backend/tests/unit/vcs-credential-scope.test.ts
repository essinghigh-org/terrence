import { describe, expect, it } from "bun:test";
import { gitExtraHeaderConfigKey, vcsCredentialOrigin } from "../../src/lib/vcs-credential-scope";

describe("VCS credential origin scoping", (): void => {
  it("uses the hosted GitHub clone origin rather than api.github.com", (): void => {
    expect(vcsCredentialOrigin("github", "https://api.github.com", null)).toBe("https://github.com");
    expect(gitExtraHeaderConfigKey("github", "https://api.github.com", null)).toBe(
      "http.https://github.com/.extraHeader",
    );
  });

  it("uses the hosted GitLab origin", (): void => {
    expect(vcsCredentialOrigin("gitlab_hosted", "https://gitlab.com/api/v4", null)).toBe("https://gitlab.com");
  });

  it("prefers an explicitly configured enterprise HTTP origin", (): void => {
    expect(
      vcsCredentialOrigin("github_enterprise", "https://github.example.test/api/v3", "https://github.example.test/"),
    ).toBe("https://github.example.test");
  });

  it("falls back to the API origin for enterprise providers when needed", (): void => {
    expect(vcsCredentialOrigin("gitlab_enterprise_edition", "https://gitlab.example.test/api/v4", null)).toBe(
      "https://gitlab.example.test",
    );
  });

  it("fails closed when no trustworthy HTTPS origin is available", (): void => {
    expect(vcsCredentialOrigin("ado_server", null, null)).toBeNull();
    expect(gitExtraHeaderConfigKey("ado_server", "file:///tmp/vcs", null)).toBeNull();
    expect(gitExtraHeaderConfigKey("github_enterprise", "not a url", null)).toBeNull();
    expect(vcsCredentialOrigin("github_enterprise", "http://github.example.test/api/v3", null)).toBeNull();
    expect(gitExtraHeaderConfigKey("gitlab_enterprise_edition", null, "http://gitlab.example.test/")).toBeNull();
  });
});

it("scopes Azure DevOps Git headers to a canonical organization path, never the shared origin", (): void => {
  expect(gitExtraHeaderConfigKey("ado_services", "https://dev.azure.com", "https://dev.azure.com/acme", "ACME")).toBe(
    "http.https://dev.azure.com/acme/.extraHeader",
  );
  for (const value of [undefined, "", "other", "acme/../other"])
    expect(gitExtraHeaderConfigKey("ado_services", "https://dev.azure.com/acme", null, value)).toBeNull();
  expect(gitExtraHeaderConfigKey("ado_services", "https://dev.azure.com/other", null, "acme")).toBeNull();
  expect(gitExtraHeaderConfigKey("ado_services", "https://dev.azure.com/acme", "https://evil.test", "acme")).toBeNull();
});

it("Git matches the Azure organization credential key without matching sibling tenants", async (): Promise<void> => {
  const key = gitExtraHeaderConfigKey("ado_services", null, null, "acme");
  if (key === null) throw new Error("Missing organization credential key");
  for (const [url, matched] of [
    ["https://dev.azure.com/acme/project/_git/repo", true],
    ["https://dev.azure.com/other/project/_git/repo", false],
    ["https://dev.azure.com/acme-extra/project/_git/repo", false],
  ] as const) {
    const process = Bun.spawn(
      ["git", "-c", `${key}=fixture-header`, "config", "--get-urlmatch", "http.extraHeader", url],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await process.exited).toBe(matched ? 0 : 1);
    expect(await new Response(process.stdout).text()).toBe(matched ? "fixture-header\n" : "");
  }
});
