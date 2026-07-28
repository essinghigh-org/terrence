import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  auditLogs,
  organizations,
  runs,
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
    passwordHash: "unused",
  });
  await db.insert(apiTokens).values({
    id: `audit-token-id-${suffix}`,
    token,
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
  orgId = ((await orgResponse.json()) as { data: { id: string } }).data.id;

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
    { id: runIds.forceCancel, workspaceId, status: "applying", createdAt: Date.now() },
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

  it("audits successful apply, discard, cancel, and force-cancel transitions", async () => {
    const transitions = [
      { action: "apply", runId: runIds.apply, fromStatus: "planned", toStatus: "confirmed" },
      { action: "discard", runId: runIds.discard, fromStatus: "pending", toStatus: "discarded" },
      { action: "cancel", runId: runIds.cancel, fromStatus: "planning", toStatus: "canceled" },
      { action: "force-cancel", runId: runIds.forceCancel, fromStatus: "applying", toStatus: "force_canceled" },
    ] as const;

    for (const transition of transitions) {
      const response = await request(
        `/api/v2/runs/${transition.runId}/actions/${transition.action}`,
        "POST",
        transition.action === "apply" ? { comment: secretMarker } : undefined,
      );
      expect(response.status).toBe(200);
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
  });
});
