import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db, getQueryCount, resetQueryCount } from "../../src/db";
import { runs, workspaces, workspaceTags } from "../../src/db/schema";
import { cleanupSeed, persistSeed, seedOrg } from "./compat_contract_helpers";
import { createBrowser, type BrowserPage } from "../../../frontend/tests/browser/helpers/browser";
import { startStaticServer, type TestServer } from "../../../frontend/tests/browser/helpers/server";

// Opt-in real-browser measurement; ordinary unit runs do not seed 10k workspaces.
// WORKSPACE_SCALE=1 TERRENCE_QUERY_COUNT=1 xvfb-run -a bun test tests/api/workspace_list_scale.test.ts
// Use WORKSPACE_SCALE_PHASE=before on the baseline checkout with its own frontend build.
test.skipIf(process.env["WORKSPACE_SCALE"] !== "1")("measures a real 10000-workspace list without loading state or providers", async () => {
  const seed = seedOrg("scale");
  let browser: BrowserPage | undefined;
  let server: TestServer | undefined;
  let api: ReturnType<typeof Bun.serve> | undefined;
  const previousApi = process.env["TERRENCE_API_URL"];
  const phase = process.env["WORKSPACE_SCALE_PHASE"] ?? "after";
  const workspacePath = `/api/v2/organizations/${seed.orgName}/workspaces`;
  const workspaceTimes: number[] = [];
  const workspaceQueries: string[] = [];
  let bytes = 0;
  try {
    await persistSeed(seed);
    for (let offset = 0; offset < 10000; offset += 100) {
      const batch = Array.from({ length: 100 }, (_, j) => ({ id: `ws-${seed.suffix}-${offset + j}`, orgId: seed.orgId, name: `workspace-${String(offset + j).padStart(5, "0")}` }));
      await db.insert(workspaces).values(batch);
      await db.insert(workspaceTags).values(batch.map((workspace) => ({ id: `tag-${workspace.id}`, workspaceId: workspace.id, key: "scale" })));
      await db.insert(runs).values(batch.flatMap((workspace) => [
        { id: `old-${workspace.id}`, workspaceId: workspace.id, status: "errored", createdAt: 1 },
        { id: `new-${workspace.id}`, workspaceId: workspace.id, status: "applied", createdAt: 2 },
      ]));
    }
    api = Bun.serve({ port: 0, async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      // Only session bootstrap is stubbed; list authorization and every query use the real application.
      if (url.pathname === "/api/v2/users/refresh") return Response.json({ data: { type: "sessions", id: "scale-session", attributes: { token: seed.token, "expired-at": new Date(Date.now() + 3600000).toISOString() } } });
      const start = performance.now();
      const response = await app.handle(req);
      if (url.pathname !== workspacePath) return response;
      workspaceQueries.push(url.search);
      const body = await response.arrayBuffer();
      workspaceTimes.push(performance.now() - start);
      bytes += body.byteLength;
      return new Response(body, { status: response.status, headers: response.headers });
    } });
    process.env["TERRENCE_API_URL"] = `http://127.0.0.1:${api.port}`;
    server = await startStaticServer();
    browser = await createBrowser({ width: 1440, height: 1000 });
    resetQueryCount();
    const start = performance.now();
    await browser.goto(`${server.baseUrl}/app/${seed.orgName}`);
    await browser.waitForSelector(`a[href="/app/${seed.orgName}/workspaces/workspace-00000"]`, { timeout: 120000 });
    const firstUsefulMs = performance.now() - start;
    const rowCount = await browser.evaluate<number>("document.querySelectorAll('tbody tr').length");
    await browser.webview.cdp("HeapProfiler.collectGarbage");
    const heap = await browser.webview.cdp("Runtime.getHeapUsage") as { usedSize: number; embedderHeapUsedSize?: number };
    expect(typeof heap.usedSize).toBe("number");
    const sorted = [...workspaceTimes].sort((a, b) => a - b);
    const report = {
      phase, workspaces: 10000, runs: 20000, renderedRows: rowCount,
      workspaceRequests: workspaceTimes.length, workspaceQueries, responseBytes: bytes,
      firstUsefulMs: Math.round(firstUsefulMs),
      serverRequestMs: { total: workspaceTimes.reduce((a, b) => a + b, 0), p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] },
      uiDatabaseQueries: getQueryCount(), browserJsHeapBytes: heap.usedSize,
      browserEmbedderHeapBytes: heap.embedderHeapUsedSize ?? null,
    };
    console.log("WORKSPACE_SCALE_RESULT " + JSON.stringify(report));
    const reportPath = process.env["WORKSPACE_SCALE_REPORT"];
    if (reportPath) await Bun.write(reportPath, JSON.stringify(report, null, 2) + "\n");
    if (phase !== "before") {
      expect(rowCount).toBe(50);
      expect(workspaceTimes).toHaveLength(1);
      expect(bytes).toBeLessThan(1000000);
    }
  } finally {
    browser?.close();
    await server?.close();
    await api?.stop(true);
    if (previousApi === undefined) delete process.env["TERRENCE_API_URL"];
    else process.env["TERRENCE_API_URL"] = previousApi;
    const ids = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, seed.orgId));
    const { inArray } = await import("drizzle-orm");
    await db.delete(runs).where(inArray(runs.workspaceId, ids));
    await db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId));
    await cleanupSeed(seed);
  }
}, 180000);
