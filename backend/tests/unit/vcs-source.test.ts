import { describe, expect, test } from "bun:test";
import {
  configuredVcsSourceIdentity,
  vcsSourceMatchesConnection,
  vcsSourceIdentity,
} from "../../src/lib/vcs-source";

describe("VCS source identity", () => {
  test("canonicalizes provider API aliases without losing enterprise hosts", () => {
    expect(vcsSourceIdentity("github", "https://github.com/acme/project.git")).toEqual({
      provider: "github",
      host: "github.com",
    });
    expect(vcsSourceIdentity("github", "https://api.github.com/repos/acme/project")).toEqual({
      provider: "github",
      host: "github.com",
    });
    expect(vcsSourceIdentity("github", "https://github.example/acme/project.git")).toEqual({
      provider: "github",
      host: "github.example",
    });
    expect(vcsSourceIdentity("bitbucket", "https://api.bitbucket.org/2.0/repositories/acme/project")).toEqual({
      provider: "bitbucket",
      host: "bitbucket.org",
    });
  });

  test("uses the configured source URL before the API URL", () => {
    expect(configuredVcsSourceIdentity(
      "github",
      "github_enterprise",
      "https://github.example/api/v3",
      "https://github.example",
      12345,
    )).toEqual({ provider: "github", host: "github.example", installationId: 12345 });
    expect(configuredVcsSourceIdentity("github", "github", null, null)).toEqual({
      provider: "github",
      host: "github.com",
    });
    expect(configuredVcsSourceIdentity("gitlab", "gitlab", null, null)).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
    });
  });

  test("rejects non-source URLs and URLs containing ambiguous authority data", () => {
    expect(vcsSourceIdentity("github", "git@github.com:acme/project.git")).toBeUndefined();
    expect(vcsSourceIdentity("github", "https://user:password@github.com/acme/project.git")).toBeUndefined();
    expect(vcsSourceIdentity("github", "https://github.com/acme/project?ref=main")).toBeUndefined();
    expect(vcsSourceIdentity("github", "https://github.com/acme/project#main")).toBeUndefined();
    expect(vcsSourceIdentity("github", "http://github.example/acme/project", 12345, true)).toBeUndefined();
    expect(configuredVcsSourceIdentity(
      "github",
      "github_enterprise",
      "http://github.example/api/v3",
      null,
      12345,
      true,
    )).toBeUndefined();
  });

  test("compares provider hosts and requires App installation identities", () => {
    const github = vcsSourceIdentity("github", "https://github.com/acme/project", 12345);
    const sameInstallation = vcsSourceIdentity("github", "https://api.github.com/repos/acme/project", 12345);
    const otherInstallation = vcsSourceIdentity("github", "https://github.com/acme/project", 67890);
    const gitlab = vcsSourceIdentity("gitlab", "https://github.com/acme/project");
    if (github === undefined || sameInstallation === undefined || otherInstallation === undefined || gitlab === undefined) {
      throw new Error("test source identities should be valid");
    }
    expect(vcsSourceMatchesConnection(github, sameInstallation)).toBe(true);
    expect(vcsSourceMatchesConnection(github, otherInstallation)).toBe(false);
    expect(vcsSourceMatchesConnection(github, { provider: "github", host: "github.com" })).toBe(false);
    expect(vcsSourceMatchesConnection({ provider: "github", host: "github.com" }, github)).toBe(true);
    expect(vcsSourceMatchesConnection(github, gitlab)).toBe(false);
  });
});
