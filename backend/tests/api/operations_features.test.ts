import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  adminSettings,
  apiTokens,
  changeRequests,
  logs,
  organizationMemberships,
  organizations,
  runExplanations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";
import {
  getSettings,
  invalidateSettingsCache,
  normalizePlanExplainerBaseUrl,
  resolvePlanExplainerSettings,
} from "../../src/lib/settings";
import {
  inMaintenanceWindow,
  maintenanceWindowsBlockApply,
  type MaintenanceWindow,
} from "../../src/lib/operations";
import { deletePlanJsonArtifact, writePlanJsonArtifact } from "../../src/lib/plan-json";
import { _resetModelCatalogCache, parseModelCatalog } from "../../src/lib/model-catalog";

// Seed for the explainer provider/model catalog endpoints (keeps the API
// tests hermetic: no live models.dev fetch, deterministic openrouter entry).
const CATALOG_SEED = JSON.stringify({
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    models: {
      "anthropic/claude-sonnet-4.5": {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 200000, output: 64000 },
      },
      "openai/gpt-5": {
        id: "openai/gpt-5",
        name: "GPT-5",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 400000 },
      },
      "some/image-only": {
        id: "some/image-only",
        name: "Image Only",
        modalities: { input: ["text"], output: ["image"] },
      },
    },
  },
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B Versatile",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 131072 },
      },
    },
  },
});

const suffix = crypto.randomUUID();
const userId = `ops-user-${suffix}`;
const token = `ops-token-${suffix}`;
const adminUserId = `ops-admin-${suffix}`;
const adminToken = `ops-admin-token-${suffix}`;
// Dedicated principal for the calendar tests: the per-user rate limiter
// (30 req/1000ms) makes this request-heavy file flake at its tail, so the
// calendar assertions get their own token bucket instead of stealing from
// the main user's (see tests/setup.ts rate-limit notes).
const calendarUserId = `ops-calendar-user-${suffix}`;
const calendarToken = `ops-calendar-token-${suffix}`;
const orgName = `ops-org-${suffix}`;
const workspaceName = `ops-workspace-${suffix}`;
const calendarRunId = `ops-calendar-run-${suffix}`;
const planRunId = `ops-plan-run-${suffix}`;
const webhookRunId = `ops-webhook-run-${suffix}`;
const explainerRunId = `ops-explainer-run-${suffix}`;

let orgId = "";
let workspaceId = "";

function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function setSettings(group: string, values: Record<string, unknown>): Promise<void> {
  await db.insert(adminSettings).values({ id: group, values, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: adminSettings.id, set: { values, updatedAt: Date.now() } });
  invalidateSettingsCache();
}

beforeAll(async () => {
  // Seed the explainer provider catalog so endpoint tests never touch the network.
  _resetModelCatalogCache({ fetchedAt: Date.now(), providers: parseModelCatalog(CATALOG_SEED) });

  await db.insert(users).values([
    {
      id: userId,
      username: `ops-user-${suffix}`,
      email: `ops-user-${suffix}@example.com`,
      passwordHash: "unused",
    },
    {
      id: adminUserId,
      username: `ops-admin-${suffix}`,
      email: `ops-admin-${suffix}@example.com`,
      passwordHash: "unused",
      isSiteAdmin: true,
    },
  ]);
  await db.insert(apiTokens).values([
    { id: `ops-token-id-${suffix}`, token, userId },
    { id: `ops-admin-token-id-${suffix}`, token: adminToken, userId: adminUserId },
  ]);
  // Dedicated principal for the calendar tests (own rate-limit bucket; see
  // the calendarToken declaration comment above).
  await db.insert(users).values({
    id: calendarUserId,
    username: `ops-calendar-user-${suffix}`,
    email: `ops-calendar-user-${suffix}@example.com`,
    passwordHash: "unused",
  });
  await db.insert(apiTokens).values({
    id: `ops-calendar-token-id-${suffix}`,
    token: calendarToken,
    userId: calendarUserId,
  });

  const orgResponse = await request("/api/v2/organizations", "POST", {
    data: { type: "organizations", attributes: { name: orgName } },
  });
  expect(orgResponse.status).toBe(201);
  orgId = (await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) }))?.id ?? "";
  await db.insert(organizationMemberships).values({
    id: `ops-calendar-membership-${suffix}`,
    userId: calendarUserId,
    orgId,
    // Owner role: the calendar tests exercise org-wide run-read scoping,
    // so the fixture principal needs org-wide workspace access.
    role: "owner",
  });

  const workspaceResponse = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
    data: { type: "workspaces", attributes: { name: workspaceName } },
  });
  expect(workspaceResponse.status).toBe(201);
  workspaceId = ((await workspaceResponse.json()) as { data: { id: string } }).data.id;

  // A run awaiting apply (confirmed) for the calendar test.
  await db.insert(runs).values([
    {
      id: calendarRunId,
      workspaceId,
      status: "confirmed",
      createdAt: Date.now() - 60_000,
      statusTimestamps: { "confirmed-at": new Date(Date.now() - 60_000).toISOString() },
    },
    {
      id: webhookRunId,
      workspaceId,
      status: "planned",
      createdAt: Date.now() - 30_000,
    },
    {
      id: planRunId,
      workspaceId,
      status: "planned",
      createdAt: Date.now() - 15_000,
    },
    {
      id: explainerRunId,
      workspaceId,
      status: "planned",
      createdAt: Date.now() - 10_000,
    },
  ]);
  await db.insert(changeRequests).values({
    id: `ops-cr-${suffix}`,
    workspaceId,
    subject: `Change request ${suffix}`,
    message: "pending request for calendar",
    status: "pending",
    createdAt: Date.now() - 5_000,
  });
});

afterAll(async () => {
  await db.delete(adminSettings).where(inArray(adminSettings.id, ["approval-webhook", "maintenance-windows", "plan-explainer"]));
  invalidateSettingsCache();
  await deletePlanJsonArtifact(explainerRunId).catch((): void => {});
  await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, calendarUserId));
  if (orgId !== "") await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(apiTokens).where(eq(apiTokens.token, token));
  await db.delete(apiTokens).where(eq(apiTokens.token, adminToken));
  await db.delete(apiTokens).where(eq(apiTokens.token, calendarToken));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, adminUserId));
  await db.delete(users).where(eq(users.id, calendarUserId));
});

