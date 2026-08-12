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

    const response = await request(`/api/v2/organizations/${orgName}/change-calendar`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { type: string; attributes: { kind: string; at?: string; workspaceId?: string; workspaceName?: string } }[];
      meta?: { "total-count"?: number };
    };
    const kinds = body.data.map((entry): string => entry.attributes.kind);
    expect(kinds).toContain("apply");
    expect(kinds).toContain("auto-destroy");
    expect(kinds).toContain("change-request");
    expect(body.meta?.["total-count"]).toBe(body.data.length);
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
        data: { type: "operations-settings", attributes: { "plan-explainer": { provider: "openrouter", enabled: true } } },
      }),
    }));
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { data: { attributes: { "plan-explainer": Record<string, unknown> } } };
    expect(body.data.attributes["plan-explainer"].provider).toBe("openrouter");

    // Clearing it back to null also validates.
    const clear = await app.handle(new Request("http://terrence.test/api/v2/admin/operations-settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "operations-settings", attributes: { "plan-explainer": { provider: null, enabled: false } } },
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

  it("serves the provider catalog and per-provider models to admins only", async () => {
    // Non-admin is forbidden from both endpoints.
    const forbidden = await request("/api/v2/admin/operations-settings/explainer/providers");
    expect(forbidden.status).toBe(403);
    const forbiddenModels = await request("/api/v2/admin/operations-settings/explainer/models?provider=openrouter");
    expect(forbiddenModels.status).toBe(403);

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
