import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, configurationVersions, logs, organizationMemberships, organizations, runs, users, workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { and, eq } from "drizzle-orm";

// Issue #567: workspaces with local execution mode must never run remotely.
// Run creation is rejected with 422, VCS-triggered creation is skipped, and
// the worker errors (with an explanation) any legacy pending/confirmed rows
// instead of executing them or leaving them stuck.
describe("local execution mode never runs remotely (#567)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const userId = `usr-local-${suffix}`;
  const orgId = `org-local-${suffix}`;
  const orgName = `local-${suffix}`;
  const token = `token-local-${suffix}`;
  const localWsId = `ws-local-${suffix}`;
  const remoteWsId = `ws-remote-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const createRun = (workspaceId: string) => request("/api/v2/runs", "POST", {
    data: {
      type: "runs",
      attributes: { message: "local mode probe" },
      relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } },
    },
  });

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(workspaces).values([
      { id: localWsId, name: `local-ws-${suffix}`, orgId, executionMode: "local" },
      { id: remoteWsId, name: `remote-ws-${suffix}`, orgId, executionMode: "remote" },
    ]);
    // Issue #574 rejects CV-less run creation, which is orthogonal to what
    // this file probes: seed one uploaded configuration so the remote
    // workspace accepts runs for the execution-mode assertions below.
    await db.insert(configurationVersions).values({
      id: `cv-remote-${suffix}`,
      workspaceId: remoteWsId,
      status: "uploaded",
      archivePath: `test-only/cv-remote-${suffix}.tar.gz`,
    });
  });

  afterAll(async () => {
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, remoteWsId)).catch((): void => {});
    await db.delete(logs).where(eq(logs.runId, `run-local-pending-${suffix}`)).catch((): void => {});
    await db.delete(logs).where(eq(logs.runId, `run-local-confirmed-${suffix}`)).catch((): void => {});
    await db.delete(runs).where(eq(runs.workspaceId, localWsId)).catch((): void => {});
    await db.delete(runs).where(eq(runs.workspaceId, remoteWsId)).catch((): void => {});
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId)).catch((): void => {});
    await db.delete(apiTokens).where(eq(apiTokens.id, `tok-${suffix}`)).catch((): void => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`)).catch((): void => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch((): void => {});
    await db.delete(users).where(eq(users.id, userId)).catch((): void => {});
  });

  it("rejects remote run creation on local workspaces with 422", async () => {
    const res = await createRun(localWsId);
    expect(res.status).toBe(422);
    const body = await res.json() as { errors?: { detail?: string }[] };
    expect(body.errors?.[0]?.detail).toContain("local execution mode");
  });

  it("still creates runs on remote workspaces", async () => {
    const res = await createRun(remoteWsId);
    expect(res.status).toBe(201);
    // Remove it immediately so the worker-poll test below observes only the
    // local-workspace fixture (the shared per-file DB would otherwise let
    // the poller claim this run too).
    const body = await res.json() as { data: { id: string } };
    await db.delete(runs).where(eq(runs.id, body.data.id));
  });

  it("errors legacy pending runs on local workspaces instead of executing them", async () => {
    const { pollWorkerQueue } = await import("../../src/worker");
    await db.insert(runs).values({
      id: `run-local-pending-${suffix}`,
      workspaceId: localWsId,
      status: "pending",
      logToken: crypto.randomUUID(),
      createdAt: Date.now(),
    });
    await pollWorkerQueue();
    const row = await db.query.runs.findFirst({ where: eq(runs.id, `run-local-pending-${suffix}`) });
    expect(row?.status).toBe("errored");
    const logRows = await db.query.logs.findMany({
      where: and(eq(logs.runId, `run-local-pending-${suffix}`), eq(logs.phase, "plan")),
    });
    expect(logRows.map((l): string => l.outputText).join("\n")).toContain("local execution mode");
  });

  it("errors legacy confirmed applies on local workspaces instead of dispatching them", async () => {
    const { applyDueScheduledRuns } = await import("../../src/worker");
    await db.insert(runs).values({
      id: `run-local-confirmed-${suffix}`,
      workspaceId: localWsId,
      status: "confirmed",
      scheduledAt: Date.now() - 1000,
      logToken: crypto.randomUUID(),
      createdAt: Date.now(),
    });
    await applyDueScheduledRuns();
    const row = await db.query.runs.findFirst({ where: eq(runs.id, `run-local-confirmed-${suffix}`) });
    expect(row?.status).toBe("errored");
    const logRows = await db.query.logs.findMany({
      where: and(eq(logs.runId, `run-local-confirmed-${suffix}`), eq(logs.phase, "apply")),
    });
    expect(logRows.map((l): string => l.outputText).join("\n")).toContain("local execution mode");
  });
});