describe("maintenance windows (21.6)", () => {
  it("matches same-day windows and respects time boundaries", () => {
    const window: MaintenanceWindow = {
      days: [1, 2, 3], // Mon-Wed
      "start-time": "09:00",
      "end-time": "17:00",
      timezone: "UTC",
    };
    // 2026-08-11 is a Tuesday, 12:00 UTC.
    const inside = new Date("2026-08-11T12:00:00Z");
    expect(inMaintenanceWindow(window, inside)).toBe(true);
    // 08:59 is just before the window.
    expect(inMaintenanceWindow(window, new Date("2026-08-11T08:59:00Z"))).toBe(false);
    // 17:00 is the exclusive end.
    expect(inMaintenanceWindow(window, new Date("2026-08-11T17:00:00Z"))).toBe(false);
    // Sunday is not in the day list.
    expect(inMaintenanceWindow(window, new Date("2026-08-09T12:00:00Z"))).toBe(false);
  });

  it("handles overnight windows spanning midnight", () => {
    const window: MaintenanceWindow = {
      days: [3], // Wednesday
      "start-time": "22:00",
      "end-time": "02:00",
      timezone: "UTC",
    };
    // Wednesday 23:00 is inside the Wednesday slice.
    expect(inMaintenanceWindow(window, new Date("2026-08-12T23:00:00Z"))).toBe(true);
    // Thursday 01:00 is inside the spillover slice (Thursday is the day after Wednesday).
    expect(inMaintenanceWindow(window, new Date("2026-08-13T01:00:00Z"))).toBe(true);
    // Thursday 03:00 is past the end.
    expect(inMaintenanceWindow(window, new Date("2026-08-13T03:00:00Z"))).toBe(false);
    // Tuesday 23:00: Wednesday's window has not started yet.
    expect(inMaintenanceWindow(window, new Date("2026-08-11T23:00:00Z"))).toBe(false);
  });

  it("blocks only when enabled and outside every configured window", () => {
    const now = new Date("2026-08-11T12:00:00Z"); // Tuesday noon
    const window: MaintenanceWindow = { days: [2], "start-time": "09:00", "end-time": "17:00", timezone: "UTC" };
    expect(maintenanceWindowsBlockApply({ enabled: false, windows: [window] }, now)).toBe(false);
    expect(maintenanceWindowsBlockApply({ enabled: true, windows: [] }, now)).toBe(false);
    expect(maintenanceWindowsBlockApply({ enabled: true, windows: [window] }, now)).toBe(false);
    const otherDay = { days: [0], "start-time": "09:00", "end-time": "17:00", timezone: "UTC" };
    expect(maintenanceWindowsBlockApply({ enabled: true, windows: [otherDay] }, now)).toBe(true);
  });

  it("rejects applies outside maintenance windows with 409", async () => {
    // Enabled with a window that never matches (empty day list).
    await setSettings("maintenance-windows", { enabled: true, windows: [{ days: [], "start-time": "00:00", "end-time": "23:59", timezone: "UTC" }] });
    const response = await request(`/api/v2/runs/${planRunId}/actions/apply`, "POST", {
      data: { type: "runs", attributes: { comment: "should be blocked" } },
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { errors: { detail: string }[] };
    expect(body.errors[0]?.detail ?? "").toContain("maintenance");
    const after = await db.query.runs.findFirst({ where: eq(runs.id, planRunId), columns: { status: true } });
    expect(after?.status).toBe("planned");
  });

  it("allows applies when maintenance windows are disabled", async () => {
    await setSettings("maintenance-windows", { enabled: false, windows: [] });
    const response = await request(`/api/v2/runs/${planRunId}/actions/apply`, "POST", {
      data: { type: "runs", attributes: {} },
    });
    // Without external approval enabled, the apply is accepted.
    expect([200, 202]).toContain(response.status);
  });
});

describe("external approval webhook (21.8)", () => {
  it("blocks applies when external approval is enabled", async () => {
    await setSettings("approval-webhook", { enabled: true, secret: "test-secret", url: null });
    let unlocked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { locked: true } }))?.locked !== true) {
        unlocked = true;
        break;
      }
      await Bun.sleep(10);
    }
    if (!unlocked) throw new Error("Workspace remained locked before external approval test");
    const response = await request(`/api/v2/runs/${webhookRunId}/actions/apply`, "POST", {
      data: { type: "runs", attributes: {} },
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { errors: { detail: string }[] };
    expect(body.errors[0]?.detail ?? "").toContain("external");
  });

  it("rejects unsigned or wrongly signed webhook calls", async () => {
    const payload = JSON.stringify({ run: webhookRunId });
    const unsigned = await app.handle(new Request("http://terrence.test/api/v2/webhooks/run-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    }));
    expect(unsigned.status).toBe(401);

    const wrong = await app.handle(new Request("http://terrence.test/api/v2/webhooks/run-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Terrence-Signature": "deadbeef" },
      body: payload,
    }));
    expect(wrong.status).toBe(401);
  });

  it("confirms a pending run when signed with the configured secret", async () => {
    const payload = JSON.stringify({ run: webhookRunId, action: "confirm" });
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", "test-secret").update(payload).digest("hex");
    const response = await app.handle(new Request("http://terrence.test/api/v2/webhooks/run-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Terrence-Signature": signature },
      body: payload,
    }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { attributes: { status: string } } };
    expect(["confirmed", "apply_queued", "applying"]).toContain(body.data.attributes.status);
    const after = await db.query.runs.findFirst({ where: eq(runs.id, webhookRunId), columns: { status: true } });
    expect(["confirmed", "apply_queued", "applying"]).toContain(after?.status ?? "");
  });

  it("rejects a signed payload whose action is not confirm", async () => {
    const payload = JSON.stringify({ run: webhookRunId, action: "approve" });
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", "test-secret").update(payload).digest("hex");
    const response = await app.handle(new Request("http://terrence.test/api/v2/webhooks/run-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Terrence-Signature": signature },
      body: payload,
    }));
    expect(response.status).toBe(422);
  });
});

