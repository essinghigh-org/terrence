import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { archiveRunLogs, deleteRunLogArchive, readRunLogSlice, readRunLogsPage } from "../../src/lib/run-logs";
import {
  apiTokens,
  logs,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";

// Run-log slices (issue #585): raw endpoints must serve exact byte windows
// with O(window) cost, and over-cap runs must report truncation explicitly
// instead of cutting silently.
describe("run log slices", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `logslice-org-${suffix}`;
  const auth = `user-token-${suffix}`;
  const workspaceId = `ws-logslice-${suffix}`;
  const runId = `run-logslice-${suffix}`;
  const bigRunId = `run-logslice-big-${suffix}`;

  const request = (path: string, headers: Record<string, string> = {}) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth}`, ...headers },
    }));

  const rowText = (i: number): string => `row-${i}-héllo-✓-${"x".repeat(i % 17)}`;

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token: hashAuthenticationToken(auth), userId });
    await db.insert(workspaces).values({ id: workspaceId, name: `logslice-${suffix}`, orgId });
    await db.insert(runs).values({ id: runId, workspaceId, status: "errored", createdAt: Date.now() });
    await db.insert(runs).values({ id: bigRunId, workspaceId, status: "errored", createdAt: Date.now() });
    const base = Date.now();
    await db.insert(logs).values(
      Array.from({ length: 120 }, (_, i) => ({
        id: `logslice-${suffix}-${i}`,
        runId,
        phase: "apply",
        outputText: rowText(i),
        createdAt: base + i,
      })),
    );
  });

  afterAll(async () => {
    await deleteRunLogArchive(bigRunId);
    await db.delete(logs).where(eq(logs.runId, runId));
    await db.delete(logs).where(eq(logs.runId, bigRunId));
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("serves byte-exact windows of the joined stream", async () => {
    const reference = Buffer.from(Array.from({ length: 120 }, (_, i) => rowText(i)).join("\n"), "utf8");
    const probes: readonly (readonly [number, number])[] = [
      [0, Number.POSITIVE_INFINITY],
      [0, 0],
      [1, 1],
      [2, 3],
      [3, 7],
      [5, 64],
      [8, 9],
      [reference.length - 1, 10],
      [reference.length, 10],
      [reference.length + 100, 10],
      [Math.floor(reference.length / 2), 33],
      [Math.floor(reference.length / 3), 1000],
    ];
    for (const [offset, limit] of probes) {
      const slice = await readRunLogSlice(runId, "apply", offset, limit);
      const end = Number.isFinite(limit) ? Math.min(offset + limit, reference.length) : reference.length;
      expect(slice.text).toBe(offset >= reference.length ? "" : reference.subarray(offset, Math.max(offset, end)).toString("utf8"));
      expect(slice.totalBytes).toBe(reference.length);
      expect(slice.totalCount).toBe(120);
      expect(slice.truncated).toBe(false);
    }
  });

  it("reports the true total on over-cap runs and marks archived truncation", async () => {
    const base = Date.now();
    const total = 10005;
    for (let start = 0; start < total; start += 500) {
      const end = Math.min(start + 500, total);
      const batch = [];
      for (let i = start; i < end; i++) {
        batch.push({ id: `logslice-big-${suffix}-${i}`, runId: bigRunId, phase: "apply", outputText: `line-${i}`, createdAt: base + i });
      }
      await db.insert(logs).values(batch);
    }

    const live = await readRunLogsPage(bigRunId, { number: 1, size: 20 });
    expect(live.totalCount).toBe(total);
    expect(live.truncated).toBe(false);

    const full = await readRunLogSlice(bigRunId, "apply", 0, Number.POSITIVE_INFINITY);
    expect(full.totalCount).toBe(total);
    expect(full.truncated).toBe(false);
    expect(full.text).toBe(Array.from({ length: total }, (_, i) => `line-${i}`).join("\n"));

    expect(await archiveRunLogs(bigRunId)).toBe(true);
    await db.delete(logs).where(eq(logs.runId, bigRunId));

    const archived = await readRunLogSlice(bigRunId, "apply", 0, Number.POSITIVE_INFINITY);
    expect(archived.truncated).toBe(true);
    expect(archived.totalCount).toBe(total);
    expect(archived.text).toBe(Array.from({ length: 10000 }, (_, i) => `line-${i}`).join("\n"));

    const archivedPage = await readRunLogsPage(bigRunId, { number: 1, size: 20 });
    expect(archivedPage.totalCount).toBe(total);
    expect(archivedPage.truncated).toBe(true);
  });

  it("raw endpoint serves windows with truncation headers; paged meta reports truncated", async () => {
    const full = await request(`/api/v2/runs/${runId}/apply/log`);
    expect(full.status).toBe(200);
    expect(full.headers.get("X-Terrence-Log-Truncated")).toBe("false");
    const totalBytes = Number(full.headers.get("X-Terrence-Log-Total-Bytes"));
    expect(Number.isSafeInteger(totalBytes)).toBe(true);

    const window = await request(`/api/v2/runs/${runId}/apply/log?offset=2&limit=3`);
    expect(window.status).toBe(200);
    expect(await window.text()).toBe(Buffer.from(
      Array.from({ length: 120 }, (_, i) => rowText(i)).join("\n"),
      "utf8",
    ).subarray(2, 5).toString("utf8"));

    const paged = await request(`/api/v2/runs/${runId}/logs?page[number]=1&page[size]=20`);
    expect(paged.status).toBe(200);
    const document = await paged.json() as { meta: { truncated: boolean; pagination: { "total-count": number } } };
    expect(document.meta.truncated).toBe(false);
    expect(document.meta.pagination["total-count"]).toBe(120);
  });
});
