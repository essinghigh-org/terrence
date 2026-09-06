import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistUploadBody } from "../../src/lib/upload-body";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function interruptedRequest(): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      controller.error(new Error("connection interrupted"));
    },
  });
  return new Request("http://localhost/upload", { method: "PUT", body, duplex: "half" } as RequestInit & { duplex: "half" });
}

test("an interrupted upload leaves the previously published artifact intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terrence-upload-"));
  directories.push(directory);
  const path = join(directory, "artifact.tar.gz");
  await writeFile(path, "published-before-upload");

  await expect(persistUploadBody(undefined, interruptedRequest(), path, 1024)).rejects.toThrow("connection interrupted");
  expect(await readFile(path, "utf8")).toBe("published-before-upload");
  expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});

test("an upload whose lease expires leaves the previously published artifact intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terrence-upload-"));
  directories.push(directory);
  const path = join(directory, "artifact.tar.gz");
  await writeFile(path, "published-before-upload");

  await expect(persistUploadBody(
    new TextEncoder().encode("stale-upload"),
    new Request("http://localhost/upload"),
    path,
    1024,
    async (): Promise<boolean> => false,
  )).rejects.toThrow("stale-agent-lease");
  expect(await readFile(path, "utf8")).toBe("published-before-upload");
  expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});

test("an empty upload does not replace the previously published artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terrence-upload-"));
  directories.push(directory);
  const path = join(directory, "artifact.tar.gz");
  await writeFile(path, "published-before-upload");

  await expect(persistUploadBody(new Uint8Array(), new Request("http://localhost/upload"), path, 1024)).rejects.toThrow("empty");
  expect(await readFile(path, "utf8")).toBe("published-before-upload");
  expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});

test("a completed upload atomically replaces the previous artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terrence-upload-"));
  directories.push(directory);
  const path = join(directory, "artifact.tar.gz");
  await writeFile(path, "published-before-upload");

  await persistUploadBody(new TextEncoder().encode("published-after-upload"), new Request("http://localhost/upload"), path, 1024);
  expect(await readFile(path, "utf8")).toBe("published-after-upload");
  expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});
