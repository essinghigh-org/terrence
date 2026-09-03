import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AdminSmtpSettings } from "../src/views/AdminSmtpSettings";
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

test("shows secure SMTP defaults and requires an explicit plaintext opt-in", async () => {
  const settings: JsonObject = {
    enabled: true,
    host: "smtp.example.com",
    port: 587,
    "sender-email": "noreply@example.com",
    auth: "plain",
    encryption: "starttls",
    "password-set": true,
  };
  let savedBody: JsonObject | undefined;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/smtp-settings" && init?.method === "PATCH") {
      // SAFETY: the request body was JSON.stringify'd by the component before fetch.
      savedBody = JSON.parse(init.body as string) as JsonObject;
      return json({ data: { attributes: settings } });
    }
    if (url === "/api/v2/admin/smtp-settings") return json({ data: { attributes: settings } });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(<AdminSmtpSettings />);
  await waitFor((): void => { expect(view.getByLabelText("Encryption")).toBeTruthy(); });
  const encryption = view.getByLabelText("Encryption") as HTMLSelectElement;
  expect(encryption.value).toBe("starttls");

  fireEvent.change(encryption, { target: { value: "plain" } });
  expect(view.getByRole("alert").textContent).toContain("insecure");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor((): void => { expect(savedBody).toBeDefined(); });

  const attributes = (savedBody?.["data"] as JsonObject)?.["attributes"] as JsonObject;
  expect(attributes["encryption"]).toBe("plain");
});
