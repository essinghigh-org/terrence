import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizations, runs, workspaces } from "../../src/db/schema";
import { eq } from "drizzle-orm";

// Issue #609: the request-completed log line must carry the redacted path
// when the URL holds a bearer token — exercised here through the real run
// log capability URLs (no auth required, like production polling).
const suffix = crypto.randomUUID();
const orgId = `org-logredact-${suffix}`;
const wsId = `ws-logredact-${suffix}`;
const runId = `run-logredact-${suffix}`;
const logToken = `log-token-${suffix}`;

function request(path: string): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, { method: "GET" }));
}

function loggedPaths(calls: unknown[][]): string[] {
  const paths: string[] = [];
  for (const call of calls) {
    try {
      const parsed = JSON.parse(call[0] as string) as {
        message?: unknown;
        meta?: { http?: { path?: unknown } };
      };
      if (parsed.message === "request completed" && typeof parsed.meta?.http?.path === "string") {
        paths.push(parsed.meta.http.path);
      }
    } catch {
      // Non-JSON console output is not a request log line.
    }
  }
  return paths;
}

beforeAll(async () => {
  await db.insert(organizations).values({ id: orgId, name: `logredact-${suffix}` });
  await db.insert(workspaces).values({ id: wsId, name: `logredact-${suffix}`, orgId });
  await db.insert(runs).values({ id: runId, workspaceId: wsId, status: "planned", logToken, createdAt: Date.now() });
});

afterAll(async () => {
  await db.delete(runs).where(eq(runs.id, runId));
  await db.delete(workspaces).where(eq(workspaces.id, wsId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
});

test("request log redacts the run log capability token (#609)", async () => {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    const ok = await request(`/api/v2/runs/${runId}/plan/log/${logToken}`);
    expect(ok.status).toBe(200);
    const denied = await request(`/api/v2/runs/${runId}/apply/log/wrong-token`);
    expect(denied.status).toBe(404);
    const paths = loggedPaths(logSpy.mock.calls);
    expect(paths.length).toBe(2);
    for (const path of paths) {
      expect(path).not.toContain(logToken);
      expect(path).not.toContain("wrong-token");
    }
    expect(paths[0]).toBe(`/api/v2/runs/${runId}/plan/log/[REDACTED]`);
    expect(paths[1]).toBe(`/api/v2/runs/${runId}/apply/log/[REDACTED]`);
  } finally {
    logSpy.mockRestore();
  }
});
