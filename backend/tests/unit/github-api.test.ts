import { afterEach, describe, expect, it } from "bun:test";
import { githubAppApiBase } from "../../src/lib/github-api";

const originalAppUrl = process.env["GITHUB_APP_API_URL"];
const originalGeneralUrl = process.env["GITHUB_API_URL"];

afterEach((): void => {
  if (originalAppUrl === undefined) delete process.env["GITHUB_APP_API_URL"];
  else process.env["GITHUB_APP_API_URL"] = originalAppUrl;
  if (originalGeneralUrl === undefined) delete process.env["GITHUB_API_URL"];
  else process.env["GITHUB_API_URL"] = originalGeneralUrl;
});

describe("GitHub App API URL resolution", () => {
  it("prefers the App URL over the general GitHub URL", () => {
    process.env["GITHUB_APP_API_URL"] = "https://github-enterprise.example/api/v3/";
    process.env["GITHUB_API_URL"] = "https://api.github.com";
    expect(githubAppApiBase(true)).toBe("https://github-enterprise.example/api/v3");
  });

  it("uses the general URL and then the public default", () => {
    delete process.env["GITHUB_APP_API_URL"];
    process.env["GITHUB_API_URL"] = "https://github.example/api/v3/";
    expect(githubAppApiBase(true)).toBe("https://github.example/api/v3");
    delete process.env["GITHUB_API_URL"];
    expect(githubAppApiBase(true)).toBe("https://api.github.com");
  });

  it("rejects unsafe or non-HTTPS App URLs when required", () => {
    process.env["GITHUB_APP_API_URL"] = "http://github.example/api/v3";
    expect(githubAppApiBase(true)).toBeUndefined();
    expect(githubAppApiBase(false)).toBe("http://github.example/api/v3");
  });
});
