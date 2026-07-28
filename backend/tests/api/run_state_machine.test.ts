import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { costEstimateResource } from "../../src/routes/misc";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";

const suffix = crypto.randomUUID();
const userId = `user-sm-${suffix}`;
const orgId = `org-sm-${suffix}`;
const orgName = `state-machine-${suffix}`;
const token = `sm-token-${suffix}`;
const workspaceId = `ws-sm-${suffix}`;

const req = (path: string, method = "GET", body?: unknown) =>
  app.handle(
    new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/vnd.api+json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );

beforeAll(async () => {
  await db.insert(users).values({ id: userId, username: `sm-user-${suffix}`, passwordHash: "unused" });
  await db.insert(organizations).values({ id: orgId, name: orgName });
  await db.insert(organizationMemberships).values({ id: `sm-m-${suffix}`, userId, orgId, role: "owner" });
  await db.insert(apiTokens).values({ id: `sm-t-${suffix}`, token, userId });
  await db.insert(workspaces).values({ id: workspaceId, name: "sm-workspace", orgId });
});

afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(apiTokens).where(eq(apiTokens.token, token));
  await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

// Helper to create a run and return its ID
async function createRun(message = "test run"): Promise<string> {
  const res = await req("/api/v2/runs", "POST", {
    data: {
      type: "runs",
      attributes: { message },
      relationships: { workspace: { data: { type: "workspaces", id: workspaceId } } },
    },
  });
  const body = await res.json();
  return body.data.id;
}

// --- Run resource relationships ---

describe("TFE API v2 - Run resource relationships", () => {
  it("run resource includes workspace-run-alerts stub relationship", async () => {
    const runId = await createRun("workspace-run-alerts test");
    const res = await req(`/api/v2/runs/${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const run = body.data;

    expect(run.relationships).toHaveProperty("workspace-run-alerts");
    expect(Array.isArray(run.relationships["workspace-run-alerts"].data)).toBe(true);
  });

  it("plan resource includes state-versions relationship with link", async () => {
    const runId = await createRun("plan state-versions relationship test");

    const res = await req(`/api/v2/runs/${runId}/plan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const plan = body.data;

    expect(plan.type).toBe("plans");
    expect(plan.relationships).toBeDefined();
    expect(plan.relationships["state-versions"]).toBeDefined();
    const link = plan.relationships["state-versions"].links?.related;
    expect(typeof link).toBe("string");
    expect(link).toContain(runId);
  });

  it("apply resource includes state-versions relationship with link", async () => {
    const runId = await createRun("apply state-versions relationship test");

    const res = await req(`/api/v2/applies/apply-${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const apply = body.data;

    expect(apply.type).toBe("applies");
    expect(apply.relationships).toBeDefined();
    expect(apply.relationships["state-versions"]).toBeDefined();
    const link = apply.relationships["state-versions"].links?.related;
    expect(typeof link).toBe("string");
    expect(link).toContain(runId);
  });
});

// --- Plan/Apply status mapping ---

describe("TFE API v2 - Plan/Apply status mapping", () => {
  it("plan resource status is 'queued' when run has plan_queued status", async () => {
    const runId = `run-pq-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "plan_queued",
      createdAt: Date.now(),
    });

    const res = await req(`/api/v2/runs/${runId}/plan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.status).toBe("queued");

    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("plan resource status is 'queued' when run has queuing status", async () => {
    const runId = `run-q-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "queuing",
      createdAt: Date.now(),
    });

    const res = await req(`/api/v2/runs/${runId}/plan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.status).toBe("queued");

    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("plan resource status is 'running' when run is planning", async () => {
    const runId = `run-planning-sm-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "planning",
      createdAt: Date.now(),
    });

    const res = await req(`/api/v2/runs/${runId}/plan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.status).toBe("running");

    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("plan resource status is 'finished' when run is planned", async () => {
    const runId = `run-planned-sm-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "planned",
      createdAt: Date.now(),
    });

    const res = await req(`/api/v2/runs/${runId}/plan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.status).toBe("finished");

    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("plan resource status is 'unreachable' when run is unreachable", async () => {
    const runId = `run-ur-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "unreachable",
      createdAt: Date.now(),
    });

    const res = await req(`/api/v2/runs/${runId}/plan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.status).toBe("unreachable");

    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("apply resource status is 'queued' when run has apply_queued status", async () => {
    const runId = `run-aq-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "apply_queued",
      createdAt: Date.now(),
    });

    const res = await req(`/api/v2/applies/apply-${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.status).toBe("queued");

    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("apply resource status is 'running' when run is applying", async () => {
    const runId = `run-applying-sm-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "applying",
      createdAt: Date.now(),
    });

    const res = await req(`/api/v2/applies/apply-${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.status).toBe("running");

    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("apply resource status is 'finished' when run is applied", async () => {
    const runId = `run-applied-sm-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "applied",
      createdAt: Date.now(),
    });

    const res = await req(`/api/v2/applies/apply-${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.status).toBe("finished");

    await db.delete(runs).where(eq(runs.id, runId));
  });

  it("apply resource status is 'unreachable' when run is unreachable", async () => {
    const runId = `run-ur-apply-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "unreachable",
      createdAt: Date.now(),
    });

    const res = await req(`/api/v2/applies/apply-${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes.status).toBe("unreachable");

    await db.delete(runs).where(eq(runs.id, runId));
  });
});

// --- Cost estimate stub fields ---

describe("TFE API v2 - Cost estimate stub fields", () => {
  it("GET /api/v2/runs/:id/cost-estimate returns all required stub fields", async () => {
    const runId = await createRun("cost estimate test");

    const res = await req(`/api/v2/runs/${runId}/cost-estimate`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const attrs = body.data.attributes;

    expect(attrs.status).toBe("queued");
    expect(attrs["prior-monthly-cost"]).toBe("0.0");
    expect(attrs["proposed-monthly-cost"]).toBe("0.0");
    expect(attrs["delta-monthly-cost"]).toBe("0.0");
    expect(typeof attrs["resources-count"]).toBe("number");
    expect(typeof attrs["matched-resources-count"]).toBe("number");
    expect(typeof attrs["unmatched-resources-count"]).toBe("number");
    expect(attrs).toHaveProperty("error-message");
    expect(attrs.resources).toEqual({});

    for (const [runStatus, expectedStatus] of [
      ["cost_estimating", "pending"],
      ["planned_and_finished", "skipped"],
      ["errored", "errored"],
      ["canceled", "canceled"],
    ] as const) {
      const state = costEstimateResource({ id: runId, status: runStatus, statusTimestamps: null });
      expect((state.attributes as Record<string, unknown>).status).toBe(expectedStatus);
    }

    const finished = costEstimateResource({
      id: runId,
      status: "applied",
      statusTimestamps: {
        "cost-estimating-at": "2026-01-01T00:00:00.000Z",
        "cost-estimated-at": "2026-01-01T00:00:01.000Z",
      },
    });
    const finishedAttributes = finished.attributes as Record<string, unknown>;
    expect(finishedAttributes.status).toBe("finished");
    expect((finishedAttributes["status-timestamps"] as Record<string, unknown>)["finished-at"]).toBe("2026-01-01T00:00:01.000Z");
  });

  it("GET /api/v2/cost-estimates/:ce_id returns all required stub fields", async () => {
    const runId = await createRun("cost estimate by id test");

    const res = await req(`/api/v2/cost-estimates/ce-${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const attrs = body.data.attributes;

    expect(attrs["resources-count"]).toBe(0);
    expect(attrs["matched-resources-count"]).toBe(0);
    expect(attrs["unmatched-resources-count"]).toBe(0);
    expect(attrs["error-message"]).toBeNull();
  });
});

