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

  it("fails closed when no trustworthy HTTP(S) origin is available", (): void => {
    expect(vcsCredentialOrigin("ado_server", null, null)).toBeNull();
    expect(gitExtraHeaderConfigKey("ado_server", "file:///tmp/vcs", null)).toBeNull();
    expect(gitExtraHeaderConfigKey("github_enterprise", "not a url", null)).toBeNull();
  });
});
