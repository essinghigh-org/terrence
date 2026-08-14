import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestModuleArchive,
  MAX_MODULE_ARCHIVE_BYTES,
  validateModuleArchive,
} from "../../src/lib/registry-module-archive";
import { inspectRegistryModule } from "../../src/lib/registry-module-metadata";
import { discoverModuleVersions } from "../../src/lib/registry-module-sync";
import { makeRegistryModuleArchive } from "../registry-module-helpers";

async function expectRejection(operation: () => Promise<unknown>, message?: string): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (message !== undefined) expect((caught as Error).message).toContain(message);
}

describe("registry module ingestion", () => {
  let directory = "";
  let fixtureArchive = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "terrence-registry-ingestion-"));
    fixtureArchive = join(directory, "fixture.tar.gz");
    await makeRegistryModuleArchive(fixtureArchive);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("discovers semantic tags with optional v and monorepo prefixes", () => {
    expect(discoverModuleVersions([
      { name: "network-v1.2.3", sha: "sha-123" },
      { name: "network-1.3.0", sha: "sha-130" },
      { name: "network-v1.2", sha: "bad-short" },
      { name: "v9.0.0", sha: "wrong-prefix" },
      { name: "network-latest", sha: "bad-word" },
    ], "network-")).toEqual([
      { version: "1.2.3", ref: "network-v1.2.3", sha: "sha-123", branch: null },
      { version: "1.3.0", ref: "network-1.3.0", sha: "sha-130", branch: null },
    ]);
  });

  test("extracts cached metadata from a realistic module fixture", async () => {
    const storedArchive = join(directory, "stored.tar.gz");
    const metadata = await ingestModuleArchive(fixtureArchive, storedArchive, "", inspectRegistryModule);

    expect(await Bun.file(storedArchive).exists()).toBeTrue();
    expect(metadata.readme).toContain("# Network module");
    expect(metadata.description).toContain("Creates a small network");
    expect(metadata.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "name", type: "string", required: true, nullable: false }),
      expect.objectContaining({ name: "cidrs", type: "list(string)", required: false, sensitive: true, defaultValue: ["10.0.0.0/24"] }),
    ]));
    expect(metadata.outputs).toContainEqual(expect.objectContaining({ name: "vpc_id", sensitive: true }));
    expect(metadata.providers).toContainEqual({ name: "aws", source: "hashicorp/aws", versionConstraint: "~> 6.0" });
    expect(metadata.modules).toContainEqual({ name: "labels", source: "cloudposse/label/null", versionConstraint: "0.25.0" });
    expect(metadata.resources).toEqual(expect.arrayContaining([
      { name: "main", type: "aws_vpc", mode: "managed" },
      { name: "current", type: "aws_region", mode: "data" },
    ]));
    expect(metadata.submodules.map(({ path }): string => path)).toEqual(["modules/subnet"]);
    expect(metadata.examples.map(({ path }): string => path)).toEqual(["examples/basic"]);
  });

  test("stores only the configured source directory", async () => {
    const storedArchive = join(directory, "submodule.tar.gz");
    const metadata = await ingestModuleArchive(fixtureArchive, storedArchive, "modules/subnet", inspectRegistryModule);
    const extracted = join(directory, "selected");
    await mkdir(extracted);
    const tar = Bun.spawn(["tar", "-xzf", storedArchive, "-C", extracted]);
    expect(await tar.exited).toBe(0);
    expect(metadata.readme).toContain("# Subnet submodule");
    expect(await readFile(join(extracted, "README.md"), "utf8")).toContain("Subnet submodule");
    expect(await Bun.file(join(extracted, "examples/basic/main.tf")).exists()).toBeFalse();
  });

  test("rejects traversal, links, oversized uploads, and oversized members", async () => {
    const source = join(directory, "hostile");
    await mkdir(source);
    await writeFile(join(source, "main.tf"), "terraform {}\n");

    const traversal = join(directory, "traversal.tar.gz");
    const traversalTar = Bun.spawn(["tar", "-czf", traversal, "--transform=s|main.tf|../escaped.tf|", "-C", source, "main.tf"]);
    expect(await traversalTar.exited).toBe(0);
    await expectRejection(async (): Promise<void> => { await validateModuleArchive(traversal); });

    await symlink("main.tf", join(source, "linked.tf"));
    const links = join(directory, "links.tar.gz");
    const linkTar = Bun.spawn(["tar", "-czf", links, "-C", source, "linked.tf"]);
    expect(await linkTar.exited).toBe(0);
    await expectRejection(async (): Promise<void> => { await validateModuleArchive(links); }, "regular files and directories");

    const tooLargeUpload = join(directory, "too-large-upload.tar.gz");
    const uploadFile = await open(tooLargeUpload, "w");
    await uploadFile.truncate(MAX_MODULE_ARCHIVE_BYTES + 1);
    await uploadFile.close();
    await expectRejection(async (): Promise<void> => { await validateModuleArchive(tooLargeUpload); }, "upload limit");

    const largeMember = join(source, "large.tf");
    const memberFile = await open(largeMember, "w");
    await memberFile.truncate(16 * 1024 * 1024 + 1);
    await memberFile.close();
    const largeMemberArchive = join(directory, "large-member.tar.gz");
    const memberTar = Bun.spawn(["tar", "-czf", largeMemberArchive, "-C", source, "large.tf"]);
    expect(await memberTar.exited).toBe(0);
    await expectRejection(async (): Promise<void> => { await validateModuleArchive(largeMemberArchive); }, "file larger");
  });

  test("rejects a missing or escaping source directory", async () => {
    await expectRejection(async (): Promise<void> => {
      await ingestModuleArchive(fixtureArchive, join(directory, "missing.tar.gz"), "missing", inspectRegistryModule);
    }, "does not exist");
    await expectRejection(async (): Promise<void> => {
      await ingestModuleArchive(fixtureArchive, join(directory, "escaping.tar.gz"), "../outside", inspectRegistryModule);
    }, "safe relative path");
  });
});
