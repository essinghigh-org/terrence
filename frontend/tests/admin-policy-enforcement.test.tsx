import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { AdminPolicyEnforcement } from "../src/views/AdminPolicyEnforcement";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const json = (data: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/vnd.api+json" } });
const snapshot = (revision = 0, opa = true, sentinel = true): Response =>
  json({ data: { id: "policy-enforcement", type: "policy-enforcement", attributes: { revision, opa, sentinel } } });
const page = (siteAdmin = true, accountLoaded = true): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={{ siteAdmin, accountLoaded }} />}>
          <Route index element={<AdminPolicyEnforcement />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
const ready = async (view: ReturnType<typeof render>): Promise<void> => {
  await waitFor((): void => {
    expect(view.getByRole("switch", { name: "OPA enforcement" })).toBeTruthy();
  });
};
const reason = (view: ReturnType<typeof render>, value = "Incident mitigation"): void => {
  fireEvent.input(view.getByLabelText("Reason for change (required)"), { target: { value } });
};

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("gates loading accounts and non-admins before fetching settings", (): void => {
  const fetchMock = mock((): Promise<Response> => Promise.resolve(snapshot()));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const loading = page(false, false);
  expect(loading.getByRole("status").textContent).toContain("Loading account");
  expect(fetchMock).not.toHaveBeenCalled();
  loading.unmount();
  const denied = page(false);
  expect(denied.getByRole("alert").textContent).toContain("Site-administrator access");
  expect(denied.queryByRole("switch")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("shows defaults and saves only the changed engine with revision and trimmed audit reason", async (): Promise<void> => {
  let body: unknown;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).toBe(
      "/api/v2/admin/policy-enforcement",
    );
    if (init?.method === "PATCH") {
      body = JSON.parse(init.body as string) as unknown;
      return snapshot(1, false, true);
    }
    return snapshot();
  }) as unknown as typeof fetch;
  const view = page();
  await ready(view);
  expect(view.getAllByText("Current: Active · enforcing policies")).toHaveLength(2);
  expect(view.getByText(/not policy advisory mode/)).toBeTruthy();
  expect(view.getByText(/Changing settings after policy evaluation requires a new plan before apply/)).toBeTruthy();
  expect(view.getByText(/completed applies are not reversed/)).toBeTruthy();
  expect(view.getByText(/evaluation errors block runs/)).toBeTruthy();
  fireEvent.click(view.getByRole("switch", { name: "OPA enforcement" }));
  expect(view.getByText("Unsaved: Disable enforcement · site-wide bypass")).toBeTruthy();
  reason(view, "  Incident mitigation  ");
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  await waitFor((): void => {
    expect(view.getByRole("status").textContent).toContain("saved and audited. Revision 1");
  });
  expect(body).toEqual({
    data: { type: "policy-enforcement", attributes: { revision: 0, reason: "Incident mitigation", opa: false } },
  });
  expect(view.getByText("Current: Disabled · site-wide bypass")).toBeTruthy();
  expect(view.getByRole("switch", { name: "Sentinel enforcement" }).getAttribute("aria-checked")).toBe("true");
});

test("rejects empty and overlong reasons and blocks duplicate saves", async (): Promise<void> => {
  let resolveSave: ((value: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve): void => {
    resolveSave = resolve;
  });
  let patches = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PATCH") {
      patches += 1;
      return pending;
    }
    return snapshot();
  }) as unknown as typeof fetch;
  const view = page();
  await ready(view);
  fireEvent.click(view.getByRole("switch", { name: "Sentinel enforcement" }));
  for (const value of ["", "   ", "a".repeat(2001)]) {
    reason(view, value);
    expect(view.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  }
  expect(patches).toBe(0);
  reason(view);
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  fireEvent.click(view.getByRole("button", { name: "Saving…" }));
  await waitFor((): void => {
    expect(patches).toBe(1);
  });
  expect(view.getByRole("switch", { name: "OPA enforcement" }).hasAttribute("data-disabled")).toBe(true);
  resolveSave?.(snapshot(1, true, false));
  await waitFor((): void => {
    expect(view.getByRole("status").textContent).toContain("saved and audited");
  });
});

test("stale saves require explicit reload and reapplication against the latest revision", async (): Promise<void> => {
  let gets = 0;
  let patches = 0;
  let lastBody: unknown;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PATCH") {
      patches += 1;
      lastBody = JSON.parse(init.body as string) as unknown;
      return patches === 1 ? json({ errors: [{ detail: "Stale revision" }] }, 409) : snapshot(3, false, false);
    }
    gets += 1;
    return gets === 1 ? snapshot() : snapshot(2, true, false);
  }) as unknown as typeof fetch;
  const view = page();
  await ready(view);
  fireEvent.click(view.getByRole("switch", { name: "OPA enforcement" }));
  reason(view);
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  await waitFor((): void => {
    expect(view.getByRole("alert").textContent).toContain("Your changes have not been saved");
  });
  expect(gets).toBe(1);
  expect(view.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Reload latest settings" }));
  await ready(view);
  expect(view.getByRole("switch", { name: "OPA enforcement" }).getAttribute("aria-checked")).toBe("true");
  expect(view.getByRole("switch", { name: "Sentinel enforcement" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.click(view.getByRole("switch", { name: "OPA enforcement" }));
  reason(view, "Reviewed latest settings");
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  await waitFor((): void => {
    expect(view.getByRole("status").textContent).toContain("Revision 3");
  });
  expect(lastBody).toEqual({
    data: { type: "policy-enforcement", attributes: { revision: 2, reason: "Reviewed latest settings", opa: false } },
  });
});

test("failed loads expose retry without editable defaults", async (): Promise<void> => {
  let calls = 0;
  globalThis.fetch = mock(async (): Promise<Response> => {
    calls += 1;
    return calls === 1 ? json({ errors: [{ detail: "Forbidden" }] }, 403) : snapshot();
  }) as unknown as typeof fetch;
  const view = page();
  await waitFor((): void => {
    expect(view.getByRole("alert").textContent).toContain("Forbidden");
  });
  expect(view.queryByRole("switch")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Reload settings" }));
  await ready(view);
});

test("invalid revisions cannot turn an unreadable response into editable defaults", async (): Promise<void> => {
  globalThis.fetch = mock(
    async (): Promise<Response> => json({ data: { attributes: { revision: -1, opa: true, sentinel: true } } }),
  ) as unknown as typeof fetch;
  const view = page();
  await waitFor((): void => {
    expect(view.getByRole("alert").textContent).toContain("Could not read policy enforcement settings");
  });
  expect(view.queryByRole("switch")).toBeNull();
});

test("save errors preserve changes and reason for an explicit retry", async (): Promise<void> => {
  let patches = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PATCH") {
      patches += 1;
      return patches === 1 ? json({ errors: [{ detail: "Audit write failed" }] }, 500) : snapshot(1, false, true);
    }
    return snapshot();
  }) as unknown as typeof fetch;
  const view = page();
  await ready(view);
  fireEvent.click(view.getByRole("switch", { name: "OPA enforcement" }));
  reason(view);
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  await waitFor((): void => {
    expect(view.getByRole("alert").textContent).toContain("Audit write failed");
  });
  expect(view.getByText("Unsaved: Disable enforcement · site-wide bypass")).toBeTruthy();
  expect(view.queryByRole("status")).toBeNull();
  expect(view.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Save changes" }));
  await waitFor((): void => {
    expect(view.getByRole("status").textContent).toContain("saved and audited");
  });
  expect(patches).toBe(2);
});