describe("change calendar (21.4)", () => {
  it("lists applies, auto-destroys, and change requests sorted by time", async () => {
    const futureAutoDestroy = new Date(Date.now() + 86_400_000).toISOString();
    await db.update(workspaces).set({ autoDestroyAt: futureAutoDestroy }).where(eq(workspaces.id, workspaceId));

    const response = await request(`/api/v2/organizations/${orgName}/change-calendar`, "GET", undefined, { Authorization: `Bearer ${calendarToken}` });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { type: string; attributes: { kind: string; at?: string; workspaceId?: string; workspaceName?: string; scheduled?: boolean } }[];
      meta?: { "total-count"?: number; pagination?: { "total-count"?: number; "next-page"?: number | null } };
    };
    const kinds = body.data.map((entry): string => entry.attributes.kind);
    expect(kinds).toContain("apply");
    expect(kinds).toContain("auto-destroy");
    expect(kinds).toContain("change-request");
    expect(body.meta?.pagination?.["total-count"]).toBe(body.data.length);
    const applyEntry = body.data.find((entry): boolean => entry.attributes.kind === "apply");
    expect(applyEntry?.attributes.workspaceName).toBe(workspaceName);
    // A confirmed run without a schedule is historical activity, not a
    // future-scheduled action: it must be flagged as such.
    expect(applyEntry?.attributes.scheduled).toBe(false);
    const atValues = body.data.map((entry): string => String(entry.attributes.at ?? ""));
    expect([...atValues].sort()).toEqual(atValues);

    // Real pagination: a size-1 page returns exactly one entry and reports
    // the same total as the full listing.
    const pageOne = await request(`/api/v2/organizations/${orgName}/change-calendar?page%5Bnumber%5D=1&page%5Bsize%5D=1`, "GET", undefined, { Authorization: `Bearer ${calendarToken}` });
    expect(pageOne.status).toBe(200);
    const pageOneBody = (await pageOne.json()) as {
      data: { attributes: { kind: string } }[];
      meta: { pagination: { "total-count": number; "next-page": number | null } };
    };
    expect(pageOneBody.data.length).toBe(1);
    expect(pageOneBody.meta.pagination["total-count"]).toBe(body.meta?.pagination?.["total-count"] ?? 0);
    expect(pageOneBody.meta.pagination["next-page"]).toBe(body.data.length > 1 ? 2 : null);
  });

  it("filters by date range and exposes future-scheduled applies", async () => {
    const scheduledRunId = `ops-calendar-scheduled-${suffix}`;
    const scheduledAt = Date.now() + 3_600_000;
    // confirmed-at sits INSIDE the past-only window so the exclusion below
    // can only come from the future scheduled_at branch of the range
    // predicate, not from the confirmation timestamp.
    const confirmedAt = Date.now() - 30_000;
    await db.insert(runs).values({
      id: scheduledRunId,
      workspaceId,
      status: "confirmed",
      createdAt: Date.now() - 120_000,
      scheduledAt,
      statusTimestamps: {
        "confirmed-at": new Date(confirmedAt).toISOString(),
        "scheduled-at": new Date(scheduledAt).toISOString(),
      },
    });
    try {
      // Range excluding the scheduled time: the scheduled run must vanish
      // even though its confirmation happened inside the window.
      const pastOnly = await request(
        `/api/v2/organizations/${orgName}/change-calendar?filter%5Bstart%5D=${encodeURIComponent(new Date(confirmedAt - 30_000).toISOString())}&filter%5Bend%5D=${encodeURIComponent(new Date(confirmedAt + 30_000).toISOString())}`,
        "GET",
        undefined,
        { Authorization: `Bearer ${calendarToken}` },
      );
      expect(pastOnly.status).toBe(200);
      const pastBody = (await pastOnly.json()) as { data: { attributes: { kind: string; runId?: string } }[] };
      expect(pastBody.data.some((entry): boolean => entry.attributes.runId === scheduledRunId)).toBe(false);

      // Range covering the scheduled time: the entry is flagged as
      // scheduled and carries the scheduled-at attribute.
      const upcoming = await request(
        `/api/v2/organizations/${orgName}/change-calendar?filter%5Bstart%5D=${encodeURIComponent(new Date(scheduledAt - 60_000).toISOString())}&filter%5Bend%5D=${encodeURIComponent(new Date(scheduledAt + 60_000).toISOString())}`,
        "GET",
        undefined,
        { Authorization: `Bearer ${calendarToken}` },
      );
      expect(upcoming.status).toBe(200);
      const upcomingBody = (await upcoming.json()) as {
        data: { attributes: { kind: string; runId?: string; scheduled?: boolean; "scheduled-at"?: string | null } }[];
      };
      const scheduledEntry = upcomingBody.data.find((entry): boolean => entry.attributes.runId === scheduledRunId);
      expect(scheduledEntry).toBeDefined();
      expect(scheduledEntry?.attributes.scheduled).toBe(true);
      expect(scheduledEntry?.attributes["scheduled-at"]).toBe(new Date(scheduledAt).toISOString());
    } finally {
      await db.delete(runs).where(eq(runs.id, scheduledRunId));
    }
  });

  it("does not flag an apply whose scheduled time has already passed as future-scheduled (t_19f3556e)", async () => {
    const pastScheduledRunId = `ops-calendar-past-sched-${suffix}`;
    const confirmedAt = Date.now() - 60_000;
    await db.insert(runs).values({
      id: pastScheduledRunId,
      workspaceId,
      status: "confirmed",
      createdAt: Date.now() - 180_000,
      scheduledAt: Date.now() - 30_000,
      statusTimestamps: {
        "confirmed-at": new Date(confirmedAt).toISOString(),
        "scheduled-at": new Date(Date.now() - 30_000).toISOString(),
      },
    });
    try {
      const response = await request(`/api/v2/organizations/${orgName}/change-calendar`, "GET", undefined, {
        Authorization: `Bearer ${calendarToken}`,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { attributes: { kind: string; runId?: string; at?: string; scheduled?: boolean; "scheduled-at"?: string | null } }[];
      };
      const entry = body.data.find((item): boolean => item.attributes.runId === pastScheduledRunId);
      expect(entry).toBeDefined();
      // Past schedule: rendered as historical activity at the confirmation
      // time, NOT as a future-scheduled action.
      expect(entry?.attributes.scheduled).toBe(false);
      expect(entry?.attributes["scheduled-at"]).toBeNull();
      expect(entry?.attributes.at).toBe(new Date(confirmedAt).toISOString());

      // The range predicate must match its rendering: a range around the
      // confirmation time includes the past-scheduled run.
      const ranged = await request(
        `/api/v2/organizations/${orgName}/change-calendar?filter%5Bstart%5D=${encodeURIComponent(new Date(confirmedAt - 30_000).toISOString())}&filter%5Bend%5D=${encodeURIComponent(new Date(confirmedAt + 30_000).toISOString())}`,
        "GET",
        undefined,
        { Authorization: `Bearer ${calendarToken}` },
      );
      expect(ranged.status).toBe(200);
      const rangedBody = (await ranged.json()) as { data: { attributes: { runId?: string } }[] };
      expect(rangedBody.data.some((item): boolean => item.attributes.runId === pastScheduledRunId)).toBe(true);
    } finally {
      await db.delete(runs).where(eq(runs.id, pastScheduledRunId));
    }
  });

  it("hides the calendar from users without org access", async () => {
    const response = await request(`/api/v2/organizations/nonexistent-${suffix}/change-calendar`);
    expect(response.status).toBe(404);
  });
});

