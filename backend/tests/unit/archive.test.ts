import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { assertArchiveExpandedSize, assertArchiveLogicalSize, assertArchiveMemberCount, assertSafeTarArchive, tarMemberPathUnsafe } from "../../src/lib/archive";

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
      await expect(assertSafeTarArchive(unsafeArchive)).rejects.toThrow("forbidden link");
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
