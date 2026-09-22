/** Exercise the real schema compatibility script against temporary migration trees. */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import register from "../../src/data/schema_contractions.json";
import { HA_PROTOCOL_VERSION } from "../../src/lib/ha-protocol";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "scripts", "check-schema-compatibility.ts");
const HA_PROTOCOL_SOURCE = join(REPO_ROOT, "backend", "src", "lib", "ha-protocol.ts");

let sandbox: string;

/** Build a temporary repository-shaped fixture because the script resolves paths relative to itself. */
async function runAgainstFixture(
  migrations: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, unknown>> = {},
  currentVersion = "1.7.0",
): Promise<{ exitCode: number; output: string }> {
  const scriptsDir = join(sandbox, "scripts");
  const migrationsDir = join(sandbox, "backend", "drizzle", "pg");
  const dataDir = join(sandbox, "backend", "src", "data");
  const libDir = join(sandbox, "backend", "src", "lib");
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(migrationsDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(libDir, { recursive: true }),
  ]);
  await Promise.all([
    Bun.write(join(scriptsDir, "check-schema-compatibility.ts"), Bun.file(SCRIPT)),
    Bun.write(join(libDir, "ha-protocol.ts"), Bun.file(HA_PROTOCOL_SOURCE)),
    writeFile(join(sandbox, "package.json"), JSON.stringify({ version: currentVersion })),
  ]);
  await writeFile(
    join(dataDir, "schema_contractions.json"),
    JSON.stringify({
      protocolVersion: HA_PROTOCOL_VERSION,
      enforcedFrom: "0000_baseline",
      contractions: [],
      ...overrides,
    }),
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
    // The register and runtime must describe the same HA protocol.
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

  test("rejects a column rename", async () => {
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

  test("a registered surface does not exempt other contractions in the same migration", async () => {
    const result = await runAgainstFixture(
      {
        "0001_contract.sql": 'ALTER TABLE "runs" DROP COLUMN "foo"; ALTER TABLE "runs" DROP COLUMN "bar";',
      },
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
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("runs.bar");
  });

  test("rejects a required added column without a default", async () => {
    const result = await runAgainstFixture({
      "0001_required.sql": 'ALTER TABLE "runs" ADD COLUMN "generation" bigint NOT NULL;',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("required column");
  });

  test("allows a required added column when old writers receive a default", async () => {
    const result = await runAgainstFixture({
      "0001_required.sql": 'ALTER TABLE "runs" ADD COLUMN "generation" bigint DEFAULT 0 NOT NULL;',
    });
    expect(result.exitCode).toBe(0);
  });

  test("rejects new database constraints that older writers never agreed to", async () => {
    const result = await runAgainstFixture({
      "0001_constraint.sql": 'ALTER TABLE "runs" ADD CONSTRAINT "runs_external_id_unique" UNIQUE ("external_id");',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("unique constraint");
  });

  test("requires complete approval metadata and a matching PostgreSQL dialect", async () => {
    const incomplete = await runAgainstFixture(
      { "0001_contract.sql": 'ALTER TABLE "runs" DROP COLUMN "foo";' },
      { contractions: [{ migration: "0001_contract", dialect: "pg", surface: "runs.foo" }] },
    );
    expect(incomplete.exitCode).toBe(1);
    expect(incomplete.output).toContain("expandedIn");

    const wrongDialect = await runAgainstFixture(
      { "0001_contract.sql": 'ALTER TABLE "runs" DROP COLUMN "foo";' },
      {
        contractions: [
          {
            migration: "0001_contract",
            dialect: "sqlite",
            surface: "runs.foo",
            expandedIn: "1.5.0",
            approvedFor: "1.7.0",
            owner: "platform",
            justification: "SQLite approval must not waive the PostgreSQL compatibility check",
          },
        ],
      },
    );
    expect(wrongDialect.exitCode).toBe(1);
    expect(wrongDialect.output).toContain("runs.foo");
  });

  test("rejects a contraction register for a different HA protocol", async () => {
    const result = await runAgainstFixture(
      { "0001_expand.sql": 'ALTER TABLE "runs" ADD COLUMN "bar" text;' },
      { protocolVersion: HA_PROTOCOL_VERSION + 1 },
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("does not match HA_PROTOCOL_VERSION");
  });

  test("rejects a contraction while the expansion release is still supported", async () => {
    const result = await runAgainstFixture(
      { "0001_contract.sql": 'ALTER TABLE "runs" DROP COLUMN "foo";' },
      {
        contractions: [
          {
            migration: "0001_contract",
            dialect: "pg",
            surface: "runs.foo",
            expandedIn: "1.5.0",
            approvedFor: "1.6.0",
            owner: "platform",
            justification: "The replacement exists but 1.5 remains inside the rolling-upgrade window",
          },
        ],
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("two minor releases");
  });

  test("rejects a contraction approved for a future release", async () => {
    const result = await runAgainstFixture(
      { "0001_contract.sql": 'ALTER TABLE "runs" DROP COLUMN "foo";' },
      {
        contractions: [
          {
            migration: "0001_contract",
            dialect: "pg",
            surface: "runs.foo",
            expandedIn: "1.5.0",
            approvedFor: "1.8.0",
            owner: "platform",
            justification: "This contraction is not permitted until the future 1.8 release",
          },
        ],
      },
      "1.7.0",
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("later than the current release");
  });

  test("rejects an approval that does not match a detected contraction surface", async () => {
    const result = await runAgainstFixture(
      { "0001_contract.sql": 'ALTER TABLE "runs" DROP COLUMN "bar";' },
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
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("approval for runs.foo does not match a detected contraction");
  });

  test("rejects a register entry whose migration no longer exists", async () => {
    const result = await runAgainstFixture(
      { "0001_expand.sql": 'ALTER TABLE "runs" ADD COLUMN "bar" text;' },
      {
        contractions: [
          {
            migration: "0099_vanished",
            dialect: "pg",
            surface: "runs.foo",
            expandedIn: "1.5.0",
            approvedFor: "1.7.0",
            owner: "platform",
            justification: "The migration was removed and this approval is therefore stale",
          },
        ],
      },
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
