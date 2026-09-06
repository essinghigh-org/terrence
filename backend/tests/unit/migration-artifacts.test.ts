import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactReferenceInventory, verifyArtifactReferences } from "../../src/lib/migration/artifacts";

test("artifact verification rejects missing files and directories without reporting paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "migration-artifacts-"));
  const source = new Database(":memory:");
  try {
    const file = join(directory, "private-reference.tar.gz");
    writeFileSync(file, "fixture");
    for (const { table, column } of artifactReferenceInventory) {
      source.exec(`CREATE TABLE "${table}" ("${column}" TEXT)`);
      const insert = source.query(`INSERT INTO "${table}" VALUES (?)`);
      for (const path of [null, file, directory, join(directory, "missing"), ""]) insert.run(path);
    }
    const checks = await verifyArtifactReferences(source);
    expect(checks).toHaveLength(artifactReferenceInventory.length);
    for (const check of checks) {
      expect(check.checked).toBe(4);
      expect(check.unavailable).toBe(3);
    }
    expect(JSON.stringify(checks)).not.toContain(directory);
    expect(JSON.stringify(checks)).not.toContain("private-reference");
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prior schemas without newer artifact tables are supported", async () => {
  const source = new Database(":memory:");
  try { expect(await verifyArtifactReferences(source)).toEqual([]); } finally { source.close(); }
});