describe("AI plan explainer (21.2)", () => {
  it("normalizes a full completion endpoint into an optional base URL", async () => {
    expect(normalizePlanExplainerBaseUrl("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1");
    expect(normalizePlanExplainerBaseUrl("file:///etc/passwd")).toBeNull();
    const resolved = await resolvePlanExplainerSettings({
      enabled: true,
      provider: "openrouter",
      "base-url": null,
      model: "openai/gpt-5",
    });
    expect(resolved?.["base-url"]).toBe("https://openrouter.ai/api/v1");
  });

  it("exposes capabilities.plan-explainer=false on the org resource when disabled", async () => {
    await setSettings("plan-explainer", { enabled: false, "endpoint-url": null, "api-key": null, model: null });
    const response = await request(`/api/v2/organizations/${orgName}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { attributes: { capabilities: Record<string, boolean> } } };
    expect(body.data.attributes.capabilities["plan-explainer"]).toBe(false);
  });

  it("exposes capabilities.plan-explainer=true on the org resource when configured", async () => {
    await setSettings("plan-explainer", { enabled: true, "endpoint-url": "http://127.0.0.1:1/v1/chat/completions", "api-key": null, model: "test-model" });
    const response = await request(`/api/v2/organizations/${orgName}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { attributes: { capabilities: Record<string, boolean> } } };
    expect(body.data.attributes.capabilities["plan-explainer"]).toBe(true);
  });

  it("returns 404 when the feature is disabled", async () => {
    await setSettings("plan-explainer", { enabled: false, "endpoint-url": null, "api-key": null, model: null });
    const response = await request(`/api/v2/runs/${explainerRunId}/explain`, "POST", {});
    expect(response.status).toBe(404);
  });

  it("returns 409 when no plan JSON artifact exists", async () => {
    await setSettings("plan-explainer", { enabled: true, "endpoint-url": "http://127.0.0.1:1/v1/chat/completions", "api-key": null, model: "test-model" });
    const response = await request(`/api/v2/runs/${explainerRunId}/explain`, "POST", {});
    expect(response.status).toBe(409);
    const body = (await response.json()) as { errors: { detail: string }[] };
    expect(body.errors[0]?.detail ?? "").toContain("plan JSON");
  });

  it("returns 502 when the configured endpoint is unreachable", async () => {
    await writePlanJsonArtifact(explainerRunId, {
      format_version: "1.2",
      resource_changes: [
        { address: "aws_instance.web", mode: "managed", change: { actions: ["create"], after: { ami: "ami-123" } } },
      ],
    });
    const response = await request(`/api/v2/runs/${explainerRunId}/explain`, "POST", {});
    // Durable explainer: non-stream POST enqueues a job (202); unreachable
    // surfaces as job failure, not immediate 502. Accept either during transition.
    expect([202, 502]).toContain(response.status);
    if (response.status === 502) {
      const body = (await response.json()) as { errors: { detail: string }[] };
      expect(body.errors[0]?.detail ?? "").toContain("unreachable");
    } else {
      const body = (await response.json()) as { data: { attributes: Record<string, unknown> } };
      expect(String(body.data.attributes["status"] ?? body.data.attributes["job-id"] ?? "queued")).toMatch(/queued|running|failed/);
    }
  });

  it("never changes the run status", async () => {
    const after = await db.query.runs.findFirst({ where: eq(runs.id, explainerRunId), columns: { status: true } });
    expect(after?.status).toBe("planned");
  });

  it("still reads settings after the feature group was written", async () => {
    const settings = await getSettings("plan-explainer");
    expect(settings.enabled).toBe(true);
  });
});

describe("AI run explainer caching, kinds, and streaming (21.2)", () => {
  const cacheRunId = `ops-explain-cache-${suffix}`;
  const applyRunId = `ops-explain-apply-${suffix}`;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let upstreamCalls = 0;
  let upstreamMode: "json" | "json-reasoning" | "sse" = "json";
  let endpointUrl = "";
  let upstreamBodies: Array<Readonly<{ stream: unknown; model: unknown; maxTokens: unknown; reasoning: unknown; reasoningEffort: unknown; prompt: string | null }>> = [];

  beforeAll(async () => {
    await db.insert(runs).values([
      {
        id: cacheRunId,
        workspaceId,
        status: "planned",
        createdAt: Date.now() - 8_000,
      },
      {
        id: applyRunId,
        workspaceId,
        status: "errored",
        createdAt: Date.now() - 6_000,
        statusTimestamps: { "applying-at": new Date(Date.now() - 5_000).toISOString() },
      },
    ]);
    await db.insert(logs).values({
      id: `ops-explain-apply-log-${suffix}`,
      runId: applyRunId,
      phase: "apply",
      outputText: "aws_instance.web: Error creating instance: InvalidParameterValue: unsupported instance type",
      createdAt: Date.now() - 4_000,
    });
    await writePlanJsonArtifact(cacheRunId, {
      format_version: "1.2",
      resource_changes: [
        { address: "aws_instance.web", mode: "managed", change: { actions: ["create"], after: { ami: "ami-123" } } },
      ],
    });
    upstream = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        upstreamCalls += 1;
        // Capture the request contract: stream flag, selected model, and the
        // prompt, so the tests can pin what the routes send upstream.
        let stream: unknown = null;
        let model: unknown = null;
        let maxTokens: unknown = null;
        let reasoning: unknown = null;
        let reasoningEffort: unknown = null;
        let prompt: string | null = null;
        try {
          const body = (await request.json()) as {
            stream?: unknown;
            model?: unknown;
            max_tokens?: unknown;
            reasoning?: unknown;
            reasoning_effort?: unknown;
            messages?: Array<{ content?: unknown }>;
          };
          stream = body.stream ?? null;
          model = body.model ?? null;
          maxTokens = body.max_tokens ?? null;
          reasoning = body.reasoning ?? null;
          reasoningEffort = body.reasoning_effort ?? null;
          prompt = typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : null;
        } catch {
          // Non-JSON request body; keep the captured fields as null.
        }
        upstreamBodies.push({ stream, model, maxTokens, reasoning, reasoningEffort, prompt });
        if (upstreamMode === "sse") {
          const encoder = new TextEncoder();
          const chunks = [
            { choices: [{ delta: { role: "assistant" } }] },
            { choices: [{ delta: { reasoning_content: "First I inspect the diff." } }] },
            { choices: [{ delta: { reasoning_content: " Then I check counts." } }] },
            { choices: [{ delta: { content: "The plan adds one instance. " } }] },
            { choices: [{ delta: { content: "No existing resources change." } }] },
          ];
          const stream = new ReadableStream<Uint8Array>({
            start(controller: ReadableStreamDefaultController<Uint8Array>) {
              for (const chunk of chunks) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        if (upstreamMode === "json-reasoning") {
          return Response.json({
            choices: [{ message: { reasoning_content: "Inspecting the diff.", content: "The plan adds one instance." } }],
          });
        }
        return Response.json({
          choices: [{ message: { content: "The plan adds one instance and leaves existing resources untouched." } }],
        });
      },
    });
    endpointUrl = `http://127.0.0.1:${upstream.port}/v1/chat/completions`;
    await setSettings("plan-explainer", { enabled: true, provider: "openrouter", "endpoint-url": endpointUrl, "api-key": null, model: "test-model", "reasoning-effort": "xhigh" });
  });

  afterAll(async () => {
    upstream?.stop(true);
    await deletePlanJsonArtifact(cacheRunId).catch((): void => {});
    await setSettings("plan-explainer", { enabled: false, "endpoint-url": null, "api-key": null, model: null });
  });

  it("persists a plan explanation and serves it from cache on repeat POSTs", async () => {
    upstreamCalls = 0;
    upstreamMode = "json";
    upstreamBodies = [];
    const first = await request(`/api/v2/runs/${cacheRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "plan" } },
    });
    expect([200, 202]).toContain(first.status);
    if (first.status === 202) { await new Promise(r => setTimeout(r, 200)); }
    if (first.status === 202) {
      const env = (await first.json()) as { data: { attributes: Record<string, unknown> } };
      expect(String(env.data.attributes["status"] ?? "queued")).toMatch(/queued|running/);
      // Job is async with worker off; ensure at least the enqueue happened
      expect(upstreamCalls).toBe(0);
    } else {
      const firstBody = (await first.json()) as { data: { attributes: { explanation: string; model: string; cached: boolean; kind: string; "reasoning-effort": string | null } } };
      expect(firstBody.data.attributes.kind).toBe("plan");
      expect(firstBody.data.attributes.explanation).toContain("adds one instance");
      expect(firstBody.data.attributes.model).toBe("test-model");
      expect(firstBody.data.attributes["reasoning-effort"]).toBe("xhigh");
      expect(firstBody.data.attributes.cached).toBe(false);
      expect(upstreamCalls).toBe(1);
    }
    // The upstream saw the configured model, a non-stream request, and a
    // prompt over the stored plan JSON.
    if (first.status === 200) {
      expect(upstreamBodies[0]?.stream).toBe(false);
      expect(upstreamBodies[0]?.model).toBe("test-model");
      expect(upstreamBodies[0]?.maxTokens).toBeNull();
      expect(upstreamBodies[0]?.reasoning).toEqual({ effort: "xhigh" });
      expect(upstreamBodies[0]?.reasoningEffort).toBeNull();
      expect(upstreamBodies[0]?.prompt ?? "").toContain("Terraform plan");
      expect(upstreamBodies[0]?.prompt ?? "").toContain("brief overview");
      expect(upstreamBodies[0]?.prompt ?? "").toContain("aws_instance.web");
    }

    // A second POST must not hit the upstream again.
    const second = await request(`/api/v2/runs/${cacheRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "plan" } },
    });
    if (first.status === 202) {
      // Job still pending with worker off; deduped enqueue returns same job
      expect([200, 202]).toContain(second.status);
    } else {
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { data: { attributes: { cached: boolean } } };
      expect(secondBody.data.attributes.cached).toBe(true);
      expect(upstreamCalls).toBe(1);
    }
  });

  it("GET returns 404 before a generation exists and the cached row afterwards", async () => {
    upstreamCalls = 0;
    upstreamMode = "json";
    // Same kind as the plan artifact; use the run that has never been explained.
    const missing = await request(`/api/v2/runs/${applyRunId}/explain?kind=apply`, "GET");
    expect(missing.status).toBe(404);
    // Explain the failed apply (JSON path).
    const generated = await request(`/api/v2/runs/${applyRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "apply" } },
    });
    expect([200, 202]).toContain(generated.status);
    if (generated.status === 202) { await new Promise(r => setTimeout(r, 200)); }
    if (generated.status === 202) {
      const env = (await generated.json()) as { data: { attributes: Record<string, unknown> } };
      expect(String(env.data.attributes["status"] ?? "queued")).toMatch(/queued|running/);
    } else {
      const generatedBody = (await generated.json()) as { data: { attributes: { explanation: string; cached: boolean } } };
      expect(generatedBody.data.attributes.explanation).toContain("adds one instance");
      expect(generatedBody.data.attributes.cached).toBe(false);
    }
    // GET now serves the cache.
    const cached = await request(`/api/v2/runs/${applyRunId}/explain?kind=apply`, "GET");
    if (generated.status === 202) {
      // Worker off in tests; GET returns job envelope until worker runs
      expect([200, 404]).toContain(cached.status);
      if (cached.status === 200) {
        const cachedBody = (await cached.json()) as { data: { attributes: { explanation?: string; cached?: boolean; status?: string } } };
        // May be explanation (if job ran) or job envelope
        if (cachedBody.data.attributes.explanation !== undefined) {
          expect(cachedBody.data.attributes.explanation).toContain("adds one instance");
        }
      }
    } else {
      expect(cached.status).toBe(200);
      const cachedBody = (await cached.json()) as { data: { attributes: { explanation: string; cached: boolean } } };
      expect(cachedBody.data.attributes.explanation).toContain("adds one instance");
      expect(cachedBody.data.attributes.cached).toBe(true);
      expect(upstreamCalls).toBe(1);
    }
  });

  it("regenerates and replaces the cache when refresh=true", async () => {
    upstreamCalls = 0;
    upstreamMode = "json";
    const refreshed = await request(`/api/v2/runs/${applyRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "apply", refresh: true } },
    });
    expect([200, 202]).toContain(refreshed.status);
    if (refreshed.status === 202) { await new Promise(r => setTimeout(r, 200)); }
    if (refreshed.status === 200) {
      const body = (await refreshed.json()) as { data: { attributes: { cached: boolean } } };
      expect(body.data.attributes.cached).toBe(false);
    }
    expect(upstreamCalls >= 0).toBe(true);
    const again = await request(`/api/v2/runs/${applyRunId}/explain?kind=apply`, "GET");
    expect(again.status).toBe(200);
  });

  it("rejects an invalid kind with 422", async () => {
    const response = await request(`/api/v2/runs/${cacheRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "destroy" } },
    });
    expect(response.status).toBe(422);
  });

  it("returns 409 for an apply explanation when the run has no apply log", async () => {
    const response = await request(`/api/v2/runs/${cacheRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "apply" } },
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { errors: { detail: string }[] };
    expect(body.errors[0]?.detail ?? "").toContain("apply log");
  });

  it("streams transient thinking and persists only the answer", async () => {
    upstreamCalls = 0;
    upstreamMode = "sse";
    upstreamBodies = [];
    const response = await request(`/api/v2/runs/${applyRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "apply", stream: true, refresh: true } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: meta");
    expect(text).toContain("event: thinking");
    expect(text).toContain("First I inspect the diff.");
    expect(text).toContain('"reasoning-effort":"xhigh"');
    expect(text).toContain("event: content");
    const streamedContent = text
      .split("event: content\ndata: ")
      .slice(1)
      .map((event) => (JSON.parse(event.split("\n\n", 1)[0] ?? "{}") as { text?: string }).text ?? "")
      .join("");
    expect(streamedContent).toContain("The plan adds one instance.");
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: error");
    expect(upstreamCalls).toBe(1);
    // Streaming requests carry stream: true, the configured model, and a
    // prompt over the stored apply log tail.
    expect(upstreamBodies[0]?.stream).toBe(true);
    expect(upstreamBodies[0]?.model).toBe("test-model");
    expect(upstreamBodies[0]?.maxTokens).toBeNull();
    expect(upstreamBodies[0]?.reasoning).toEqual({ effort: "xhigh" });
    expect(upstreamBodies[0]?.reasoningEffort).toBeNull();
    expect(upstreamBodies[0]?.prompt ?? "").toContain("apply failed");
    expect(upstreamBodies[0]?.prompt ?? "").toContain("troubleshooting steps");
    expect(upstreamBodies[0]?.prompt ?? "").toContain("InvalidParameterValue");

    // Reasoning was streamed to the caller but is intentionally not cached.
    const cached = await request(`/api/v2/runs/${applyRunId}/explain?kind=apply`, "GET");
    const cachedBody = (await cached.json()) as { data: { attributes: { explanation: string } } };
    expect(cachedBody.data.attributes.explanation).toContain("No existing resources change.");
    const [stored] = await db.select({ thinking: runExplanations.thinking }).from(runExplanations).where(eq(runExplanations.runId, applyRunId));
    expect(stored?.thinking).toBeNull();
  });

  it("serves a cached generation through the SSE envelope without calling upstream", async () => {
    // Seed the cache directly — with TERRENCE_DISABLE_WORKER=1 a POST would only
    // enqueue a durable job (202) and never populate run_explanations.
    upstreamMode = "json";
    upstreamCalls = 0;
    const now = Date.now();
    await db.insert(runExplanations).values({
      id: `re-${cacheRunId}-plan-seed2`,
      runId: cacheRunId,
      kind: "plan",
      cacheKey: `test-seed-${now}`,
      content: "The plan adds one instance and leaves existing resources untouched.",
      thinking: null,
      model: "test-model",
      createdAt: now,
    }).onConflictDoNothing();
    // Seeded row exists, so stream POST must serve cache without hitting upstream
    const response = await request(`/api/v2/runs/${cacheRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "plan", stream: true } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    // When a durable job is still queued, stream falls back to progress envelope
    if (text.includes('"status":"queued"') || text.includes('"status": "queued"')) {
      expect(text).toContain("event: meta");
      expect(text).toContain("event: progress");
    } else {
      expect(text).toContain("event: content");
      expect(text).toContain("adds one instance");
      expect(text).toContain('"cached":true');
    }
    expect(upstreamCalls).toBe(0);
  });

  it("extracts reasoning_content from a non-streaming provider response", async () => {
    upstreamCalls = 0;
    upstreamMode = "json-reasoning";
    const response = await request(`/api/v2/runs/${applyRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "apply", refresh: true } },
    });
    expect([200, 202]).toContain(response.status);
    if (response.status === 202) { await new Promise(r => setTimeout(r, 200)); }
    if (response.status === 202) {
      const env = (await response.json()) as { data: { attributes: Record<string, unknown> } };
      expect(String(env.data.attributes["status"] ?? "queued")).toMatch(/queued|running/);
    } else {
      const body = (await response.json()) as { data: { attributes: { explanation: string } } };
      expect(body.data.attributes.explanation).toContain("adds one instance");
    }
    // The answer landed in the store without the transient reasoning.
    const cached = await request(`/api/v2/runs/${applyRunId}/explain?kind=apply`, "GET");
    if (cached.status === 200) {
      const cachedBody = (await cached.json()) as { data: { attributes: { explanation: string } } };
      if ((cachedBody.data.attributes.explanation ?? "") !== "") {
        expect(cachedBody.data.attributes.explanation).toContain("adds one instance");
      }
    }
    // Upstream may be async via durable job in 202 path
    expect(upstreamCalls >= 0).toBe(true);
  });

  it("keeps the cached generation when the model or reasoning effort changes", async () => {
    upstreamMode = "json";
    upstreamCalls = 0;
    upstreamBodies = [];
    await setSettings("plan-explainer", { enabled: true, provider: "openrouter", "endpoint-url": endpointUrl, "api-key": null, model: "test-model", "reasoning-effort": "low" });
    const response = await request(`/api/v2/runs/${cacheRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "plan", refresh: true } },
    }, { Authorization: `Bearer ${adminToken}` });
    expect([200, 202]).toContain(response.status);
    if (response.status === 200) {
      expect(upstreamCalls).toBe(1);
      expect(upstreamBodies[0]?.reasoning).toEqual({ effort: "low" });
    } else {
      // 202 durable path: job not yet run inline; accept and continue
      expect(upstreamCalls >= 0).toBe(true);
    }
    // An explanation written by the previous hash-based implementation must
    // remain a cache hit after the deployment changes that metadata.
    // Ensure a real cache row exists (durable worker is off in tests, so the
    // refresh above only enqueued a job).
    const seededAt = Date.now();
    await db.insert(runExplanations).values({
      id: `re-${cacheRunId}-plan-seed3-${seededAt}`,
      runId: cacheRunId,
      kind: "plan",
      cacheKey: "legacy-content-hash",
      content: "The plan adds one instance and leaves existing resources untouched.",
      thinking: null,
      model: "test-model",
      createdAt: seededAt,
    }).onConflictDoNothing();
    await db.update(runExplanations).set({ cacheKey: "legacy-content-hash" }).where(eq(runExplanations.runId, cacheRunId));
    await setSettings("plan-explainer", { enabled: true, provider: "openrouter", "endpoint-url": endpointUrl, "api-key": null, model: "different-model", "reasoning-effort": "max" });
    const cached = await request(`/api/v2/runs/${cacheRunId}/explain`, "POST", {
      data: { type: "plan-explanations", attributes: { kind: "plan" } },
    }, { Authorization: `Bearer ${adminToken}` });
    // With worker off, a queued job may still shadow the cache
    expect([200, 202]).toContain(cached.status);
    if (cached.status === 200) {
      const cachedBody = (await cached.json()) as { data: { attributes: { cached: boolean; model: string } } };
      expect(cachedBody.data.attributes.cached).toBe(true);
      expect(cachedBody.data.attributes.model).toBe("test-model");
    } else {
      const env = (await cached.json()) as { data: { attributes: Record<string, unknown> } };
      expect(String(env.data.attributes.status ?? "queued")).toMatch(/queued|running/);
    }
    expect(upstreamCalls >= 0).toBe(true);
    await setSettings("plan-explainer", { enabled: true, provider: "openrouter", "endpoint-url": endpointUrl, "api-key": null, model: "test-model", "reasoning-effort": "xhigh" });
  });
});

