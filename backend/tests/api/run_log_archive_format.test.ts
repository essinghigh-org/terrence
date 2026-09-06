import { expect, spyOn, test } from "bun:test";
import { open, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { logs, runs, workspaces } from "../../src/db/schema";
import { archiveRunLogs, deleteRunLogArchive, readRunLogSlice, readRunLogsPage, runLogArchivePath } from "../../src/lib/run-logs";
import { isStorageDegraded, resetStorageHealthForTests } from "../../src/lib/storage-health";
import { cleanupSeed, persistSeed, seedOrg } from "./compat_contract_helpers";

test("indexed archives select chunks, preserve byte windows and legacy data, and publish atomically", async () => {
  const seed = seedOrg("archive-format");
  const workspaceId = `ws-${seed.suffix}`;
  const runId = `run-${seed.suffix}`;
  const rows = Array.from({ length: 83 }, (_, i) => ({
    id: `log-${seed.suffix}-${i}`, runId, phase: i % 3 === 0 ? "plan" : "apply",
    outputText: i % 7 === 0 ? "" : `${i}:héllo-✓`, createdAt: i,
  }));
  try {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId: seed.orgId });
    await db.insert(runs).values({ id: runId, workspaceId, status: "errored", createdAt: Date.now() });
    await db.insert(logs).values(rows);
    expect(await archiveRunLogs(runId)).toBe(true);
    const path = runLogArchivePath(runId);
    const original = await readFile(path);
    expect(original.subarray(-4).toString()).toBe("TRL2");

    // Fail after one chunk has reached the temporary file. The old archive
    // must remain intact and the live rows must remain available to retention.
    const handle = await open(path, "r");
    const prototype = Object.getPrototypeOf(handle) as typeof handle;
    await handle.close();
    // Invoked with the current file handle via apply below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const write = prototype.writeFile;
    let writes = 0;
    const failure = spyOn(prototype, "writeFile").mockImplementation(async function (this: typeof handle, ...args: Parameters<typeof write>) {
      if (++writes === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      await write.apply(this, args);
    });
    try {
      const error: unknown = await archiveRunLogs(runId).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "ENOSPC" });
      expect(isStorageDegraded()).toBe(true);
    } finally { failure.mockRestore(); resetStorageHealthForTests(); }
    expect(await readFile(path)).toEqual(original);
    expect((await readdir(dirname(path))).filter((name) => name.startsWith(`${runId}.json.gz.`))).toEqual([]);
    expect((await readRunLogsPage(runId, { number: 1, size: 100 })).logs).toHaveLength(83);
    await db.delete(logs).where(eq(logs.runId, runId));

    const applyRows = rows.filter((row) => row.phase === "apply");
    expect((await readRunLogsPage(runId, { number: 2, size: 20 }, "apply")).logs).toEqual(applyRows.slice(20, 40));
    const bytes = Buffer.from(applyRows.map((row) => row.outputText).join("\n"));
    for (const offset of [0, 1, 9, 31, 150, bytes.length - 1, bytes.length, bytes.length + 1]) {
      for (const limit of [0, 1, 2, 17, Infinity]) {
        const window = await readRunLogSlice(runId, "apply", offset, limit);
        expect(Buffer.from(window.bytes)).toEqual(bytes.subarray(offset, offset + limit));
        expect(window.totalBytes).toBe(bytes.length);
      }
    }

    // An unreadable first chunk must not affect a page in the final chunk.
    const corrupt = Buffer.from(original);
    corrupt[0] = 0;
    await writeFile(path, corrupt);
    expect((await readRunLogsPage(runId, { number: 3, size: 32 })).logs).toEqual(rows.slice(64));
    const error: unknown = await readRunLogsPage(runId, { number: 1, size: 20 }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);

    for (const legacy of [rows, { version: 1, totalCount: rows.length, truncated: false, logs: rows }]) {
      await writeFile(path, gzipSync(JSON.stringify(legacy)));
      expect((await readRunLogsPage(runId, { number: 2, size: 20 })).logs).toEqual(rows.slice(20, 40));
      expect(Buffer.from((await readRunLogSlice(runId, "apply", 1, 17)).bytes)).toEqual(bytes.subarray(1, 18));
    }
    const previous = await readFile(path);
    await db.insert(logs).values({ ...rows[0]!, outputText: "x".repeat(1024 * 1024 + 1) });
    const oversize: unknown = await archiveRunLogs(runId).catch((error: unknown) => error);
    expect(oversize).toBeInstanceOf(Error);
    expect(await readFile(path)).toEqual(previous);
    expect((await readRunLogsPage(runId, { number: 1, size: 20 })).totalCount).toBe(1);
    // Admission happens before any DB or archive read, and failures release it.
    const queued = Array.from({ length: 33 }, async () => archiveRunLogs(`missing-${seed.suffix}`));
    const settled = await Promise.allSettled(queued);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await archiveRunLogs(`missing-${seed.suffix}`)).toBe(false);
  } finally {
    await deleteRunLogArchive(runId);
    await db.delete(logs).where(eq(logs.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  }
});
