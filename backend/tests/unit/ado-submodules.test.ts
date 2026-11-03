import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { fetchAzureDevOpsSubmoduleArchive } from "../../src/lib/ado-submodules";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";

const credentials = { organization: "acme", token: "test-pat" };
const revision = "a".repeat(40);
const childRevision = "b".repeat(40);
const treeId = "c".repeat(40);
const childTreeId = "d".repeat(40);
const repo = "acme/project/_git/root";
const objectId = (data: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(data)}\0${data}`)
    .digest("hex");
afterEach(() => {
  setExternalUrlTransportForTests(undefined);
});

async function assertFails(promise: Promise<unknown>, message = ""): Promise<void> {
  const result = await promise.then(
    (): undefined => undefined,
    (error: unknown): unknown => error,
  );
  expect(result).toBeInstanceOf(Error);
  if (result instanceof Error) expect(result.message).toContain(message);
}

type FixtureOptions = Readonly<{
  url?: string;
  path?: string;
  childMode?: string;
  brokenBlob?: boolean;
  config?: string;
  extraLink?: boolean;
  childCommit?: string;
}>;
function fixture(options: FixtureOptions = {}): string[] {
  const calls: string[] = [];
  const config =
    options.config ??
    `[submodule "child"]\n path = ${options.path ?? "modules/child"}\n url = ${options.url ?? "../child"}\n branch = moving-branch\n`;
  const blobs = new Map([
    [objectId(config), config],
    [objectId("root content"), "root content"],
    [objectId("child content"), "child content"],
  ]);
  setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
    const url = new URL(target.url);
    calls.push(target.url);
    expect(init.headers?.["Authorization"]).toBe(`Basic ${Buffer.from(":test-pat").toString("base64")}`);
    expect(url.hostname).toBe("dev.azure.com");
    expect(url.pathname.startsWith("/acme/")).toBe(true);
    if (url.pathname.includes("/commits/")) {
      const id = url.pathname.split("/").at(-1);
      return Response.json({
        commitId: options.childCommit !== undefined && id === childRevision ? options.childCommit : id,
        treeId: id === revision ? treeId : childTreeId,
      });
    }
    if (url.pathname.endsWith(`/trees/${treeId}`))
      return Response.json({
        objectId: treeId,
        treeEntries: [
          { relativePath: ".gitmodules", mode: "100644", gitObjectType: "blob", objectId: objectId(config) },
          { relativePath: "main.tf", mode: "100644", gitObjectType: "blob", objectId: objectId("root content") },
          { relativePath: "modules", mode: "040000", gitObjectType: "tree", objectId: "e".repeat(40) },
          ...(options.extraLink === true
            ? [{ relativePath: "undeclared", mode: "160000", gitObjectType: "commit", objectId: childRevision }]
            : []),
        ],
      });
    if (url.pathname.endsWith(`/trees/${"e".repeat(40)}`))
      return Response.json({
        objectId: "e".repeat(40),
        treeEntries: [{ relativePath: "child", mode: "160000", gitObjectType: "commit", objectId: childRevision }],
      });
    if (url.pathname.endsWith(`/trees/${childTreeId}`))
      return Response.json({
        objectId: childTreeId,
        treeEntries: [
          {
            relativePath: "run.sh",
            mode: options.childMode ?? "100755",
            gitObjectType: "blob",
            objectId: objectId("child content"),
          },
        ],
      });
    if (url.pathname.includes("/blobs/"))
      return new Response(
        options.brokenBlob === true ? "wrong bytes" : blobs.get(url.pathname.split("/").at(-1) ?? ""),
      );
    throw new Error(`Unexpected request: ${url}`);
  });
  return calls;
}

test("ingests exact gitlink commit with same-org PAT, nested path and executable mode; ignores tracking branch", async () => {
  const calls = fixture();
  const tar = gunzipSync(await fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision));
  expect(tar.toString()).toContain("modules/child/run.sh");
  expect(tar.toString()).toContain("child content");
  const offset = tar.indexOf("modules/child/run.sh");
  expect(tar.subarray(offset + 100, offset + 108).toString()).toBe("0000755\0");
  expect(calls.some((url): boolean => url.includes(`/repositories/child/commits/${childRevision}`))).toBe(true);
  expect(calls.some((url): boolean => url.includes("moving-branch") || url.includes("refs"))).toBe(false);
});

test.each([
  "https://dev.azure.com/other/project/_git/child",
  "https://evil.test/acme/project/_git/child",
  "https://user:password@dev.azure.com/acme/project/_git/child",
  "ssh://dev.azure.com/acme/project/_git/child",
  "file:///tmp/repo",
  "//evil.test/repo",
  "../../../../other/project/_git/child",
  "../child?token=x",
  "../child#fragment",
  "https://dev.azure.com/acme/project/_git/child%2fescape",
  "https://dev.azure.com/acme/project/_git/%252e%252e",
  "https://dev.azure.com/acme/project/_git/%2e%2e/%2e%2e/other",
])("rejects unsafe submodule destination %s before sending a child request", async (url) => {
  const calls = fixture({ url });
  await assertFails(fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision), "submodule");
  expect(calls.some((call): boolean => call.includes(`/commits/${childRevision}`))).toBe(false);
});

test.each(["../escape", "/absolute", ".git", "modules//child", "modules/./child"])(
  "rejects unsafe .gitmodules path %s",
  async (path) => {
    fixture({ path });
    await assertFails(fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision), "unsafe repository path");
  },
);

test("rejects missing mapping, ambiguous config, special files and changed object identities", async () => {
  for (const options of [
    { extraLink: true },
    { config: '[submodule "a"]\npath = modules/child\nurl = ../child\nurl = ../other' },
    { childMode: "120000" },
    { brokenBlob: true },
    { childCommit: revision },
    { config: "[include]\npath = /etc/config" },
  ]) {
    fixture(options);
    await assertFails(fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision));
  }
});

test("enforces cumulative transfer, expanded size, per-file and member budgets", async () => {
  for (const limits of [
    { maxCompressedBytes: 128 },
    { maxExpandedBytes: 2048 },
    { maxFileBytes: 8 },
    { maxMembers: 2 },
  ]) {
    fixture();
    await assertFails(fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision, limits));
  }
  fixture();
  const budget = { remainingBytes: 200 };
  await assertFails(fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision, {}, undefined, budget));
  expect(budget.remainingBytes).toBe(0);
});

test.each([true, false])("rejects recursive submodule %s by cycle or depth budget", async (cycle) => {
  const config = '[submodule "again"]\npath = nested\nurl = ../root\n';
  const id = objectId(config);
  let calls = 0;
  setExternalUrlTransportForTests(async (target): Promise<Response> => {
    calls++;
    const url = new URL(target.url);
    if (url.pathname.includes("/commits/")) {
      const current = url.pathname.split("/").at(-1)!;
      return Response.json({ commitId: current, treeId: current });
    }
    if (url.pathname.includes("/trees/")) {
      const current = url.pathname.split("/").at(-1)!;
      const next = cycle ? revision : (BigInt(`0x${current}`) + 1n).toString(16).padStart(40, "0");
      return Response.json({
        objectId: current,
        treeEntries: [
          { relativePath: ".gitmodules", mode: "100644", gitObjectType: "blob", objectId: id },
          { relativePath: "nested", mode: "160000", gitObjectType: "commit", objectId: next },
        ],
      });
    }
    return new Response(config);
  });
  await assertFails(fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision), "depth or cycle limit");
  expect(calls).toBeLessThan(40);
});

test("rejects paginated object responses and cancellation without producing a partial archive", async () => {
  setExternalUrlTransportForTests(
    async (): Promise<Response> =>
      Response.json({ commitId: revision, treeId }, { headers: { "x-ms-continuationtoken": "more" } }),
  );
  await assertFails(fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision), "incomplete");
  fixture();
  await assertFails(fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision, {}, AbortSignal.abort()));
});

test.each(["duplicate", "mode", "identity", "depth"])("rejects malformed or unbounded trees: %s", async (kind) => {
  let requests = 0;
  setExternalUrlTransportForTests(async (target): Promise<Response> => {
    requests++;
    const url = new URL(target.url);
    if (url.pathname.includes("/commits/")) return Response.json({ commitId: revision, treeId });
    const file = {
      relativePath: "a",
      mode: "100644",
      gitObjectType: kind === "mode" ? "commit" : "blob",
      objectId: objectId("data"),
    };
    return Response.json({
      objectId: kind === "identity" ? revision : treeId,
      treeEntries:
        kind === "duplicate"
          ? [file, file]
          : kind === "depth"
            ? [{ relativePath: "nested", mode: "40000", gitObjectType: "tree", objectId: treeId }]
            : [file],
    });
  });
  await assertFails(fetchAzureDevOpsSubmoduleArchive(credentials, repo, revision));
  expect(requests).toBeLessThan(68);
});