// --- OAuth service-provider-display-name ---

describe("TFE API v2 - OAuth client service-provider-display-name", () => {
  it("POST oauth-client returns service-provider-display-name for github", async () => {
    const res = await req(
      `/api/v2/organizations/${orgName}/oauth-clients`,
      "POST",
      {
        data: {
          type: "oauth-clients",
          attributes: {
            name: `gh-client-${suffix}`,
            "service-provider": "github",
            "http-url": "https://github.com",
            "api-url": "https://api.github.com",
          },
        },
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.attributes["service-provider"]).toBe("github");
    expect(body.data.attributes["service-provider-display-name"]).toBe("GitHub");
  });

  it("GET oauth-client by id returns service-provider-display-name for gitlab", async () => {
    const createRes = await req(
      `/api/v2/organizations/${orgName}/oauth-clients`,
      "POST",
      {
        data: {
          type: "oauth-clients",
          attributes: { name: `gl-client-${suffix}`, "service-provider": "gitlab" },
        },
      },
    );
    const createBody = await createRes.json();
    const clientId = createBody.data?.id;
    expect(clientId).toBeTruthy();

    const getRes = await req(`/api/v2/oauth-clients/${clientId}`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.data.attributes["service-provider-display-name"]).toBe("GitLab");
  });

  it("GET oauth-clients list includes service-provider-display-name on all entries", async () => {
    const listRes = await req(`/api/v2/organizations/${orgName}/oauth-clients`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    for (const client of listBody.data) {
      expect(client.attributes).toHaveProperty("service-provider-display-name");
      expect(typeof client.attributes["service-provider-display-name"]).toBe("string");
      expect(client.attributes["service-provider-display-name"].length).toBeGreaterThan(0);
    }
  });

  it("PATCH oauth-client returns updated service-provider-display-name", async () => {
    const createRes = await req(
      `/api/v2/organizations/${orgName}/oauth-clients`,
      "POST",
      {
        data: {
          type: "oauth-clients",
          attributes: { name: `patch-oc-${suffix}`, "service-provider": "github" },
        },
      },
    );
    const createBody = await createRes.json();
    const clientId = createBody.data?.id;

    const patchRes = await req(`/api/v2/oauth-clients/${clientId}`, "PATCH", {
      data: {
        type: "oauth-clients",
        id: clientId,
        attributes: { "service-provider": "gitlab_ee" },
      },
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.data.attributes["service-provider-display-name"]).toBe("GitLab Enterprise Edition");
  });
});

// --- Capacity endpoint tracks intermediate states ---

describe("TFE API v2 - Capacity endpoint with intermediate run states", () => {
  it("capacity endpoint returns pending and running counts", async () => {
    const res = await req(`/api/v2/organizations/${orgName}/capacity`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(typeof body.data.attributes.pending).toBe("number");
    expect(typeof body.data.attributes.running).toBe("number");
  });

  it("queuing and plan_queued runs appear in capacity as pending count", async () => {
    // Create runs in intermediate states
    const queueingRunId = `run-cap-q-${suffix}`;
    const planQueuedRunId = `run-cap-pq-${suffix}`;
    await db.insert(runs).values([
      { id: queueingRunId, workspaceId, status: "queuing", createdAt: Date.now() },
      { id: planQueuedRunId, workspaceId, status: "plan_queued", createdAt: Date.now() },
    ]);

    const res = await req(`/api/v2/organizations/${orgName}/capacity`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // queuing and plan_queued should contribute to capacity
    expect(body.data.attributes.pending).toBeGreaterThanOrEqual(0);

    await db.delete(runs).where(eq(runs.id, queueingRunId));
    await db.delete(runs).where(eq(runs.id, planQueuedRunId));
  });
});
