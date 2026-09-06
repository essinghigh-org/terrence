import { expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { logs, runs, workspaces } from "../../src/db/schema";
import { archiveRunLogs, deleteRunLogArchive, readRunLogsPage } from "../../src/lib/run-logs";
import { cleanupSeed, jsonHeaders, persistSeed, request, seedOrg } from "./compat_contract_helpers";

// TERRENCE_BINARY_CACHE_DIR=/tmp/empty-archive-benchmark-cache LOG_ARCHIVE_LOAD=1 bun test tests/api/run_log_archive_load.test.ts
// Use an empty cache: startup binary integrity verification is separate work.
// Opt-in: ordinary test runs do not allocate the two 16 MiB log fixtures.
test.skipIf(process.env["LOG_ARCHIVE_LOAD"] !== "1")("measures status responsiveness during large archive writes and reads", async () => {
  const seed = seedOrg("archive-load");
  const runId = `run-${seed.suffix}`;
  const archivedRunId = `run-archived-${seed.suffix}`;
  const workspaceId = `ws-${seed.suffix}`;
  const delays: number[] = [];
  const latencies: number[] = [];
  const startingRss = process.memoryUsage().rss;
  let lastTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - lastTick - 5));
    lastTick = now;
  }, 5);
  try {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId: seed.orgId });
    for (const id of [runId, archivedRunId]) {
      await db.insert(runs).values({ id, workspaceId, status: "errored", createdAt: Date.now() });
      for (let offset = 0; offset < 2000; offset += 100) {
        await db.insert(logs).values(Array.from({ length: 100 }, (_, i) => ({
          id: `log-${id}-${offset + i}`, runId: id, phase: "plan",
          outputText: `${offset + i}:` + "0123456789abcdef".repeat(512), createdAt: offset + i,
        })));
      }
    }
    await archiveRunLogs(archivedRunId);
    await db.delete(logs).where(eq(logs.runId, archivedRunId));
    delays.length = 0;
    lastTick = performance.now();
    const monitor = Promise.all(Array.from({ length: process.env["LOG_ARCHIVE_STATUS"] === "0" ? 0 : 40 }, async () => {
      const start = performance.now();
      const response = await request(`/api/v2/runs/${runId}`, { headers: jsonHeaders(seed.token) });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      latencies.push(performance.now() - start);
    }));
    try {
      await Promise.all([
        ...Array.from({ length: 4 }, () => archiveRunLogs(runId)),
        ...Array.from({ length: 8 }, async () => {
          const page = await readRunLogsPage(archivedRunId, { number: 1, size: 20 });
          expect(page.logs).toHaveLength(20);
        }),
      ]);
    } finally { await monitor; }
    const p95 = (values: number[]): number => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? 0;
    const report = { phase: process.env["LOG_ARCHIVE_PHASE"] ?? "after", rowsPerRun: 2000, payloadBytesPerRun: 2000 * 8192, statusRequests: latencies.length, statusP95Ms: p95(latencies), statusMaxMs: Math.max(0, ...latencies), eventLoopP95Ms: p95(delays), eventLoopMaxMs: Math.max(0, ...delays), startingRss, kernelPeakRss: process.resourceUsage().maxRSS * 1024 };
    console.log("LOG_ARCHIVE_LOAD_RESULT " + JSON.stringify(report));
    const reportPath = process.env["LOG_ARCHIVE_REPORT"];
    if (reportPath) await Bun.write(reportPath, JSON.stringify(report, null, 2));
  } finally {
    clearInterval(timer);
    await deleteRunLogArchive(runId);
    await deleteRunLogArchive(archivedRunId);
    await db.delete(logs).where(inArray(logs.runId, [runId, archivedRunId]));
    await db.delete(runs).where(inArray(runs.id, [runId, archivedRunId]));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  }
}, 120000);
