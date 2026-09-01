import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AdminPlanExplainer } from "../src/views/AdminPlanExplainer";
import { isString } from "../src/lib/type-guards";
import type { JsonObject, JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const json = (data: JsonValue, status = 200): Response => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/vnd.api+json" },
});
const urlOf = (input: string | URL | Request): string => isString(input) ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("uses provider defaults and saves an optional base URL without an endpoint URL", async () => {
  const settings = {
    "plan-explainer": {
      enabled: false,
      provider: "custom",
      "base-url": null,
      model: null,
      "api-key-set": false,
      "reasoning-effort": null,
    },
  };
  let savedBody: JsonObject | undefined;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/operations-settings" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      savedBody = JSON.parse(init.body as string) as JsonObject;
      return json({ data: { attributes: settings } });
    }
    if (url === "/api/v2/admin/operations-settings") return json({ data: { attributes: settings } });
    if (url === "/api/v2/admin/operations-settings/explainer/providers") {
      return json({ data: [
        { id: "custom", attributes: { name: "OpenAI Compatible (Custom)", "model-count": 0 } },
        { id: "openrouter", attributes: { name: "OpenRouter", "model-count": 1 } },
      ] });
    }
    if (url.startsWith("/api/v2/admin/operations-settings/explainer/models?provider=")) return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(<AdminPlanExplainer />);
  await waitFor((): void => { expect(view.getByLabelText("Base URL (optional)")).toBeTruthy(); });
  const provider = view.getByLabelText("Provider");
  fireEvent.focus(provider);
  fireEvent.input(provider, { target: { value: "openrouter" } });
  fireEvent.click(view.getByRole("option", { name: /OpenRouter/ }));
// SAFETY: the component renders this element type for the queried role/label.
  expect((view.getByLabelText("Base URL (optional)") as HTMLInputElement).value).toBe("");

  fireEvent.input(view.getByLabelText("Base URL (optional)"), { target: { value: "https://api.example.com/v1" } });
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  await waitFor((): void => { expect(savedBody).toBeDefined(); });

// SAFETY: the fixture object is read as a record; each field is typed below.
  const attributes = (savedBody?.data as JsonObject)?.attributes as JsonObject;
  expect(Object.keys(attributes)).toEqual(["plan-explainer"]);
  expect(attributes["approval-webhook"]).toBeUndefined();
  expect(attributes["maintenance-windows"]).toBeUndefined();
// SAFETY: the fixture object is read as a record; each field is typed below.
  const explainer = attributes["plan-explainer"] as JsonObject;
  expect(explainer["base-url"]).toBe("https://api.example.com/v1");
  expect(explainer["endpoint-url"]).toBeUndefined();

  const labels = Array.from(view.container.querySelectorAll("label")).map((label): string => label.textContent?.trim() ?? "");
  const order = ["Provider", "Model", "Reasoning effort", "Base URL (optional)"].map((label): number => labels.indexOf(label));
  expect(order.every((index, position): boolean => index >= 0 && (position === 0 || index > order[position - 1]!))).toBe(true);
});

test("AdminLoggingSettings loads and saves logging configuration independently", async () => {
  const { AdminLoggingSettings } = await import("../src/views/AdminLoggingSettings");
  let patchBody: JsonObject | undefined;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/logging-settings" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      patchBody = JSON.parse(init.body as string) as JsonObject;
      return json({ data: { attributes: { enabled: true, "log-level": "debug" } } });
    }
    if (url === "/api/v2/admin/logging-settings") {
      return json({ data: { attributes: { enabled: true, "log-level": "info", "syslog-targets": ["udp://syslog.local:514"] } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const view = render(<AdminLoggingSettings />);
  await waitFor((): void => { expect(view.getByLabelText("Remote destinations")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  await waitFor((): void => { expect(patchBody).toBeDefined(); });
// SAFETY: the fixture object is read as a record; each field is typed below.
  const attributes = (patchBody?.data as JsonObject)?.attributes as JsonObject;
  expect(attributes).toEqual({
    enabled: true,
    "log-level": "info",
    "syslog-level": null,
    "syslog-targets": ["udp://syslog.local:514"],
    "syslog-hostname": null,
    "syslog-app": null,
  });
  expect(view.getByText(/Logging settings saved/i)).toBeTruthy();
});

test("AdminApprovalWebhook loads and saves webhook configuration independently", async () => {
  const { AdminApprovalWebhook } = await import("../src/views/AdminApprovalWebhook");
  let patchBody: JsonObject | undefined;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/operations-settings" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      patchBody = JSON.parse(init.body as string) as JsonObject;
      return json({ data: { attributes: { "approval-webhook": { enabled: true, url: "https://example.com/hook" } } } });
    }
    if (url === "/api/v2/admin/operations-settings") {
      return json({ data: { attributes: { "approval-webhook": { enabled: false, url: null, "secret-set": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const view = render(<AdminApprovalWebhook />);
  await waitFor((): void => { expect(view.getByLabelText("Callback URL (optional)")).toBeTruthy(); });
  fireEvent.input(view.getByLabelText("Callback URL (optional)"), { target: { value: "https://example.com/hook" } });
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  await waitFor((): void => { expect(patchBody).toBeDefined(); });
// SAFETY: the fixture object is read as a record; each field is typed below.
  const attributes = (patchBody?.data as JsonObject)?.attributes as JsonObject;
  expect(Object.keys(attributes)).toEqual(["approval-webhook"]);
  expect(attributes).toEqual({
    "approval-webhook": {
      enabled: false,
      url: "https://example.com/hook",
    },
  });
  expect(attributes["plan-explainer"]).toBeUndefined();
  expect(attributes["maintenance-windows"]).toBeUndefined();
  expect(view.getByText(/Webhook settings saved/i)).toBeTruthy();
});

test("AdminMaintenanceWindows loads and saves maintenance windows independently", async () => {
  const { AdminMaintenanceWindows } = await import("../src/views/AdminMaintenanceWindows");
  let patchBody: JsonObject | undefined;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/operations-settings" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      patchBody = JSON.parse(init.body as string) as JsonObject;
      return json({ data: { attributes: { "maintenance-windows": { enabled: true, windows: [] } } } });
    }
    if (url === "/api/v2/admin/operations-settings") {
      return json({ data: { attributes: { "maintenance-windows": { enabled: false, windows: [] } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const view = render(<AdminMaintenanceWindows />);
  await waitFor((): void => { expect(view.getByText("No maintenance windows yet")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Add maintenance window" }));
  await waitFor((): void => { expect(view.getByText("Window 1")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  await waitFor((): void => { expect(patchBody).toBeDefined(); });
// SAFETY: the fixture object is read as a record; each field is typed below.
  const attributes = (patchBody?.data as JsonObject)?.attributes as JsonObject;
  expect(Object.keys(attributes)).toEqual(["maintenance-windows"]);
  expect(attributes).toEqual({
    "maintenance-windows": {
      enabled: false,
      windows: [
        {
          days: [0, 6],
          "start-time": "00:00",
          "end-time": "04:00",
        },
      ],
    },
  });
  expect(attributes["approval-webhook"]).toBeUndefined();
  expect(attributes["plan-explainer"]).toBeUndefined();
  expect(view.getByText(/Maintenance settings saved/i)).toBeTruthy();
});