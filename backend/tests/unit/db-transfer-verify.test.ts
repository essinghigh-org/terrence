import { describe, expect, test } from "bun:test";
import {
  digestTable,
  verifyTransfer,
  type TransferSource,
  type TransferTable,
  type TransferTarget,
} from "../../src/lib/db-transfer";

// Issue #620: large tables must report sample coverage instead of silently
// hashing a slice, and both digest bounds must be operator-configurable.
const table: TransferTable = {
  name: "things",
  columns: [
    { name: "id", dataType: "number", columnType: "SQLiteInteger", primary: true, notNull: true, mode: undefined },
    { name: "label", dataType: "string", columnType: "SQLiteText", primary: false, notNull: false, mode: undefined },
  ],
};

type Rows = readonly (readonly unknown[])[];

function makeDigestable(rows: Rows): {
  calls: { stream: number; sample: number; sampleLimit: number };
  api: { count(n: string): Promise<number>; streamRows(n: string, c: unknown, b: number, onBatch: (r: Rows) => Promise<void> | void): Promise<void>; readSampleRows(n: string, c: unknown, o: unknown, limit: number): Promise<Rows> };
} {
  const calls = { stream: 0, sample: 0, sampleLimit: 0 };
  return {
    calls,
    api: {
      count: async (): Promise<number> => rows.length,
      streamRows: async (_n, _c, _b, onBatch): Promise<void> => {
        calls.stream += 1;
        await onBatch(rows);
      },
      readSampleRows: async (_n, _c, _o, limit): Promise<Rows> => {
        calls.sample += 1;
        calls.sampleLimit = limit;
        return rows.slice(0, limit);
      },
    },
  };
}

function row(id: number): readonly unknown[] {
  return [id, "label-" + String(id)];
}

describe("digestTable coverage", (): void => {
  test("hashes small tables fully without sampling", async (): Promise<void> => {
    const source = makeDigestable([row(1), row(2), row(3)]);
    const result = await digestTable(source.api, table);
    expect(result.full).toBe(true);
    expect(result.rows).toBe(3);
    expect(source.calls.stream).toBe(1);
    expect(source.calls.sample).toBe(0);
  });

  test("samples tables over the full-digest limit and says so", async (): Promise<void> => {
    const rows = Array.from({ length: 10 }, (_, index): readonly unknown[] => row(index));
    const source = makeDigestable(rows);
    const result = await digestTable(source.api, table, { fullDigestLimit: 5, sampleLimit: 4 });
    expect(result.full).toBe(false);
    expect(result.rows).toBe(4);
    expect(source.calls.stream).toBe(0);
    expect(source.calls.sampleLimit).toBe(4);
  });

  test("honors a raised full-digest limit", async (): Promise<void> => {
    const rows = Array.from({ length: 10 }, (_, index): readonly unknown[] => row(index));
    const source = makeDigestable(rows);
    const result = await digestTable(source.api, table, { fullDigestLimit: 20 });
    expect(result.full).toBe(true);
    expect(result.rows).toBe(10);
    expect(source.calls.stream).toBe(1);
  });
});

describe("verifyTransfer coverage reporting", (): void => {
  function emptyStore(): TransferSource & TransferTarget {
    const noRows: Rows = [];
    return {
      ping: async (): Promise<void> => { await Promise.resolve(); },
      hasTable: async (): Promise<boolean> => true,
      count: async (): Promise<number> => 0,
      countWhere: async (): Promise<number> => 0,
      queryDistinctCount: async (): Promise<number> => 0,
      streamRows: async (_n, _c, _b, onBatch): Promise<void> => {
        await onBatch(noRows);
      },
      readSampleRows: async (): Promise<Rows> => noRows,
      beginSnapshot: async (): Promise<void> => { await Promise.resolve(); },
      endSnapshot: async (): Promise<void> => { await Promise.resolve(); },
      listForeignKeys: async (): Promise<readonly { child: string; parent: string }[]> => [],
      listUniqueIndexes: async (): Promise<readonly { name: string; table: string; columns: readonly string[] }[]> => [],
      beginTable: async (): Promise<void> => { await Promise.resolve(); },
      insertRows: async (): Promise<void> => { await Promise.resolve(); },
      commitTable: async (): Promise<void> => { await Promise.resolve(); },
      runForeignKeysCheck: async (): Promise<readonly { table: string; rowid: number | null; parent: string; fkid: number }[]> => [],
      foreignKeysEnabled: async (): Promise<boolean> => false,
      finishAndClose: async (): Promise<void> => { await Promise.resolve(); },
    };
  }

  test("empty tables report full coverage and pass", async (): Promise<void> => {
    const store = emptyStore();
    const report = await verifyTransfer(store, store);
    expect(report.allPassed).toBe(true);
    expect(report.tables.length).toBeGreaterThan(0);
    // Empty tables hash zero rows; PK tables cover fully while PK-less
    // tables take the sorted-set sample path by construction.
    for (const entry of report.tables) {
      expect(entry.sampleHash.rowsHashed).toBe(0);
      expect(entry.sampleHash.match).toBe(true);
      expect(["full", "sample"]).toContain(entry.sampleHash.coverage);
    }
    expect(report.tables.some((entry): boolean => entry.sampleHash.coverage === "full")).toBe(true);
  });
});
