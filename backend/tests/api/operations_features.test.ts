import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  adminSettings,
  apiTokens,
  changeRequests,
  organizations,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";
import { getSettings, invalidateSettingsCache } from "../../src/lib/settings";
import {
  inMaintenanceWindow,
  maintenanceWindowsBlockApply,
  type MaintenanceWindow,
} from "../../src/lib/operations";
import { deletePlanJsonArtifact, writePlanJsonArtifact } from "../../src/lib/plan-json";

const suffix = crypto.randomUUID();
const userId = `ops-user-${suffix}`;
const token = `ops-token-${suffix}`;
const adminUserId = `ops-admin-${suffix}`;
const adminToken = `ops-admin-token-${suffix}`;
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

  const orgResponse = await request("/api/v2/organizations", "POST", {
    data: { type: "organizations", attributes: { name: orgName } },
  });
  expect(orgResponse.status).toBe(201);
  orgId = (await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) }))?.id ?? "";

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
  if (orgId !== "") await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(apiTokens).where(eq(apiTokens.token, token));
  await db.delete(apiTokens).where(eq(apiTokens.token, adminToken));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, adminUserId));
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
    const payload = JSON.stringify({ run: webhookRunId });
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
});

describe("change calendar (21.4)", () => {
  it("lists applies, auto-destroys, and change requests sorted by time", async () => {
    const futureAutoDestroy = new Date(Date.now() + 86_400_000).toISOString();
    await db.update(workspaces).set({ autoDestroyAt: futureAutoDestroy }).where(eq(workspaces.id, workspaceId));

    const response = await request(`/api/v2/organizations/${orgName}/change-calendar`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { type: string; attributes: { kind: string; at?: string; workspaceId?: string; workspaceName?: string } }[];
    };
    const kinds = body.data.map((entry): string => entry.attributes.kind);
    expect(kinds).toContain("apply");
    expect(kinds).toContain("auto-destroy");
    expect(kinds).toContain("change-request");
    const applyEntry = body.data.find((entry): boolean => entry.attributes.kind === "apply");
    expect(applyEntry?.attributes.workspaceName).toBe(workspaceName);
    const atValues = body.data.map((entry): string => String(entry.attributes.at ?? ""));
    expect([...atValues].sort()).toEqual(atValues);
  });

  it("hides the calendar from users without org access", async () => {
    const response = await request(`/api/v2/organizations/nonexistent-${suffix}/change-calendar`);
    expect(response.status).toBe(404);
  });
});

describe("AI plan explainer (21.2)", () => {
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
    expect(response.status).toBe(502);
    const body = (await response.json()) as { errors: { detail: string }[] };
    expect(body.errors[0]?.detail ?? "").toContain("unreachable");
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

describe("admin operations settings surface", () => {
  it("rejects non-admins with 403", async () => {
    const response = await request("/api/v2/admin/operations-settings");
    expect(response.status).toBe(403);
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
    const patched = (await patch.json()) as { data: { attributes: { "approval-webhook": { enabled: boolean; secret: string }; "maintenance-windows": { enabled: boolean; windows: unknown[] } } } };
    expect(patched.data.attributes["approval-webhook"].enabled).toBe(true);
    expect(patched.data.attributes["approval-webhook"].secret).toBe("new-secret");
    expect(patched.data.attributes["maintenance-windows"].enabled).toBe(true);
    expect(patched.data.attributes["maintenance-windows"].windows).toHaveLength(1);
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
});
