import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #945: the database guide contradicted the supported HA topology. The
 * documentation is itself the contract here (no runtime behavior to execute),
 * so this checks the rendered source for the two topologies being described
 * consistently rather than for any code path.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

describe("deployment topology documentation", () => {
  test("the database guide distinguishes standalone from explicitly enabled HA", () => {
    const database = read("backend/docs/database.md");
    expect(database).toContain("high-availability.md");
    expect(database).toContain("TERRENCE_HA_ENABLED=true");
    // PostgreSQL alone must not be presented as enabling HA.
    expect(database).toMatch(/PostgreSQL alone does not enable HA/i);
    expect(database).toMatch(/SQLite remains single-process/i);
    // The unconditional single-process / no-overlapping-deployments claim must
    // not survive alongside the supported active-active topology.
    expect(database).not.toMatch(/PostgreSQL does not supply leader election/);
    expect(database).not.toMatch(/^Do not use a rolling deployment/m);
  });

  test("the HA guide still states its own prerequisites and PostgreSQL quorum boundary", () => {
    const ha = read("backend/docs/high-availability.md");
    expect(ha).toContain("TERRENCE_HA_ENABLED=true");
    expect(ha).toContain("TERRENCE_NODE_ID");
    expect(ha).toMatch(/SQLite remains a single-process backend/);
    expect(ha).toMatch(/PostgreSQL is the single authoritative coordination boundary/);
  });

  test("no other guide repeats the unconditional single-process claim", () => {
    for (const guide of ["backend/docs/operations.md", "backend/docs/upgrading.md"]) {
      const text = read(guide);
      expect(text).not.toMatch(/PostgreSQL does not supply leader election/);
      expect(text).not.toMatch(/exactly one active Terrence control-plane process/);
    }
  });
});
