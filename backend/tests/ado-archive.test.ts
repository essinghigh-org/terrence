import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { azureDevOpsZipFixture as zip } from "./fixtures/ado-zip";
import { azureDevOpsZipToTarGz } from "../src/lib/ado-archive";

test("converts compressed and stored files into portable tar preserving executable permissions", () => {
  const archive = azureDevOpsZipToTarGz(
    zip([
      { name: "main.tf", data: "terraform {}" },
      { name: "bin/", mode: 0o40755 },
      { name: "bin/run.sh", data: "#!/bin/sh", mode: 0o100755, method: 0 },
    ]),
  );
  const tar = gunzipSync(archive);
  expect(tar.subarray(0, 7).toString()).toBe("main.tf");
  expect(tar.subarray(512, 524).toString()).toBe("terraform {}");
  expect(tar.subarray(1536, 1546).toString()).toBe("bin/run.sh");
  expect(tar.subarray(1636, 1644).toString()).toBe("0000755\0");
});

test.each(["../escape", "/absolute", "a/../b", "a\\b", "C:drive", "a//b", "./a", "a\nb", "a\0b"])(
  "rejects unsafe path %s",
  (name): void => {
    expect(() => azureDevOpsZipToTarGz(zip([{ name }]))).toThrow("unsafe path");
  },
);

test.each([0o120777, 0o020666, 0o060666, 0o010666, 0o140666])("rejects special mode %s", (mode): void => {
  expect(() => azureDevOpsZipToTarGz(zip([{ name: "unsafe", mode }]))).toThrow("special file");
});

test("rejects duplicate entries and file/directory aliases", () => {
  expect(() => azureDevOpsZipToTarGz(zip([{ name: "a" }, { name: "a" }]))).toThrow("duplicate path");
  expect(() => azureDevOpsZipToTarGz(zip([{ name: "a" }, { name: "a/", mode: 0o40755 }]))).toThrow("duplicate path");
});

test("enforces compressed, expanded, per-file and member bounds", () => {
  const fixture = zip([{ name: "a", data: "a".repeat(4096) }, { name: "b" }]);
  expect(() => azureDevOpsZipToTarGz(fixture, { maxCompressedBytes: 1 })).toThrow("compressed byte limit");
  expect(() => azureDevOpsZipToTarGz(fixture, { maxExpandedBytes: 2048 })).toThrow("expanded byte limit");
  expect(() => azureDevOpsZipToTarGz(fixture, { maxFileBytes: 1024 })).toThrow("expanded byte limit");
  expect(() => azureDevOpsZipToTarGz(fixture, { maxMembers: 1 })).toThrow("member count");
});

test("does not trust forged expanded length or CRC", () => {
  const fixture = Buffer.from(zip([{ name: "a", data: "a".repeat(4096) }]));
  const central = fixture.readUInt32LE(fixture.length - 6);
  fixture.writeUInt32LE(1, central + 24);
  expect(() => azureDevOpsZipToTarGz(fixture)).toThrow();
  const badCrc = Buffer.from(zip([{ name: "a", data: "content" }]));
  badCrc.writeUInt32LE(0, badCrc.readUInt32LE(badCrc.length - 6) + 16);
  expect(() => azureDevOpsZipToTarGz(badCrc)).toThrow("CRC mismatch");
});

test("rejects encrypted, unsupported, malformed and overlapping archives", () => {
  expect(() => azureDevOpsZipToTarGz(zip([{ name: "a", flags: 1 }]))).toThrow("unsupported");
  expect(() => azureDevOpsZipToTarGz(zip([{ name: "a", method: 99 }]))).toThrow("unsupported");
  expect(() => azureDevOpsZipToTarGz(new Uint8Array(2))).toThrow("end record");
  const fixture = Buffer.from(
    zip([
      { name: "a", data: "a" },
      { name: "b", data: "b" },
    ]),
  );
  const central = fixture.readUInt32LE(fixture.length - 6);
  fixture.writeUInt32LE(0, central + 47 + 42);
  expect(() => azureDevOpsZipToTarGz(fixture)).toThrow("overlapping");
});

test("validates local headers independently of trusted central metadata", () => {
  const fixture = Buffer.from(zip([{ name: "main.tf", data: "terraform {}" }]));
  fixture.writeUInt32LE(0, 14);
  expect(() => azureDevOpsZipToTarGz(fixture)).toThrow("local size or CRC mismatch");
});

test("supports streamed ZIP descriptors and rejects forged or missing descriptors", () => {
  const fixture = Buffer.from(zip([{ name: "main.tf", data: "terraform {}", descriptor: true }]));
  expect(gunzipSync(azureDevOpsZipToTarGz(fixture)).subarray(512, 524).toString()).toBe("terraform {}");
  const central = fixture.readUInt32LE(fixture.length - 6);
  fixture.writeUInt32LE(0, central - 12);
  expect(() => azureDevOpsZipToTarGz(fixture)).toThrow("data descriptor");
  expect(() => azureDevOpsZipToTarGz(zip([{ name: "main.tf", flags: 0x808 }]))).toThrow();
});

test("rejects file-parent collisions and mismatched directory modes", () => {
  expect(() => azureDevOpsZipToTarGz(zip([{ name: "dir" }, { name: "dir/file" }]))).toThrow("parent directory");
  expect(() => azureDevOpsZipToTarGz(zip([{ name: "dir", mode: 0o40755 }]))).toThrow("file type");
});

test("rejects ZIP64, multi-disk, and truncated central metadata", () => {
  const fixture = Buffer.from(zip([{ name: "main.tf", data: "terraform {}" }]));
  const central = fixture.readUInt32LE(fixture.length - 6);
  fixture.writeUInt32LE(0xffffffff, central + 24);
  expect(() => azureDevOpsZipToTarGz(fixture)).toThrow();
  const multi = Buffer.from(zip([{ name: "main.tf" }]));
  multi.writeUInt16LE(1, multi.length - 18);
  expect(() => azureDevOpsZipToTarGz(multi)).toThrow("multi-disk");
  const truncated = Buffer.from(zip([{ name: "main.tf" }]));
  truncated.writeUInt16LE(1000, truncated.readUInt32LE(truncated.length - 6) + 30);
  expect(() => azureDevOpsZipToTarGz(truncated)).toThrow();
});
