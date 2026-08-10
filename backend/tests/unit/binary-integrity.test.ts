import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  type BinaryIntegrity,
  integrityFilePath,
  readBinaryIntegrity,
  revalidateInstalledBinaries,
  unexpectedZipMembers,
  verifyBinaryIntegrity,
} from "../../src/binaryManager";

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "terrence-integrity-"));
  dirs.push(dir);
  return dir;
}

afterEach(async (): Promise<void> => {
  await Promise.all(dirs.map((dir): Promise<void> => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

test("unexpectedZipMembers accepts only the expected binary (kanban 6.7)", (): void => {
  expect(unexpectedZipMembers(["tofu", "./tofu"], "tofu")).toEqual([]);
  expect(unexpectedZipMembers(["terraform"], "terraform")).toEqual([]);
  expect(unexpectedZipMembers(["tofu", "evil.sh", "tofu/LICENSE"], "tofu")).toEqual([
    "evil.sh",
    "tofu/LICENSE",
  ]);
  // Backslash separators normalize like forward slashes when matched.
  expect(unexpectedZipMembers(["tofu\\..\\evil"], "tofu")).toEqual(["tofu\\..\\evil"]);
});

test("readBinaryIntegrity parses a valid file and rejects malformed ones (kanban 6.5)", async (): Promise<void> => {
  const dir = await tempDir();

  await writeFile(
    integrityFilePath(dir),
    JSON.stringify({ tool: "tofu", version: "1.9.3", binarySha256: "a".repeat(64) }),
    "utf8",
  );
  const valid = await readBinaryIntegrity(dir);
  expect(valid).not.toBeNull();
  expect(valid?.binarySha256).toBe("a".repeat(64));

  await writeFile(integrityFilePath(dir), "{not json", "utf8");
  expect(await readBinaryIntegrity(dir)).toBeNull();

  await writeFile(
    integrityFilePath(dir),
    JSON.stringify({ tool: "tofu", version: "1.9.3", binarySha256: "not-a-hex-digest" }),
    "utf8",
  );
  expect(await readBinaryIntegrity(dir)).toBeNull();

  await rm(integrityFilePath(dir), { force: true });
  expect(await readBinaryIntegrity(dir)).toBeNull();
});

test("verifyBinaryIntegrity compares the on-disk file digest (kanban 6.5)", async (): Promise<void> => {
  const dir = await tempDir();
  const binaryPath = join(dir, "tofu");
  await writeFile(binaryPath, "#!/bin/sh\necho tofu\n", "utf8");

  // Correct digest: 64 hex chars of the sha256 of the content above.
  const good: BinaryIntegrity = {
    tool: "tofu",
    version: "1.9.3",
    binarySha256: "450ecd4cd1c8bb24ecb59175d1baa1f138ff05e0a1f0a45b2a2d2e61b8b4d2d0",
  };
  expect(await verifyBinaryIntegrity(binaryPath, good)).toBe(false);

  const content = await Bun.file(binaryPath).arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)))
    .map((b: number): string => b.toString(16).padStart(2, "0"))
    .join("");
  expect(await verifyBinaryIntegrity(binaryPath, { ...good, binarySha256: digest })).toBe(true);
});

test("revalidateInstalledBinaries removes tampered installs and keeps intact ones (kanban 6.5)", async (): Promise<void> => {
  const base = await tempDir();

  // Intact install: binary digest matches the integrity file.
  const goodDir = join(base, "tofu", "1.9.3");
  await Bun.write(join(goodDir, "tofu"), "#!/bin/sh\necho good\n");
  const goodContent = await Bun.file(join(goodDir, "tofu")).arrayBuffer();
  const goodDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", goodContent)))
    .map((b: number): string => b.toString(16).padStart(2, "0"))
    .join("");
  await writeFile(
    join(goodDir, ".integrity.json"),
    JSON.stringify({ tool: "tofu", version: "1.9.3", binarySha256: goodDigest }),
    "utf8",
  );

  // Tampered install: file changed after the digest was recorded.
  const badDir = join(base, "terraform", "1.9.3");
  await Bun.write(join(badDir, "terraform"), "#!/bin/sh\necho good\n");
  await writeFile(
    join(badDir, ".integrity.json"),
    JSON.stringify({ tool: "terraform", version: "1.9.3", binarySha256: "0".repeat(64) }),
    "utf8",
  );

  // Unverified install: no integrity file, left in place.
  const legacyDir = join(base, "tofu", "1.7.2");
  await Bun.write(join(legacyDir, "tofu"), "#!/bin/sh\necho legacy\n");

  const removed = await revalidateInstalledBinaries(base);
  expect(removed).toEqual(["terraform/1.9.3"]);

  expect(await Bun.file(join(goodDir, "tofu")).exists()).toBe(true);
  expect(await Bun.file(join(legacyDir, "tofu")).exists()).toBe(true);
  expect(await Bun.file(join(badDir, "terraform")).exists()).toBe(false);
});