import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest } from "../../scripts/build-manifest";

describe("release build manifest", () => {
  it("records immutable source, image, migration, and redacted compatibility evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "terrence-build-manifest-"));
    try {
      for (const directory of ["sqlite", "postgres", "evidence"]) await mkdir(join(root, directory));
      await writeFile(join(root, "sqlite", "001.sql"), "create table users;");
      await writeFile(join(root, "postgres", "001.sql"), "create table users_pg;");
      await writeFile(join(root, "matrix.json"), "{\"terraform\":{}}\n");
      await writeFile(join(root, "evidence", "terraform-floor.json"), "{\"binarySha256\":\"redacted-by-fixture\"}\n");
      const manifest = await buildManifest({
        version: "1.2.3", commit: "a".repeat(40), imageReference: "ghcr.io/example/terrence:v1.2.3",
        imageDigest: `sha256:${"b".repeat(64)}`, sqliteMigrations: join(root, "sqlite"),
        postgresMigrations: join(root, "postgres"), compatibilityMatrix: join(root, "matrix.json"),
        evidenceDirectory: join(root, "evidence"),
      });
      expect(manifest.schema).toBe(1);
      expect(manifest.image.digest).toBe(`sha256:${"b".repeat(64)}`);
      expect(manifest.migrations.sqliteSha256).not.toBe(manifest.migrations.postgresSha256);
      expect(manifest.compatibility.evidence).toHaveLength(1);
      expect(JSON.stringify(manifest)).not.toContain("redacted-by-fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects mutable or malformed release identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "terrence-build-manifest-invalid-"));
    try {
      await mkdir(join(root, "migrations"));
      await writeFile(join(root, "matrix.json"), "{}");
      const result = await buildManifest({
        version: "latest", commit: "a".repeat(40), imageReference: "image:latest", imageDigest: "sha256:" + "b".repeat(64),
        sqliteMigrations: join(root, "migrations"), postgresMigrations: join(root, "migrations"), compatibilityMatrix: join(root, "matrix.json"),
      }).catch((error: unknown): unknown => error);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("release version");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
