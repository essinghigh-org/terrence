import { afterEach, expect, test } from "bun:test";
import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createBrowserRouter, createMemoryRouter, Link, Route, RouterProvider, Routes, useNavigate } from "react-router-dom";
import { UnsavedChangesProvider, useUnsavedChangesWarning } from "../src/lib/use-unsaved-changes";

const routers: ReturnType<typeof createMemoryRouter>[] = [];
afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => { router.dispose(); });
  window.history.replaceState(null, "", "/");
});

function Form({ initiallyDirty = true, secondSection = false }: Readonly<{ initiallyDirty?: boolean; secondSection?: boolean }>): React.JSX.Element {
  const [dirty, setDirty] = useState(initiallyDirty);
  const [otherDirty, setOtherDirty] = useState(secondSection);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  useUnsavedChangesWarning(dirty, "Unsaved settings will be lost.");
  useUnsavedChangesWarning(otherDirty, "Unsaved comment will be lost.");
  return <div>
    <p>Form</p>
    <Link to="/elsewhere">Breadcrumb</Link>
    <Link to="?tab=other">Change tab</Link>
    <button onClick={() => { void navigate("/elsewhere"); }}>Switch organization</button>
    <button onClick={() => { void navigate("/elsewhere", { replace: true }); }}>Replace route</button>
    <button onClick={() => { setDirty(false); }}>Save settings</button>
    <button onClick={() => { setOtherDirty(false); }}>Save comment</button>
    <button onClick={() => { setError("Save failed"); }}>Fail save</button>
    <p>{error}</p>
  </div>;
}

function setup(options: { browser?: boolean; initiallyDirty?: boolean; secondSection?: boolean } = {}) {
  const routes = [{ path: "*", element: <UnsavedChangesProvider><Routes>
    <Route path="/" element={<Form initiallyDirty={options.initiallyDirty ?? true} secondSection={options.secondSection ?? false} />} />
    <Route path="/elsewhere" element={<p>Destination</p>} />
  </Routes></UnsavedChangesProvider> }];
  const router = options.browser ? createBrowserRouter(routes) : createMemoryRouter(routes);
  routers.push(router);
  const view = render(<StrictMode><RouterProvider router={router} /></StrictMode>);
  return { ...view, router };
}

for (const control of ["Breadcrumb", "Change tab", "Switch organization", "Replace route"]) {
  test(`${control} stays put when declined and retries the intended transition when confirmed`, async () => {
    const view = setup();
    const leave = () => fireEvent.click(view.getByRole(control === "Breadcrumb" || control === "Change tab" ? "link" : "button", { name: control }));
    leave();
    await waitFor(() => { expect(view.getByRole("dialog")).toBeTruthy(); });
    expect(view.router.state.location.pathname).toBe("/");
    fireEvent.click(view.getByRole("button", { name: "Stay" }));
    await waitFor(() => { expect(view.queryByRole("dialog")).toBeNull(); });
    expect(view.router.state.location.search).toBe("");
    leave();
    await waitFor(() => { expect(view.getByRole("dialog")).toBeTruthy(); });
    fireEvent.click(view.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => { expect(control === "Change tab" ? view.router.state.location.search : view.router.state.location.pathname).toBe(control === "Change tab" ? "?tab=other" : "/elsewhere"); });
  });
}

test("browser Back is blocked, restored on Stay and retried on Discard", async () => {
  window.history.replaceState(null, "", "/elsewhere");
  const view = setup({ browser: true });
  await act(async () => { await view.router.navigate("/"); });
  act(() => { window.history.back(); });
  await waitFor(() => { expect(view.getByRole("dialog")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Stay" }));
  await waitFor(() => { expect(window.location.pathname).toBe("/"); });
  expect(view.getByText("Form")).toBeTruthy();
  act(() => { window.history.back(); });
  await waitFor(() => { expect(view.getByRole("dialog")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Discard and leave" }));
  await waitFor(() => { expect(window.location.pathname).toBe("/elsewhere"); });
  await waitFor(() => { expect(view.getByText("Destination")).toBeTruthy(); });
});

test("browser Forward is blocked too", async () => {
  const view = setup({ browser: true });
  fireEvent.click(view.getByRole("link", { name: "Breadcrumb" }));
  await waitFor(() => { expect(view.getByRole("dialog")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Discard and leave" }));
  await waitFor(() => { expect(window.location.pathname).toBe("/elsewhere"); });
  act(() => { window.history.back(); });
  await waitFor(() => { expect(view.getByText("Form")).toBeTruthy(); });
  act(() => { window.history.forward(); });
  await waitFor(() => { expect(view.getByRole("dialog")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Stay" }));
  await waitFor(() => { expect(window.location.pathname).toBe("/"); });
  act(() => { window.history.forward(); });
  await waitFor(() => { expect(view.getByRole("dialog")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Discard and leave" }));
  await waitFor(() => { expect(window.location.pathname).toBe("/elsewhere"); });
});

test("all dirty sections must save; failed saves keep one shared dialog and unload protection", async () => {
  const view = setup({ secondSection: true });
  fireEvent.click(view.getByRole("button", { name: "Save settings" }));
  fireEvent.click(view.getByRole("button", { name: "Fail save" }));
  expect(view.getByText("Save failed")).toBeTruthy();
  expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
  fireEvent.click(view.getByRole("link", { name: "Breadcrumb" }));
  await waitFor(() => { expect(view.getAllByRole("dialog")).toHaveLength(1); });
  fireEvent.click(view.getByRole("button", { name: "Stay" }));
  fireEvent.click(view.getByRole("button", { name: "Save comment" }));
  expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
  fireEvent.click(view.getByRole("link", { name: "Breadcrumb" }));
  await waitFor(() => { expect(view.getByText("Destination")).toBeTruthy(); });
  expect(view.queryByRole("dialog")).toBeNull();
});

test("clean forms and unmounted guards never patch history or block navigation", async () => {
  const push = Object.getOwnPropertyDescriptor(window.history, "pushState");
  const replace = Object.getOwnPropertyDescriptor(window.history, "replaceState");
  const view = setup({ initiallyDirty: false });
  expect(Object.getOwnPropertyDescriptor(window.history, "pushState")).toEqual(push);
  expect(Object.getOwnPropertyDescriptor(window.history, "replaceState")).toEqual(replace);
  fireEvent.click(view.getByRole("link", { name: "Breadcrumb" }));
  await waitFor(() => { expect(view.getByText("Destination")).toBeTruthy(); });
  view.unmount();
  expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
});
