import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { runs, workspaces } from "../../src/db/schema";
import {
  cleanupSeed,
  expectCollection,
  expectErrorResponse,
  expectNoContent,
  expectPaginationMeta,
  expectSelfLink,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedTfeOrg,
} from "./tfe_contract_helpers";

describe("TFE runs contract", () => {
  const seed = seedTfeOrg("run");
  const headers = jsonHeaders(seed.token);
  const workspaceId = `workspace-${seed.suffix}`;
  let runId = "";

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: `runs-${seed.suffix}`, orgId: seed.orgId });
  });

  afterAll(async () => {
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  it("creates a run with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "runs",
            attributes: { message: "contract test run" },
          },
        }),
      }),
      201,
      "runs",
    );
    runId = resource.id;
        // TFE emits ids prefixed with "run-"; Terrence uses bare UUIDs (opaque to clients).
    expect(runId).toBeTypeOf("string");
    expect(runId).not.toBe("");
    expect(resource.attributes.status).toBe("pending");
    expect(resource.attributes.message).toBe("contract test run");
    expect(resource.attributes["auto-apply"]).toBe(false);
    expect(resource.attributes["is-destroy"]).toBe(false);
    expect(resource.attributes["has-changes"]).toBe(false);
    expect(resource.attributes.source).toBe("tfe-api");
    expect(resource.attributes["trigger-reason"]).toBe("manual");
    expect(resource.attributes["plan-only"]).toBe(false);
    expect(resource.attributes["allow-empty-apply"]).toBe(false);
    expect(resource.attributes["allow-config-generation"]).toBe(false);
    expect(resource.attributes.actions).toMatchObject({
      "is-cancelable": expect.any(Boolean),
      "is-confirmable": expect.any(Boolean),
      "is-discardable": expect.any(Boolean),
      "is-force-cancelable": expect.any(Boolean),
    });
    expect(resource.attributes["status-timestamps"]).toBeTypeOf("object");
    expect(resource.attributes["created-at"]).toBeTypeOf("string");
    expect(resource.attributes.permissions).toMatchObject({
      "can-apply": expect.any(Boolean),
      "can-cancel": expect.any(Boolean),
      "can-discard": expect.any(Boolean),
      "can-comment": expect.any(Boolean),
    });
    expect(resource.relationships?.workspace).toMatchObject({
      data: { id: workspaceId, type: "workspaces" },
    });
    expect(resource.relationships?.plan).toMatchObject({
      data: { id: `plan-${runId}`, type: "plans" },
    });
    expect(resource.relationships?.apply).toMatchObject({
      data: { id: `apply-${runId}`, type: "applies" },
    });
    expect(resource.relationships?.["created-by"]).toMatchObject({
      data: { id: seed.userId, type: "users" },
    });
    expectSelfLink(resource, "/api/v2/runs/");
  });

  it("shows a run", async () => {
    const resource = await expectSuccessResponse(await request(`/api/v2/runs/${runId}`, { headers }), 200, "runs");
    expect(resource.attributes.status).toBe("pending");
    expect(resource.attributes["status-timestamps"]).toBeTypeOf("object");
  });

  it("lists runs for a workspace with pagination metadata", async () => {
    const response = await request(`/api/v2/workspaces/${workspaceId}/runs?page[number]=1&page[size]=10`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "runs");
    expect(items.map((r) => r.id)).toContain(runId);
    expectPaginationMeta(body);
  });

  it("lists runs for an organization with pagination metadata", async () => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/runs?page[number]=1&page[size]=10`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const items = expectCollection(body, "runs");
    expect(items.map((r) => r.id)).toContain(runId);
    expectPaginationMeta(body);
  });

  it("supports search filters on organization runs", async () => {
    const response = await request(
      `/api/v2/organizations/${seed.orgName}/runs?search[commit]=abc&search[user]=def&page[number]=1&page[size]=10`,
      { headers },
    );
    expect(response.status).toBe(200);
    expectCollection(await response.json(), "runs");
  });

  it("lists runs for the organization run queue", async () => {
    const response = await request(`/api/v2/organizations/${seed.orgName}/runs/queue?page[number]=1&page[size]=10`, {
      headers,
    });
    expect(response.status).toBe(200);
    expectCollection(await response.json(), "runs");
  });

  it("shows run events", async () => {
    const response = await request(`/api/v2/runs/${runId}/run-events`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    for (const item of body.data) {
      expect(item).toMatchObject({ type: "run-events" });
    }
  });

  it("shows plan and apply resources for the run", async () => {
    const plan = await expectSuccessResponse(await request(`/api/v2/runs/${runId}/plan`, { headers }), 200, "plans");
    expect(plan.id).toBe(`plan-${runId}`);
    expect(plan.attributes.status).toBeTypeOf("string");
    expectSelfLink(plan, "/api/v2/plans/");

    const apply = await expectSuccessResponse(await request(`/api/v2/applies/apply-${runId}`, { headers }), 200, "applies");
    expect(apply.id).toBe(`apply-${runId}`);
    expect(apply.attributes.status).toBeTypeOf("string");
    expect(apply.attributes["status-timestamps"]).toBeTypeOf("object");
    expectSelfLink(apply, "/api/v2/applies/");
  });

  it("lists comments for the run", async () => {
    const response = await request(`/api/v2/runs/${runId}/comments`, { headers });
    expect(response.status).toBe(200);
    expectCollection(await response.json(), "comments");
  });

  it("schedules a future apply and rejects invalid times (21.4)", async () => {
    const scheduledRunId = `run-${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: scheduledRunId,
      workspaceId,
      status: "planned",
      createdAt: Date.now(),
    });
    try {
      // A past time is rejected while the run is still planned.
      const past = await request(`/api/v2/runs/${scheduledRunId}/actions/schedule-apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ data: { type: "runs", attributes: { "apply-at": new Date(Date.now() - 60_000).toISOString() } } }),
      });
      expect(past.status).toBe(422);

      const future = new Date(Date.now() + 7_200_000).toISOString();
      const scheduled = await request(`/api/v2/runs/${scheduledRunId}/actions/schedule-apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ data: { type: "runs", attributes: { "apply-at": future } } }),
      });
      expect(scheduled.status).toBe(200);
      const body = (await scheduled.json()) as { data: { attributes: { status: string; "scheduled-at"?: string } } };
      expect(body.data.attributes.status).toBe("confirmed");
      expect(body.data.attributes["scheduled-at"]).toBe(future);
      const row = await db.query.runs.findFirst({ where: eq(runs.id, scheduledRunId) });
      expect(row?.scheduledAt).toBe(Date.parse(future));
      expect(row?.status).toBe("confirmed");

      // Scheduling an already-confirmed run is rejected (needs a saved plan).
      const again = await request(`/api/v2/runs/${scheduledRunId}/actions/schedule-apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ data: { type: "runs", attributes: { "apply-at": new Date(Date.now() + 3_600_000).toISOString() } } }),
      });
      expect(again.status).toBe(409);
    } finally {
      await db.delete(runs).where(eq(runs.id, scheduledRunId));
    }
  });

  it("discards and then destroys a run", async () => {
    const discard = await request(`/api/v2/runs/${runId}/actions/discard`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data: { type: "runs", attributes: { comment: "Discarded after review" } } }),
    });
    expect(discard.status).toBe(200);
    const comments = await request(`/api/v2/runs/${runId}/comments`, { headers });
    expect((await comments.json()).data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attributes: expect.objectContaining({ body: "Discarded after review" }),
      }),
    ]));
    await expectNoContent(await request(`/api/v2/runs/${runId}`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/runs/${runId}`, { headers }), 404);
  });
});
