import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AccountSettings } from "../src/views/AccountSettings";
import { applyTheme, applyThemeIfUnchanged, getThemeRevision } from "../src/lib/theme";

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function account(theme = "original-light"): Response {
  return json({
    data: {
      id: "user-1",
      type: "users",
      attributes: { username: "alice", email: "alice@example.com", theme, "must-change-password": false },
    },
  });
}

afterEach((): void => {
  cleanup();
  applyTheme("original-light");
  globalThis.fetch = originalFetch;
});

test("lists extensible light/dark themes and persists a selection", async () => {
  let updatedTheme = "";
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/account/details") return account();
    if (url === "/api/v2/users/user-1/authentication-tokens") return json({ data: [] });
    if (url === "/api/v2/account/sessions") return json({ data: [] });
    if (url === "/api/v2/account/mfa") return json({ data: { attributes: { enabled: false } } });
    if (url === "/api/v2/account/update" && init?.method === "PATCH") {
      const body = typeof init.body === "string" ? init.body : "";
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      updatedTheme = JSON.parse(body).data.attributes.theme as string;
      return account(updatedTheme);
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<MemoryRouter><AccountSettings /></MemoryRouter>);
// SAFETY: the component renders this element type for the queried role/label.
  const select = await view.findByLabelText("Theme") as HTMLSelectElement;

  expect(select.querySelectorAll("optgroup")).toHaveLength(2);
  expect(view.getByRole("option", { name: "Catppuccin Latte" })).toBeTruthy();
  expect(view.getByRole("option", { name: "Dracula" })).toBeTruthy();

  fireEvent.change(select, { target: { value: "dracula" } });
  await waitFor((): void => {
    expect(view.getByText("Theme updated")).toBeTruthy();
  });
  expect(updatedTheme).toBe("dracula");
  expect(localStorage.getItem("terrence-theme")).toBe("dracula");
  expect(document.documentElement.dataset.theme).toBe("dracula");
  expect(document.documentElement.classList.contains("dark")).toBeTrue();
  expect(document.documentElement.style.getPropertyValue("--topbar")).toBe("232 18% 15%");
  expect(document.documentElement.style.getPropertyValue("--topbar-foreground")).toBe("60 30% 96%");
});

test("changes the display timezone locally without an account update", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/account/details") return account();
    if (url === "/api/v2/users/user-1/authentication-tokens") return json({ data: [] });
    if (url === "/api/v2/account/sessions") return json({ data: [] });
    if (url === "/api/v2/account/mfa") return json({ data: { attributes: { enabled: false } } });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(<MemoryRouter><AccountSettings /></MemoryRouter>);
// SAFETY: the component renders this element type for the queried role/label.
  const select = await view.findByLabelText("Timezone") as HTMLSelectElement;

  expect(select.value).toBe("local");
  fireEvent.change(select, { target: { value: "utc" } });

  await waitFor((): void => {
    expect(select.value).toBe("utc");
  });
  expect(localStorage.getItem("terrence-display-timezone")).toBe("utc");
  expect(fetchMock).toHaveBeenCalledTimes(4);
});
test("ignores an account theme read that started before a newer theme selection", (): void => {
  const accountReadRevision = getThemeRevision();
  applyTheme("dracula");

  expect(applyThemeIfUnchanged("original-light", accountReadRevision)).toBeFalse();
  expect(document.documentElement.dataset.theme).toBe("dracula");
});

test("applies the locally stored theme without an account request", (): void => {
  localStorage.setItem("terrence-theme", "nord-dark");

  applyTheme();

  expect(document.documentElement.dataset.theme).toBe("nord-dark");
  expect(document.documentElement.classList.contains("dark")).toBeTrue();
});
