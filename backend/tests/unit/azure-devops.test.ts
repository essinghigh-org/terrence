import { describe, expect, test } from "bun:test";
import {
  azureDevOpsBaseUrl,
  azureDevOpsOrganization,
  azureDevOpsPatAuthorization,
  azureDevOpsRepositoryApiUrl,
  azureDevOpsRepositoryHttpUrl,
  azureDevOpsSourceOrganization,
  parseAzureDevOpsRepository,
} from "../../src/lib/azure-devops";

describe("Azure DevOps Services endpoint security", () => {
  test("requires explicit canonical organization", () => {
    expect(azureDevOpsOrganization("ACME-1")).toBe("acme-1");
    for (const value of [
      undefined,
      null,
      "",
      " acme",
      "acme/other",
      "acme%2fother",
      ".",
      "-acme",
      "acme-",
      "a".repeat(51),
    ])
      expect(azureDevOpsOrganization(value)).toBeUndefined();
    expect(azureDevOpsBaseUrl("acme")).toBe("https://dev.azure.com/acme");
    expect(azureDevOpsBaseUrl("acme", "https://dev.azure.com")).toBe("https://dev.azure.com/acme");
    expect(azureDevOpsBaseUrl("acme", "https://dev.azure.com/ACME/")).toBe("https://dev.azure.com/acme");
  });
  test("does not trust caller-controlled hosts, tenants, ports, or credentials", () => {
    for (const url of [
      "https://evil.test/acme",
      "http://dev.azure.com/acme",
      "https://dev.azure.com:8443/acme",
      "https://user:pass@dev.azure.com/acme",
      "https://dev.azure.com/other",
      "https://dev.azure.com/acme/project",
      "https://dev.azure.com/acme?x=1",
      "https://dev.azure.com/acme#x",
      "https://dev.azure.com/acme%2fother",
      "https://dev.azure.com\\@evil.test/acme",
      "https://acme.visualstudio.com",
    ]) {
      expect(azureDevOpsBaseUrl("acme", url)).toBeUndefined();
    }
    expect(azureDevOpsBaseUrl(undefined, "https://dev.azure.com/acme")).toBeUndefined();
  });
  test("parses upstream four-segment identifier and encodes names once", () => {
    expect(parseAzureDevOpsRepository("ACME/My Project/_git/my repo", "acme")).toEqual({
      organization: "acme",
      project: "My Project",
      repository: "my repo",
    });
    expect(azureDevOpsRepositoryApiUrl("acme/My Project/_git/my repo", "acme")).toBe(
      "https://dev.azure.com/acme/My%20Project/_apis/git/repositories/my%20repo",
    );
    expect(azureDevOpsRepositoryHttpUrl("acme/My Project/_git/my repo", "acme")).toBe(
      "https://dev.azure.com/acme/My%20Project/_git/my%20repo",
    );
    for (const identifier of [
      "project/repo",
      "acme/project/repo",
      "other/project/_git/repo",
      "acme/../_git/repo",
      "acme/project/_git/..",
      "acme/project/_git/%2e%2e",
      "acme/project/_git/repo?x=1",
      "acme/project/_git/a\\b",
      "acme/project/_git/repo/extra",
      "acme/project/_git/ repo",
      "acme/project/_git/repo\n",
    ]) {
      expect(azureDevOpsRepositoryApiUrl(identifier, "acme")).toBeUndefined();
    }
  });
  test("source identity requires HTTPS shared origin and an organization", () => {
    expect(azureDevOpsSourceOrganization("https://dev.azure.com/Acme/project/_git/repo")).toBe("acme");
    for (const url of [
      "https://dev.azure.com",
      "https://evil.test/acme",
      "http://dev.azure.com/acme",
      "https://dev.azure.com/acme?x=1",
      "https://user@dev.azure.com/acme",
      "https://dev.azure.com/%61cme",
    ])
      expect(azureDevOpsSourceOrganization(url)).toBeUndefined();
  });
  test("PAT headers contain no raw secret and reject control/whitespace input", () => {
    expect(azureDevOpsPatAuthorization("test-pat")).toBe(`Basic ${Buffer.from(":test-pat").toString("base64")}`);
    for (const token of ["", " a", "a\nHeader:x", "a b", "a".repeat(4097)])
      expect(azureDevOpsPatAuthorization(token)).toBeUndefined();
  });
});
