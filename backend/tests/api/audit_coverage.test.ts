import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { and, eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  auditLogs,
  organizations,
  runs,
  stateVersions,
  users,
  workspaces,
} from "../../src/db/schema";

const suffix = crypto.randomUUID();
const userId = `audit-user-${suffix}`;
const token = `audit-token-${suffix}`;
const orgName = `audit-org-${suffix}`;
const workspaceName = `audit-workspace-${suffix}`;
const secretMarker = `must-not-be-audited-${suffix}`;
const runIds = {
  apply: `audit-apply-${suffix}`,
  discard: `audit-discard-${suffix}`,
  cancel: `audit-cancel-${suffix}`,
  forceCancel: `audit-force-cancel-${suffix}`,
  override: `audit-override-${suffix}`,
} as const;

let orgId = "";
let workspaceId = "";
let projectId: string | null = null;

function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

beforeAll(async () => {
  await db.insert(users).values({
    id: userId,
    username: `audit-user-${suffix}`,
    email: `audit-user-${suffix}@example.com`,
    passwordHash: "unused",
  });
  await db.insert(apiTokens).values({
    id: `audit-token-id-${suffix}`,
    token: hashAuthenticationToken(token),
    userId,
  });

  const orgResponse = await request("/api/v2/organizations", "POST", {
    data: {
      type: "organizations",
      attributes: {
        name: orgName,
        "ignored-secret": secretMarker,
      },
    },
  });
  expect(orgResponse.status).toBe(201);
  orgId = (await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) }))?.id ?? "";

  const workspaceResponse = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
    data: {
      type: "workspaces",
      attributes: {
        name: workspaceName,
        description: secretMarker,
        "source-url": `https://example.invalid/${secretMarker}`,
      },
    },
  });
  expect(workspaceResponse.status).toBe(201);
  workspaceId = ((await workspaceResponse.json()) as { data: { id: string } }).data.id;
  projectId = (await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { projectId: true },
  }))?.projectId ?? null;

  await db.insert(runs).values([
    { id: runIds.apply, workspaceId, status: "planned", createdAt: Date.now() },
    { id: runIds.discard, workspaceId, status: "pending", createdAt: Date.now() },
    { id: runIds.cancel, workspaceId, status: "planning", createdAt: Date.now() },
    {
      id: runIds.forceCancel,
      workspaceId,
      status: "applying",
      statusTimestamps: { "cancel-requested-at": new Date().toISOString() },
      createdAt: Date.now(),
    },
    { id: runIds.override, workspaceId, status: "policy_soft_failed", createdAt: Date.now() },
  ]);
});

afterAll(async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const applyRun = await db.query.runs.findFirst({
      where: eq(runs.id, runIds.apply),
      columns: { status: true },
    });
    if (applyRun === undefined || !["confirmed", "apply_queued", "applying"].includes(applyRun.status)) break;
    await Bun.sleep(10);
  }
  if (orgId !== "") await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(apiTokens).where(eq(apiTokens.token, token));
  await db.delete(users).where(eq(users.id, userId));
});

