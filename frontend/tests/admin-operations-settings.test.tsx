import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AdminOperationsSettings } from "../src/views/AdminOperationsSettings";

const originalFetch = globalThis.fetch;
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/vnd.api+json" },
});
const urlOf = (input: string | URL | Request): string => typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("uses provider defaults and saves an optional base URL without an endpoint URL", async () => {
  const settings = {
    "approval-webhook": { enabled: false, url: null, "secret-set": false },
    "maintenance-windows": { enabled: false, windows: [] },
    "plan-explainer": {
      enabled: false,
      provider: "custom",
      "base-url": null,
      model: null,
      "api-key-set": false,
      "reasoning-effort": null,
    },
  };
  let savedBody: Record<string, unknown> | undefined;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/operations-settings" && init?.method === "PATCH") {
      savedBody = JSON.parse(init.body as string) as Record<string, unknown>;
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
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(<AdminOperationsSettings />);
  await waitFor((): void => { expect(view.getByLabelText("Base URL (optional)")).toBeTruthy(); });
  const provider = view.getByLabelText("Provider");
  fireEvent.focus(provider);
  fireEvent.input(provider, { target: { value: "openrouter" } });
  fireEvent.click(view.getByRole("option", { name: /OpenRouter/ }));
  expect((view.getByLabelText("Base URL (optional)") as HTMLInputElement).value).toBe("");

  fireEvent.input(view.getByLabelText("Base URL (optional)"), { target: { value: "https://api.example.com/v1" } });
  fireEvent.click(view.getByRole("button", { name: "Save operations settings" }));
  await waitFor((): void => { expect(savedBody).toBeDefined(); });

  const attributes = (savedBody?.data as Record<string, unknown>)?.attributes as Record<string, unknown>;
  const explainer = attributes["plan-explainer"] as Record<string, unknown>;
  expect(explainer["base-url"]).toBe("https://api.example.com/v1");
  expect(explainer["endpoint-url"]).toBeUndefined();

  const labels = Array.from(view.container.querySelectorAll("label")).map((label): string => label.textContent?.trim() ?? "");
  const order = ["Provider", "Model", "Reasoning effort", "Base URL (optional)"].map((label): number => labels.indexOf(label));
  expect(order.every((index, position): boolean => index >= 0 && (position === 0 || index > order[position - 1]!))).toBe(true);
});
