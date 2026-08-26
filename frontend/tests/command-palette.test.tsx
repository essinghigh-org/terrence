import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { CommandPalette } from "../src/components/CommandPalette";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

function json(data: JsonValue): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function urlOf(input: string | URL | Request): string {
  return isString(input) ? input : input instanceof URL ? input.toString() : input.url;
}

beforeEach((): void => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({ data: [{ id: "org-acme", attributes: { name: "acme" } }] });
    }
    if (url === "/api/v2/docs") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
});

afterEach((): void => {
  cleanup();
  if (localStorage !== undefined) localStorage.clear();
  globalThis.fetch = originalFetch;
});

let capturedPathname = "";
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  capturedPathname = location.pathname;
  return <></>;
}

// SAFETY: React attaches the _valueTracker to controlled inputs in the test renderer.
const changeInput = (element: HTMLElement, value: string): void => {
  const tracker = (element as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
  if (tracker !== undefined) {
    tracker.setValue(value === "" ? "x" : "");
  }
  Reflect.set(element, "value", value);
  // Base UI portals swallow the native change event under jsdom (only the
  // input event reaches React handlers), so fire input — matching how real
  // browsers deliver text entry.
  fireEvent.input(element, { target: { value } });
};

function renderPalette(props: Partial<Parameters<typeof CommandPalette>[0]> = {}): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/app"]}>
      <LocationProbe />
      <Routes>
        <Route
          path="/app"
          element={
            <CommandPalette
              open
              onOpenChange={(): void => undefined}
              canManageWorkspaces={false}
              {...props}
            />
          }
        />
        <Route path="*" element={<p>navigated</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

test("renders an ARIA combobox whose listbox owns every result row", async () => {
  const view = renderPalette();

  const input = await waitFor((): HTMLElement => view.getByRole("combobox"));
  const listboxId = input.getAttribute("aria-controls");
  expect(listboxId).not.toBeNull();
  expect(view.getByRole("listbox")).toBeTruthy();
  // Two navigation entries plus the acme organization.
  expect(view.getAllByRole("option")).toHaveLength(3);
  expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-0`);
});

test("arrow keys move the highlight and Enter activates the selection", async () => {
  const onOpenChange = mock((): void => undefined);
  const view = renderPalette({ onOpenChange });

  const input = await waitFor((): HTMLElement => view.getByRole("combobox"));
  const listboxId = input.getAttribute("aria-controls") ?? "";

  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-1`);
  expect(view.getAllByRole("option")[1]?.getAttribute("data-highlighted")).toBe("true");
  expect(view.getAllByRole("option")[0]?.getAttribute("data-highlighted")).toBeNull();

  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-2`);

  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor((): void => { expect(capturedPathname).toBe("/app/acme/workspaces"); });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("the highlight wraps around at both ends of the list", async () => {
  const view = renderPalette();

  const input = await waitFor((): HTMLElement => view.getByRole("combobox"));
  const listboxId = input.getAttribute("aria-controls") ?? "";

  // Up from the first row lands on the last one.
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-2`);

  // Down from the last row wraps back to the top.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-0`);

  fireEvent.keyDown(input, { key: "End" });
  expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-2`);
  fireEvent.keyDown(input, { key: "Home" });
  expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-0`);
});

test("typing filters results and resets the highlight to the top row", async () => {
  const view = renderPalette();

  const input = await waitFor((): HTMLElement => view.getByRole("combobox"));
  const listboxId = input.getAttribute("aria-controls") ?? "";

  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  changeInput(input, "acme");

  await waitFor((): void => {
    expect(view.getAllByRole("option")).toHaveLength(1);
  });
  expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-0`);
  expect(view.getByRole("option", { name: /acme/ })).toBeTruthy();
});
