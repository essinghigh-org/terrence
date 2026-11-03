import { afterEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  fetchAzureDevOpsArchive,
  fetchAzureDevOpsDefaultBranch,
  fetchAzureDevOpsLatestCommit,
  fetchAzureDevOpsTags,
  fetchAzureDevOpsUrl,
} from "../../src/lib/azure-devops";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";
import { azureDevOpsZipFixture } from "../fixtures/ado-zip";

const credentials = { organization: "acme", token: "test-pat", apiUrl: "https://dev.azure.com/acme" };
const repository = "acme/My Project/_git/repo";
const commit = "a".repeat(40);
const base = "https://dev.azure.com/acme/My%20Project/_apis/git/repositories/repo";
afterEach(() => {
  setExternalUrlTransportForTests(undefined);
});

describe("Azure DevOps PAT transport", () => {
  test("sends Basic auth only to the bound HTTPS organization and encodes repository names once", async () => {
    let calls = 0;
    setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
      calls++;
      expect(target.url).toBe(`${base}?api-version=7.1`);
      expect(init.headers?.["Authorization"]).toBe(`Basic ${Buffer.from(":test-pat").toString("base64")}`);
      expect(init.headers?.["Authorization"]).not.toContain("test-pat");
      return Response.json({ defaultBranch: "refs/heads/release/current" });
    });
    expect(await fetchAzureDevOpsDefaultBranch(credentials, repository)).toBe("release/current");
    for (const url of [
      "http://dev.azure.com/acme/path",
      "https://dev.azure.com/other/path",
      "https://evil.test/acme/path",
      "https://dev.azure.com/acme%2fother/path",
      "https://user@dev.azure.com/acme/path",
      "https://dev.azure.com/acme/path%2F..%2Fother",
      "https://dev.azure.com/acme/path#fragment",
    ])
      expect(fetchAzureDevOpsUrl(credentials, url)).rejects.toThrow("organization-scoped URL");
    expect(fetchAzureDevOpsUrl({ ...credentials, httpUrl: "https://dev.azure.com/other" }, base)).rejects.toThrow();
    expect(fetchAzureDevOpsArchive(credentials, "other/project/_git/repo", commit)).rejects.toThrow("repository");
    expect(calls).toBe(1);
  });

  test.each([301, 302, 303, 307, 308])(
    "refuses redirect status %s even within the same organization",
    async (status) => {
      let calls = 0;
      setExternalUrlTransportForTests(async (): Promise<Response> => {
        calls++;
        return new Response(null, { status, headers: { Location: `${base}/redirect` } });
      });
      expect(fetchAzureDevOpsUrl(credentials, base)).rejects.toThrow("redirects are not permitted");
      expect(calls).toBe(1);
    },
  );

  test("never guesses a default branch when repository metadata is missing or malformed", async () => {
    for (const body of [
      {},
      { defaultBranch: "main" },
      { defaultBranch: "refs/heads/" },
      { defaultBranch: "refs/tags/release" },
    ]) {
      setExternalUrlTransportForTests(async (): Promise<Response> => Response.json(body));
      expect(await fetchAzureDevOpsDefaultBranch(credentials, repository)).toBeUndefined();
    }
    setExternalUrlTransportForTests(async (): Promise<Response> => new Response("denied", { status: 403 }));
    expect(await fetchAzureDevOpsDefaultBranch(credentials, repository)).toBeUndefined();
  });

  test("resolves the exact branch through bounded continuation pages, not a prefix match", async () => {
    let calls = 0;
    setExternalUrlTransportForTests(async (target): Promise<Response> => {
      calls++;
      const url = new URL(target.url);
      expect(url.searchParams.get("filter")).toBe("heads/main");
      expect(url.searchParams.get("$top")).toBe("100");
      return calls === 1
        ? Response.json(
            { value: [{ name: "refs/heads/main-old", objectId: "b".repeat(40) }] },
            { headers: { "x-ms-continuationtoken": "next+page" } },
          )
        : Response.json({ value: [{ name: "refs/heads/main", objectId: commit }] });
    });
    expect(await fetchAzureDevOpsLatestCommit(credentials, repository, "main")).toBe(commit);
    expect(calls).toBe(2);
    setExternalUrlTransportForTests(
      async (): Promise<Response> => Response.json({ value: [{ name: "refs/heads/main-old", objectId: commit }] }),
    );
    expect(await fetchAzureDevOpsLatestCommit(credentials, repository, "main")).toBeUndefined();
  });

  test("rejects repeated pagination, duplicate exact refs, and invalid SHA data", async () => {
    setExternalUrlTransportForTests(
      async (): Promise<Response> => Response.json({ value: [] }, { headers: { "x-ms-continuationtoken": "repeat" } }),
    );
    expect(fetchAzureDevOpsLatestCommit(credentials, repository, "main")).rejects.toThrow("Repeated");
    setExternalUrlTransportForTests(
      async (): Promise<Response> =>
        Response.json({
          value: [
            { name: "refs/heads/main", objectId: commit },
            { name: "refs/heads/main", objectId: commit },
          ],
        }),
    );
    expect(await fetchAzureDevOpsLatestCommit(credentials, repository, "main")).toBeUndefined();
    setExternalUrlTransportForTests(
      async (): Promise<Response> => Response.json({ value: [{ name: "refs/heads/main", objectId: "not-a-sha" }] }),
    );
    expect(fetchAzureDevOpsLatestCommit(credentials, repository, "main")).rejects.toThrow("Invalid Azure DevOps ref");
  });

  test("peels annotated tags to immutable commit IDs", async () => {
    setExternalUrlTransportForTests(async (target): Promise<Response> => {
      expect(new URL(target.url).searchParams.get("peelTags")).toBe("true");
      return Response.json({ value: [{ name: "refs/tags/v1.0.0", objectId: "b".repeat(40), peeledObjectId: commit }] });
    });
    expect(await fetchAzureDevOpsTags(credentials, repository)).toEqual([{ name: "v1.0.0", sha: commit }]);
  });

  test("downloads the immutable commit ZIP and debits actual bytes in a shared budget", async () => {
    const bytes = azureDevOpsZipFixture([{ name: "main.tf", data: "terraform {}", descriptor: true }]);
    const budget = { remainingBytes: 2048 };
    setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
      const url = new URL(target.url);
      expect(url.pathname).toBe(new URL(base).pathname + "/items");
      expect(url.searchParams.get("versionDescriptor.versionType")).toBe("commit");
      expect(url.searchParams.get("versionDescriptor.version")).toBe(commit);
      expect(url.searchParams.get("$format")).toBe("zip");
      expect(init.maxResponseBytes).toBe(2048);
      return new Response(Buffer.from(bytes));
    });
    const archive = await fetchAzureDevOpsArchive(credentials, repository, commit, {}, undefined, budget);
    expect(gunzipSync(archive).subarray(512, 524).toString()).toBe("terraform {}");
    expect(budget.remainingBytes).toBe(2048 - bytes.length);
  });

  test("fails closed on HTTP errors, expanded ZIP limits, overflow, and exhausted budget", async () => {
    const budget = { remainingBytes: 1024 };
    setExternalUrlTransportForTests(
      async (): Promise<Response> => new Response("secret provider response", { status: 403 }),
    );
    expect(fetchAzureDevOpsArchive(credentials, repository, commit, {}, undefined, budget)).rejects.toThrow("HTTP 403");
    expect(budget.remainingBytes).toBe(0);
    expect(fetchAzureDevOpsArchive(credentials, repository, commit, {}, undefined, budget)).rejects.toThrow(
      "budget exhausted",
    );
    setExternalUrlTransportForTests(
      async (): Promise<Response> =>
        new Response(Buffer.from(azureDevOpsZipFixture([{ name: "a", data: "a".repeat(4096) }]))),
    );
    expect(fetchAzureDevOpsArchive(credentials, repository, commit, { maxFileBytes: 32 })).rejects.toThrow(
      "expanded byte limit",
    );
    expect(fetchAzureDevOpsArchive(credentials, repository, commit, { maxCompressedBytes: 32 })).rejects.toThrow(
      "byte limit",
    );
  });
});
