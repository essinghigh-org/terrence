import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { apiTokens, runs, workspaces, configurationVersions } from "../../src/db/schema";
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
  seedOrg,
} from "./compat_contract_helpers";

describe("remote-workflow runs contract", () => {
  const seed = seedOrg("run");
  const headers = jsonHeaders(seed.token);
  const orgToken = `org-token-${seed.suffix}`;
  const orgHeaders = jsonHeaders(orgToken);
  const workspaceId = `workspace-${seed.suffix}`;
  const includedRunId = `run-included-${seed.suffix}`;
  const configurationVersionId = `cv-${seed.suffix}`;
  let runId = "";

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: `runs-${seed.suffix}`, orgId: seed.orgId });
    await db.insert(apiTokens).values({
      id: `token-org-${seed.suffix}`,
      token: createHash("sha256").update(orgToken).digest("hex"),
      orgId: seed.orgId,
    });
    await db.insert(configurationVersions).values({
      id: configurationVersionId,
      workspaceId,
      status: "uploaded",
      ingressAttributes: {
        commitSha: "abc123",
        branch: "main",
        senderUsername: "contract-user",
      },
    });
    await db.insert(runs).values({
      id: includedRunId,
      workspaceId,
      configurationVersionId,
      createdBy: seed.userId,
      status: "planned",
      createdAt: Date.now() - 1_000,
    });
  });

  afterAll(async () => {
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(configurationVersions).where(eq(configurationVersions.id, configurationVersionId));
    await db.delete(apiTokens).where(eq(apiTokens.id, `token-org-${seed.suffix}`));
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
        // the reference format emits ids prefixed with "run-"; Terrence uses bare UUIDs (opaque to clients).
    expect(runId).toBeTypeOf("string");
    expect(runId).not.toBe("");
    expect(resource.attributes["status"]).toBe("pending");
    expect(resource.attributes["message"]).toBe("contract test run");
    expect(resource.attributes["auto-apply"]).toBe(false);
    expect(resource.attributes["is-destroy"]).toBe(false);
    expect(resource.attributes["has-changes"]).toBe(false);
    expect(resource.attributes["source"]).toBe("tfe-api");
    expect(resource.attributes["trigger-reason"]).toBe("manual");
    expect(resource.attributes["plan-only"]).toBe(false);
    expect(resource.attributes["position-in-queue"]).toBe(0);
    expect(resource.attributes["allow-empty-apply"]).toBe(false);
    expect(resource.attributes["allow-config-generation"]).toBe(false);
    expect(resource.attributes["actions"]).toMatchObject({
      "is-cancelable": expect.any(Boolean),
      "is-confirmable": expect.any(Boolean),
      "is-discardable": expect.any(Boolean),
      "is-force-cancelable": expect.any(Boolean),
    });
    expect(resource.attributes["status-timestamps"]).toBeTypeOf("object");
    expect(resource.attributes["created-at"]).toBeTypeOf("string");
    expect(resource.attributes["permissions"]).toMatchObject({
      "can-apply": expect.any(Boolean),
      "can-cancel": expect.any(Boolean),
      "can-discard": expect.any(Boolean),
      "can-comment": expect.any(Boolean),
    });
    expect(resource.relationships?.["workspace"]).toMatchObject({
      data: { id: workspaceId, type: "workspaces" },
    });
    expect(resource.relationships?.["plan"]).toMatchObject({
      data: { id: `plan-${runId}`, type: "plans" },
    });
    expect(resource.relationships?.["apply"]).toMatchObject({
      data: { id: `apply-${runId}`, type: "applies" },
    });
    expect(resource.relationships?.["created-by"]).toMatchObject({
      data: { id: seed.userId, type: "users" },
    });
    expectSelfLink(resource, "/api/v2/runs/");
  });

  it("rejects organization-token run creation with an actionable 403 (issue #606)", async () => {
    const response = await request(`/api/v2/workspaces/${workspaceId}/runs`, {
      method: "POST",
      headers: orgHeaders,
      body: JSON.stringify({ data: { type: "runs", attributes: { message: "org token run" } } }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { errors: { detail?: string }[] };
    expect(body.errors[0]?.detail).toBe("Organization tokens cannot create runs. Use a team token or user token.");
  });

  it("lists exactly the runs the discard action accepts (issue #616)", async () => {
    // includedRunId is planned (discardable); runId is pending (discardable).
    // The filter source of truth is the same exported set the action enforces,
    // so listed discardables never 409 and real discardables are always listed.
    const { DISCARDABLE_RUN_STATUSES } = await import("../../src/lib/utils");
    expect([...DISCARDABLE_RUN_STATUSES].sort()).toEqual(
      ["pending", "planned", "planned_and_saved", "policy_soft_failed", "unreachable"].sort(),
    );
    const filtered = await request(
      `/api/v2/workspaces/${workspaceId}/runs?filter[status_group]=discardable&page[size]=50`,
      { headers },
    );
    expect(filtered.status).toBe(200);
    const listed = (await filtered.json()) as { data: { id: string }[] };
    const ids = listed.data.map((run) => run.id);
    expect(ids).toContain(includedRunId);
    expect(ids).toContain(runId);
    for (const id of ids) {
      const discard = await request(`/api/v2/runs/${id}/actions/discard`, { method: "POST", headers });
      expect(discard.status).not.toBe(409);
      // Restore the discarded state for the remaining tests.
      await db.update(runs).set({ status: "pending" }).where(eq(runs.id, id));
    }
    await db.update(runs).set({ status: "planned" }).where(eq(runs.id, includedRunId));
  });

  it("shows a run", async () => {
    const resource = await expectSuccessResponse(await request(`/api/v2/runs/${runId}`, { headers }), 200, "runs");
    expect(resource.attributes["status"]).toBe("pending");
    expect(resource.attributes["status-timestamps"]).toBeTypeOf("object");
  });

  it("includes every requested run resource on detail reads", async () => {
    const include = encodeURIComponent("plan,apply,workspace,cost_estimate,configuration_version,configuration_version.ingress_attributes");
    const response = await request(`/api/v2/runs/${includedRunId}?include=${include}`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      included?: { id: string; type: string; attributes?: Record<string, unknown> }[];
    };
    expect(body.included).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `plan-${includedRunId}`,
        type: "plans",
        attributes: expect.objectContaining({ status: "finished" }),
      }),
      expect.objectContaining({
        id: `apply-${includedRunId}`,
        type: "applies",
        attributes: expect.objectContaining({ status: "pending" }),
      }),
      expect.objectContaining({
        id: workspaceId,
        type: "workspaces",
        attributes: expect.objectContaining({ name: `runs-${seed.suffix}`, locked: false }),
      }),
      expect.objectContaining({
        id: `ce-${includedRunId}`,
        type: "cost-estimates",
        attributes: expect.objectContaining({ status: "finished", "terrence:infracost-enabled": false }),
      }),
      expect.objectContaining({
        id: configurationVersionId,
        type: "configuration-versions",
        attributes: expect.objectContaining({ status: "uploaded" }),
      }),
      expect.objectContaining({
        id: configurationVersionId,
        type: "ingress-attributes",
        attributes: expect.objectContaining({ "commit-sha": "abc123", branch: "main" }),
      }),
    ]));
    expect(body.included?.some((resource): boolean => resource.type === "users")).toBe(false);
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

  it("returns full run resources from queue and policy override actions", async () => {
    const queued = await expectSuccessResponse(
      await request(`/api/v2/runs/${runId}/actions/queue`, { method: "POST", headers }),
      200,
      "runs",
    );
    expect(queued.attributes["status"]).toBe("pending");
    expect(queued.relationships?.["workspace"]).toMatchObject({
      data: { id: workspaceId, type: "workspaces" },
    });
    expect(queued.relationships?.["plan"]).toMatchObject({
      data: { id: `plan-${runId}`, type: "plans" },
    });
    expect(queued.relationships?.["apply"]).toMatchObject({
      data: { id: `apply-${runId}`, type: "applies" },
    });
    expectSelfLink(queued, "/api/v2/runs/");

    const policyRunId = `run-policy-override-${seed.suffix}`;
    await db.insert(runs).values({
      id: policyRunId,
      workspaceId,
      createdBy: seed.userId,
      status: "policy_soft_failed",
      createdAt: Date.now(),
    });
    try {
      const overridden = await expectSuccessResponse(
        await request(`/api/v2/runs/${policyRunId}/actions/override-policy`, { method: "POST", headers }),
        200,
        "runs",
      );
      expect(overridden.attributes["status"]).toBe("planned");
      expect(overridden.relationships?.["workspace"]).toMatchObject({
        data: { id: workspaceId, type: "workspaces" },
      });
      expect(overridden.relationships?.["plan"]).toMatchObject({
        data: { id: `plan-${policyRunId}`, type: "plans" },
      });
      expect(overridden.relationships?.["apply"]).toMatchObject({
        data: { id: `apply-${policyRunId}`, type: "applies" },
      });
      expectSelfLink(overridden, "/api/v2/runs/");
    } finally {
      await db.delete(runs).where(eq(runs.id, policyRunId));
    }
  });

  it("sideloads requested plan and apply resources on every run collection", async () => {
    const include = encodeURIComponent("plan,apply");
    const paths = [
      `/api/v2/workspaces/${workspaceId}/runs?include=${include}&page[number]=1&page[size]=10`,
      `/api/v2/organizations/${seed.orgName}/runs?include=${include}&page[number]=1&page[size]=10`,
      `/api/v2/organizations/${seed.orgName}/runs/queue?include=${include}&page[number]=1&page[size]=10`,
    ];
    for (const path of paths) {
      const response = await request(path, { headers });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        data: { id: string }[];
        included?: { id: string; type: string }[];
      };
      expect(body.data.length).toBeGreaterThan(0);
      const includedKeys = new Set((body.included ?? []).map((resource): string => `${resource.type}:${resource.id}`));
      for (const run of body.data) {
        expect(includedKeys.has(`plans:plan-${run.id}`)).toBe(true);
        expect(includedKeys.has(`applies:apply-${run.id}`)).toBe(true);
      }
    }
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
    expect(plan.attributes["status"]).toBeTypeOf("string");
    expectSelfLink(plan, "/api/v2/plans/");

    const apply = await expectSuccessResponse(await request(`/api/v2/applies/apply-${runId}`, { headers }), 200, "applies");
    expect(apply.id).toBe(`apply-${runId}`);
    expect(apply.attributes["status"]).toBeTypeOf("string");
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
    expect(discard.status).toBe(202);
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