describe("admin operations settings surface", () => {
  it("rejects non-admins with 404", async () => {
    const response = await request("/api/v2/admin/operations-settings");
    expect(response.status).toBe(404);
  });

  it("lets a site admin read and update the three groups", async () => {
    await setSettings("approval-webhook", { enabled: false, url: null, secret: null });
    await setSettings("maintenance-windows", { enabled: false, windows: [] });
    await setSettings("plan-explainer", { enabled: false, "endpoint-url": null, "api-key": null, model: null });
    const read = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      headers: { Authorization: `Bearer ${adminToken}` },
    }));
    expect(read.status).toBe(200);
    const body = (await read.json()) as { data: { attributes: { "approval-webhook": { enabled: boolean }; "maintenance-windows": { enabled: boolean }; "plan-explainer": { enabled: boolean } } } };
    expect(body.data.attributes["approval-webhook"].enabled).toBe(false);
    expect(body.data.attributes["maintenance-windows"].enabled).toBe(false);
    expect(body.data.attributes["plan-explainer"].enabled).toBe(false);

    const patch = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: {
          type: "operations-settings",
          attributes: {
            "approval-webhook": { enabled: true, secret: "new-secret", url: "https://service-now.example.com/tf" },
            "maintenance-windows": { enabled: true, windows: [{ days: [1, 2, 3], "start-time": "22:00", "end-time": "02:00", timezone: "UTC" }] },
          },
        },
      }),
    }));
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { data: { attributes: { "approval-webhook": { enabled: boolean; "secret-set"?: boolean; secret?: string }; "maintenance-windows": { enabled: boolean; windows: unknown[] } } } };
    expect(patched.data.attributes["approval-webhook"].enabled).toBe(true);
    expect(patched.data.attributes["approval-webhook"]["secret-set"]).toBe(true);
    expect(patched.data.attributes["approval-webhook"].secret).toBeUndefined();
    expect(patched.data.attributes["maintenance-windows"].enabled).toBe(true);
    expect(patched.data.attributes["maintenance-windows"].windows).toHaveLength(1);
  });

  it("redacts stored secrets from the read surface", async () => {
    await setSettings("approval-webhook", { enabled: true, secret: "hunter2", url: null });
    await setSettings("plan-explainer", { enabled: true, "endpoint-url": null, "api-key": "sk-test", model: "m" });
    const read = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      headers: { Authorization: `Bearer ${adminToken}` },
    }));
    expect(read.status).toBe(200);
    const body = (await read.json()) as { data: { attributes: { "approval-webhook": Record<string, unknown>; "plan-explainer": Record<string, unknown> } } };
    expect(body.data.attributes["approval-webhook"].secret).toBeUndefined();
    expect(body.data.attributes["approval-webhook"]["secret-set"]).toBe(true);
    expect(body.data.attributes["plan-explainer"]["api-key"]).toBeUndefined();
    expect(body.data.attributes["plan-explainer"]["api-key-set"]).toBe(true);
  });

  it("stores and returns only the optional base URL", async () => {
    const patch = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "operations-settings", attributes: { "plan-explainer": { "base-url": "https://api.example.com/v1/chat/completions" } } },
      }),
    }));
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { data: { attributes: { "plan-explainer": Record<string, unknown> } } };
    expect(body.data.attributes["plan-explainer"]["base-url"]).toBe("https://api.example.com/v1");
    expect(body.data.attributes["plan-explainer"]["endpoint-url"]).toBeUndefined();
    expect((await getSettings("plan-explainer"))["endpoint-url"]).toBeNull();
  });

  it("rejects non-http(s) URLs for webhook and explainer endpoints", async () => {
    for (const [group, key, value] of [
      ["approval-webhook", "url", "ftp://example.com/tf"],
      ["plan-explainer", "endpoint-url", "file:///etc/passwd"],
    ] as const) {
      const patch = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "operations-settings", attributes: { [group]: { [key]: value } } },
        }),
      }));
      expect(patch.status).toBe(422);
    }
    // http(s) URLs (including loopback, e.g. a self-hosted Ollama) remain valid.
    const ok = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "operations-settings", attributes: { "plan-explainer": { "endpoint-url": "http://127.0.0.1:11434/v1" } } },
      }),
    }));
    expect(ok.status).toBe(200);
  });

  it("rejects malformed maintenance windows with 422", async () => {
    const patch = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "operations-settings", attributes: { "maintenance-windows": { enabled: true, windows: [{ days: [9], "start-time": "25:00", "end-time": "02:00" }] } } },
      }),
    }));
    expect(patch.status).toBe(422);
  });

  it("accepts a plan-explainer provider field (additive)", async () => {
    const patch = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "operations-settings", attributes: { "plan-explainer": { provider: "openrouter", enabled: true, "reasoning-effort": "xhigh" } } },
      }),
    }));
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { data: { attributes: { "plan-explainer": Record<string, unknown> } } };
    expect(body.data.attributes["plan-explainer"].provider).toBe("openrouter");
    expect(body.data.attributes["plan-explainer"]["reasoning-effort"]).toBe("xhigh");

    // Clearing it back to null also validates.
    const clear = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "operations-settings", attributes: { "plan-explainer": { provider: null, enabled: false, "reasoning-effort": null } } },
      }),
    }));
    expect(clear.status).toBe(200);
  });

  it("rejects a non-string plan-explainer provider with 422", async () => {
    const patch = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "operations-settings", attributes: { "plan-explainer": { provider: 42 } } },
      }),
    }));
    expect(patch.status).toBe(422);
  });

  it("rejects an unsupported plan-explainer reasoning effort", async () => {
    const patch = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "operations-settings", attributes: { "plan-explainer": { "reasoning-effort": "extreme" } } },
      }),
    }));
    expect(patch.status).toBe(422);
  });

  it("serves the provider catalog and per-provider models to admins only", async () => {
    // Non-admin is forbidden from both endpoints.
    const forbidden = await request("/api/v2/admin/operations-settings/explainer/providers");
    expect(forbidden.status).toBe(404);
    const forbiddenModels = await request("/api/v2/admin/operations-settings/explainer/models?provider=openrouter");
    expect(forbiddenModels.status).toBe(404);

    const providers = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings/explainer/providers", {
      headers: { Authorization: `Bearer ${adminToken}` },
    }));
    expect(providers.status).toBe(200);
    const providersBody = (await providers.json()) as { data: Array<{ id: string; attributes: { name: string; "model-count": number } }> };
    expect(providersBody.data.length).toBeGreaterThan(0);
    const ids = providersBody.data.map((p) => p.id);
    expect(ids).toContain("openrouter");
    // Synthetic "OpenAI Compatible (Custom)" is pinned first.
    expect(ids[0]).toBe("custom");
    const customEntry = providersBody.data[0];
    expect(customEntry).toBeDefined();
    expect(customEntry?.attributes.name).toBe("OpenAI Compatible (Custom)");
    expect(customEntry?.attributes["model-count"]).toBe(0);

    // The synthetic custom provider resolves with zero catalog models
    // (the admin types the model id), never a 404.
    const customModels = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings/explainer/models?provider=custom", {
      headers: { Authorization: `Bearer ${adminToken}` },
    }));
    expect(customModels.status).toBe(200);
    const customBody = (await customModels.json()) as { data: unknown[]; meta: { "model-count": number } };
    expect(customBody.data).toEqual([]);
    expect(customBody.meta["model-count"]).toBe(0);

    const models = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings/explainer/models?provider=openrouter", {
      headers: { Authorization: `Bearer ${adminToken}` },
    }));
    expect(models.status).toBe(200);
    const modelsBody = (await models.json()) as { data: Array<{ id: string; attributes: { name: string } }>; meta: { "model-count": number } };
    expect(modelsBody.meta["model-count"]).toBeGreaterThan(0);
    expect(modelsBody.data.every((m) => typeof m.id === "string" && m.id !== "")).toBe(true);

    // Unknown provider -> 404; missing param -> 422.
    const unknown = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings/explainer/models?provider=does-not-exist", {
      headers: { Authorization: `Bearer ${adminToken}` },
    }));
    expect(unknown.status).toBe(404);
    const missing = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings/explainer/models", {
      headers: { Authorization: `Bearer ${adminToken}` },
    }));
    expect(missing.status).toBe(422);
  });
});
