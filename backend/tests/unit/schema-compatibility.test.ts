/**
 * HA-3B: guard the guard.
 *
 * The expand/contract checker is only useful if it actually fails on a
 * contracting migration, so the meaningful test is a negative one: point it at
 * a fixture containing a DROP COLUMN and require a non-zero exit.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import register from "../../src/data/schema_contractions.json";
import { HA_PROTOCOL_VERSION } from "../../src/lib/ha-protocol";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "scripts", "check-schema-compatibility.ts");

let sandbox: string;

/**
 * The script resolves its paths relative to its own location, so a fixture run
 * needs a throwaway tree with the same shape rather than a flag.
 */
async function runAgainstFixture(
  migrations: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ exitCode: number; output: string }> {
  const scriptsDir = join(sandbox, "scripts");
  const migrationsDir = join(sandbox, "backend", "drizzle", "pg");
  const dataDir = join(sandbox, "backend", "src", "data");
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(migrationsDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);
  await Bun.write(join(scriptsDir, "check-schema-compatibility.ts"), Bun.file(SCRIPT));
  await writeFile(
    join(dataDir, "schema_contractions.json"),
    JSON.stringify({ protocolVersion: 1, enforcedFrom: "0000_baseline", contractions: [], ...overrides }),
  );
  for (const [name, sql] of Object.entries(migrations)) {
    await writeFile(join(migrationsDir, name), sql);
  }
  const proc = Bun.spawn(["bun", join(scriptsDir, "check-schema-compatibility.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { exitCode, output: `${stdout}\n${stderr}` };
}

beforeEach(async (): Promise<void> => {
  sandbox = await mkdtemp(join(tmpdir(), "terrence-schema-compat-"));
});

afterEach(async (): Promise<void> => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("schema compatibility register", () => {
  test("declares the protocol version this release actually speaks", () => {
    // A register that drifts from the code silently stops describing the
    // window it is supposed to be enforcing.
    expect(register.protocolVersion).toBe(HA_PROTOCOL_VERSION);
  });

  test("documents the supported rolling-upgrade skew", () => {
    expect(register.rollingUpgradeWindow.supportedSkew).toBe("N/N-1");
  });
});

describe("expand/contract enforcement", () => {
  test("accepts a purely additive migration", async () => {
    const result = await runAgainstFixture({
      "0001_expand.sql": 'ALTER TABLE "runs" ADD COLUMN "bar" text;',
    });
    expect(result.exitCode).toBe(0);
  });

  test("rejects an unregistered column drop", async () => {
    const result = await runAgainstFixture({
      "0001_contract.sql": 'ALTER TABLE "runs" DROP COLUMN "foo";',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("drop column");
  });

  test("rejects a rename, which is a drop wearing a disguise", async () => {
    const result = await runAgainstFixture({
      "0001_rename.sql": 'ALTER TABLE "runs" RENAME COLUMN "foo" TO "bar";',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("rename column");
  });

  test("rejects a new NOT NULL constraint even though nothing is deleted", async () => {
    // An N-1 replica inserting without the column starts failing the moment
    // the constraint lands.
    const result = await runAgainstFixture({
      "0001_notnull.sql": 'ALTER TABLE "runs" ALTER COLUMN "foo" SET NOT NULL;',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not-null");
  });

  test("accepts a contraction once it is registered with its justification", async () => {
    const result = await runAgainstFixture(
      { "0001_contract.sql": 'ALTER TABLE "runs" DROP COLUMN "foo";' },
      {
        contractions: [
          {
            migration: "0001_contract",
            dialect: "pg",
            surface: "runs.foo",
            expandedIn: "1.5.0",
            approvedFor: "1.7.0",
            owner: "platform",
            justification: "No supported replica reads runs.foo since 1.6.0",
          },
        ],
      },
    );
    expect(result.exitCode).toBe(0);
  });

  test("rejects a register entry whose migration no longer exists", async () => {
    // A stale entry would hide the next real contraction behind a name that
    // can never match again.
    const result = await runAgainstFixture(
      { "0001_expand.sql": 'ALTER TABLE "runs" ADD COLUMN "bar" text;' },
      { contractions: [{ migration: "0099_vanished" }] },
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("0099_vanished");
  });

  test("does not hold migrations older than the baseline to a later rule", async () => {
    const result = await runAgainstFixture(
      { "0001_legacy.sql": 'ALTER TABLE "runs" DROP COLUMN "foo";' },
      { enforcedFrom: "0005_start_here" },
    );
    expect(result.exitCode).toBe(0);
  });
});