describe("audit coverage", () => {
  it("audits organization and workspace creation without copying request data", async () => {
    const [organizationAudit, workspaceAudit] = await Promise.all([
      db.query.auditLogs.findFirst({
        where: and(
          eq(auditLogs.action, "create"),
          eq(auditLogs.resourceType, "organizations"),
          eq(auditLogs.resourceId, orgId),
        ),
      }),
      db.query.auditLogs.findFirst({
        where: and(
          eq(auditLogs.action, "create"),
          eq(auditLogs.resourceType, "workspaces"),
          eq(auditLogs.resourceId, workspaceId),
        ),
      }),
    ]);

    expect(organizationAudit).toMatchObject({
      orgId,
      userId,
      details: { name: orgName },
    });
    expect(workspaceAudit).toMatchObject({
      orgId,
      userId,
      details: { name: workspaceName, projectId },
    });
    expect(JSON.stringify([organizationAudit?.details, workspaceAudit?.details])).not.toContain(secretMarker);
  });

  it("returns authorized audit trails with actor identity", async () => {
    const [organizationTrailersResponse, auditTrailsResponse] = await Promise.all([
      request("/api/v2/organization-audit-trailers"),
      request("/api/v2/audit-trails"),
    ]);
    expect(organizationTrailersResponse.status).toBe(200);
    expect(auditTrailsResponse.status).toBe(200);

    for (const response of [organizationTrailersResponse, auditTrailsResponse]) {
      const body = await response.json() as { data: { type: string; attributes: Record<string, unknown> }[] };
      const entry = body.data.find(({ attributes }) => attributes["resource-id"] === orgId);
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({
        type: "audit-logs",
        attributes: {
          action: "create",
          "actor-username": `audit-user-${suffix}`,
          "actor-email": `audit-user-${suffix}@example.com`,
        },
      });
    }
  });

  it("audits run creation with safe actor-aware activity details", async () => {
    const response = await request(`/api/v2/workspaces/${workspaceId}/runs`, "POST", {
      data: {
        type: "runs",
        attributes: { message: "Audit creation activity" },
      },
    });
    expect(response.status).toBe(201);
    const runId = ((await response.json()) as { data: { id: string } }).data.id;

    const eventsResponse = await request(`/api/v2/runs/${runId}/run-events`);
    expect(eventsResponse.status).toBe(200);
    const events = (await eventsResponse.json()) as {
      data: { attributes: Record<string, unknown> }[];
    };
    expect(events.data).toHaveLength(1);
    expect(events.data[0]?.attributes).toMatchObject({
      action: "create",
      "actor-username": `audit-user-${suffix}`,
      details: {
        workspaceId,
        status: "pending",
        source: "tfe-api",
      },
    });
  });

  it("audits raw state downloads with actor identity (kanban 17.8)", async () => {
    const stateVersionId = `audit-state-${suffix}`;
    await db.insert(stateVersions).values({
      id: stateVersionId,
      workspaceId,
      serial: 1,
      status: "finalized",
      jsonState: JSON.stringify({ version: 4, terraform_version: "1.9.3" }),
      statePayload: JSON.stringify({ version: 4, serial: 1 }),
    });

    const [jsonResponse, downloadResponse] = await Promise.all([
      request(`/api/v2/state-versions/${stateVersionId}/json-download`),
      request(`/api/v2/state-versions/${stateVersionId}/download`),
    ]);
    expect(jsonResponse.status).toBe(200);
    expect(downloadResponse.status).toBe(200);

    const reads = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.action, "read"),
        eq(auditLogs.resourceType, "state-version"),
        eq(auditLogs.resourceId, stateVersionId),
      ),
    });
    expect(reads).toHaveLength(2);
    const endpoints = new Set(reads.map((read): unknown => (read.details as Record<string, unknown>)["endpoint"]));
    expect(endpoints).toEqual(new Set(["json-download", "download"]));
    for (const read of reads) {
      expect(read).toMatchObject({ orgId, userId, details: { workspaceId } });
    }
  });

  it("audits successful run transitions and exposes safe actor-aware run events", async () => {
    const transitions = [
      { action: "apply", runId: runIds.apply, fromStatus: "planned", toStatus: "confirmed" },
      { action: "discard", runId: runIds.discard, fromStatus: "pending", toStatus: "discarded" },
      { action: "cancel", runId: runIds.cancel, fromStatus: "planning", toStatus: "canceled" },
      { action: "force-cancel", runId: runIds.forceCancel, fromStatus: "applying", toStatus: "force_canceled" },
      { action: "override-policy", runId: runIds.override, fromStatus: "policy_soft_failed", toStatus: "planned" },
    ] as const;

    for (const transition of transitions) {
      const response = await request(
        `/api/v2/runs/${transition.runId}/actions/${transition.action}`,
        "POST",
        transition.action === "apply" ? { comment: secretMarker } : undefined,
      );
      expect(response.status).toBe(transition.action === "override-policy" ? 200 : 202);
    }

    const entries = await db.query.auditLogs.findMany({
      where: inArray(auditLogs.resourceId, transitions.map(({ runId }): string => runId)),
    });
    expect(entries).toHaveLength(transitions.length);

    for (const transition of transitions) {
      expect(entries.find(({ resourceId }): boolean => resourceId === transition.runId)).toMatchObject({
        action: transition.action,
        resourceType: "runs",
        resourceId: transition.runId,
        userId,
        orgId,
        details: {
          workspaceId,
          fromStatus: transition.fromStatus,
          toStatus: transition.toStatus,
        },
      });
    }
    expect(JSON.stringify(entries.map(({ details }) => details))).not.toContain(secretMarker);

    const repeat = await request(`/api/v2/runs/${runIds.discard}/actions/discard`, "POST");
    expect(repeat.status).toBe(409);
    expect((await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.action, "discard"), eq(auditLogs.resourceId, runIds.discard)),
    }))).toHaveLength(1);

    await db.insert(auditLogs).values({
      id: `audit-run-created-${suffix}`,
      orgId,
      userId,
      action: "create",
      resourceType: "runs",
      resourceId: runIds.override,
      details: {
        fromStatus: "pending",
        toStatus: "planned",
        unsafe: secretMarker,
      },
      createdAt: 0,
    });
    const runEventsResponse = await request(`/api/v2/runs/${runIds.override}/run-events`);
    expect(runEventsResponse.status).toBe(200);
    const runEvents = (await runEventsResponse.json()) as {
      data: {
        type: string;
        attributes: Record<string, unknown>;
      }[];
    };
    expect(runEvents.data.map(({ attributes }): unknown => attributes["action"])).toEqual(["create", "override-policy"]);
    expect(runEvents.data[0]).toMatchObject({
      type: "run-events",
      attributes: {
        action: "create",
        "actor-username": `audit-user-${suffix}`,
        details: { fromStatus: "pending", toStatus: "planned" },
      },
    });
    expect(runEvents.data[0]?.attributes["created-at"]).toBeString();
    expect(JSON.stringify(runEvents.data)).not.toContain(secretMarker);
  });
});