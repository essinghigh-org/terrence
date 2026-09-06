import { rejects } from "node:assert/strict";
import { afterAll, describe, expect, it } from "bun:test";
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { assertArchiveExpandedSize, assertArchiveLogicalSize, assertArchiveMemberCount, assertSafeTarArchive, extractSafeTarArchive, tarMemberPathUnsafe } from "../../src/lib/archive";

import { ingestModuleArchive } from "../../src/lib/registry-module-archive";
import { validTarGzip } from "../api/test-archives";

const directory = await mkdtemp(join(tmpdir(), "terrence-archive-limit-"));
const archive = join(directory, "archive.tar.gz");

afterAll(() => rm(directory, { recursive: true, force: true }));

describe("archive expansion limit", () => {
  it("rejects compressed data whose expanded size exceeds the limit", async () => {
    await writeFile(archive, gzipSync(Buffer.alloc(4096)));
    await assertArchiveExpandedSize(archive, 4096);
    let error: unknown;
    try {
      await assertArchiveExpandedSize(archive, 4095);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("expands beyond");
  });

  it("rejects missing archives and excessive member counts", async () => {
    let error: unknown;
    try {
      await assertArchiveExpandedSize(join(directory, "absent.tar.gz"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(() => {
      assertArchiveMemberCount(new Array(10_001));
    }).toThrow("too many members");
  });

  it("rejects archives containing links before extraction", async () => {
    const source = await mkdtemp(join(directory, "unsafe-source-"));
    const unsafeArchive = join(directory, "unsafe.tar.gz");
    try {
      expect(tarMemberPathUnsafe("main..backup.tf")).toBe(true);
      expect(tarMemberPathUnsafe("dir/../outside.tf")).toBe(true);
      expect(tarMemberPathUnsafe(String.raw`dir\\..\\outside.tf`)).toBe(true);
      await writeFile(join(source, "main.tf"), "terraform {}\n");
      await symlink("main.tf", join(source, "link.tf"));
      const tar = Bun.spawn(["tar", "-czf", unsafeArchive, "-C", source, "."], { stdout: "pipe", stderr: "pipe" });
      expect(await tar.exited).toBe(0);
      await rejects(assertSafeTarArchive(unsafeArchive), /forbidden link/);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("counts sparse members by logical size before extraction", async () => {
    const sparseFile = join(directory, "sparse");
    const sparseArchive = join(directory, "sparse.tar.gz");
    const handle = await open(sparseFile, "w");
    await handle.truncate(64 * 1024);
    await handle.close();
    const tar = Bun.spawn(["tar", "--sparse", "-czf", sparseArchive, "-C", directory, "sparse"]);
    expect(await tar.exited).toBe(0);

    await assertArchiveExpandedSize(sparseArchive, 16 * 1024);
    let error: unknown;
    try {
      await assertArchiveLogicalSize(sparseArchive, 64 * 1024 - 1);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("contents exceed");
  });
});


describe("shared archive extraction", () => {
  async function fixture(): Promise<{ source: string; packed: string; destination: string }> {
    const root = await mkdtemp(join(directory, "extraction-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await mkdir(destination);
    await writeFile(join(source, "main.tf"), "terraform {}\n");
    await writeFile(join(source, "secret.tfvars"), "secret");
    const packed = join(root, "input.tar.gz");
    const tar = Bun.spawn(["tar", "-czf", packed, "-C", source, "."]);
    expect(await tar.exited).toBe(0);
    return { source, packed, destination };
  }

  it("extracts valid files and preserves caller exclusions", async () => {
    const { packed, destination } = await fixture();
    await extractSafeTarArchive(packed, destination, {}, ["*.tfvars"]);
    expect(await readFile(join(destination, "main.tf"), "utf8")).toBe("terraform {}\n");
    expect(await Bun.file(join(destination, "secret.tfvars")).exists()).toBe(false);
  });

  it("rejects duplicate members before writing files", async () => {
    const { source, packed, destination } = await fixture();
    const tar = Bun.spawn(["tar", "--hard-dereference", "-czf", packed, "-C", source, "main.tf", "./main.tf"]);
    expect(await tar.exited).toBe(0);
    await rejects(extractSafeTarArchive(packed, destination), /duplicate/);
    expect(await Bun.file(join(destination, "main.tf")).exists()).toBe(false);
  });

  it("rejects symlinks in the destination and its ancestors", async () => {
    const { packed, destination } = await fixture();
    const alias = destination + "-alias";
    await symlink(destination, alias);
    await mkdir(join(destination, "child"));
    await rejects(extractSafeTarArchive(packed, join(alias, "child")), /link or special/);
    await symlink("/tmp", join(destination, "escape"));
    await rejects(extractSafeTarArchive(packed, destination), /link or special/);
    expect(await Bun.file(join(destination, "main.tf")).exists()).toBe(false);
  });

  it("enforces compressed and per-file limits and cancellation", async () => {
    const { packed, destination } = await fixture();
    await rejects(assertSafeTarArchive(packed, { maxCompressedBytes: 1 }), /compressed byte/);
    await rejects(assertSafeTarArchive(packed, { maxFileBytes: 1 }), /file larger/);
    await rejects(extractSafeTarArchive(packed, destination, { signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
    expect(await Bun.file(join(destination, "main.tf")).exists()).toBe(false);
    await writeFile(packed, "invalid gzip");
    await rejects(extractSafeTarArchive(packed, destination));
    expect(await Bun.file(join(destination, "main.tf")).exists()).toBe(false);
  });
});


it("rejects hard links and traversal members through the shared validator", async () => {
  const source = await mkdtemp(join(directory, "links-"));
  const packed = join(source, "packed.tar.gz");
  await writeFile(join(source, "main.tf"), "terraform {}");
  await link(join(source, "main.tf"), join(source, "alias.tf"));
  let tar = Bun.spawn(["tar", "-czf", packed, "-C", source, "main.tf", "alias.tf"]);
  expect(await tar.exited).toBe(0);
  await rejects(assertSafeTarArchive(packed), /forbidden link/);
  tar = Bun.spawn(["tar", "--transform=s|main.tf|../escape.tf|", "-czf", packed, "-C", source, "main.tf"]);
  expect(await tar.exited).toBe(0);
  await rejects(assertSafeTarArchive(packed), /unsafe path/);
});

it("bounds real member counts and rejects enormous declared metadata", async () => {
  const packed = join(directory, "metadata.tar.gz");
  const base = gunzipSync(validTarGzip()).subarray(0, 512);
  const header = (name: string, size: number): Buffer => {
    const value = Buffer.from(base);
    value.fill(0, 0, 100);
    value.write(name, 0, "utf8");
    value.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    value.fill(32, 148, 156);
    const checksum = value.reduce((total, byte) => total + byte, 0);
    value.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    return value;
  };
  await writeFile(packed, gzipSync(Buffer.concat([
    ...Array.from({ length: 10_001 }, (_, index) => header(`file-${index}`, 0)), Buffer.alloc(1024),
  ])));
  await rejects(assertSafeTarArchive(packed), /too many members/);
  await writeFile(packed, gzipSync(Buffer.concat([header("huge", 8_000_000_000), Buffer.alloc(1024)])));
  await rejects(assertSafeTarArchive(packed));
});


it("removes registry staging files when inspection fails", async () => {
  const packed = join(directory, "cleanup.tar.gz");
  const output = join(directory, "cleanup-output.tar.gz");
  await writeFile(packed, validTarGzip("terraform {}"));
  let staging = "";
  await rejects(ingestModuleArchive(packed, output, "", (root) => {
    staging = root;
    return Promise.reject(new Error("inspection failed"));
  }), /inspection failed/);
  expect(staging).not.toBe("");
  await rejects(readdir(staging), /ENOENT/);
  expect(await Bun.file(output).exists()).toBe(false);
  expect((await readdir(directory)).some((name) => name.startsWith("cleanup-output.tar.gz."))).toBe(false);
});
