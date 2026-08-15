import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";

import { useUnsavedChangesWarning } from "../src/lib/use-unsaved-changes";

afterEach((): void => {
  cleanup();
// SAFETY: the test stubs the global with a mock before exercising the component.
  (window as { confirm?: unknown }).confirm = undefined;
  window.history.replaceState(null, "", "/");
});

/**
 * The hook guards window.history pushState/replaceState, so these tests must
 * navigate through the real BrowserRouter (MemoryRouter keeps its own history
 * and would bypass the guard entirely).
 */
function renderWithBrowserRouter(routes: {
  form: React.JSX.Element;
  elsewhere: React.JSX.Element;
}): ReturnType<typeof render> {
  return render(
    <BrowserRouter>
      <Routes>
        <Route path="/" element={routes.form} />
        <Route path="/elsewhere" element={routes.elsewhere} />
      </Routes>
    </BrowserRouter>,
  );
}

test("route navigation away from a dirty form asks for confirmation (kanban 26.18)", async () => {
  const confirmMock = mock((): boolean => false);
// SAFETY: the test stubs the global with a mock before exercising the component.
  (window as { confirm?: unknown }).confirm = confirmMock;

  function DirtyForm(): React.JSX.Element {
    useUnsavedChangesWarning(true, "You have unsaved changes.");
    return (
      <div>
        <Link to="/elsewhere">Leave</Link>
      </div>
    );
  }

  const view = renderWithBrowserRouter({
    form: <DirtyForm />,
    elsewhere: <p>Destination</p>,
  });

  fireEvent.click(view.getByRole("link", { name: "Leave" }));
  await waitFor((): void => {
    expect(confirmMock).toHaveBeenCalledWith("You have unsaved changes.");
  });
  // Declined: still on the form, destination never rendered.
  expect(view.getByRole("link", { name: "Leave" })).toBeTruthy();
  expect(view.queryByText("Destination")).toBeNull();
  expect(window.location.pathname).toBe("/");
});

test("clean form navigates without confirmation (kanban 26.18)", async () => {
  const confirmMock = mock((): boolean => true);
// SAFETY: the test stubs the global with a mock before exercising the component.
  (window as { confirm?: unknown }).confirm = confirmMock;

  function CleanForm(): React.JSX.Element {
    useUnsavedChangesWarning(false);
    return (
      <div>
        <Link to="/elsewhere">Leave</Link>
      </div>
    );
  }

  const view = renderWithBrowserRouter({
    form: <CleanForm />,
    elsewhere: <p>Destination</p>,
  });

  fireEvent.click(view.getByRole("link", { name: "Leave" }));
  await waitFor((): void => {
    expect(view.getByText("Destination")).toBeTruthy();
  });
  expect(confirmMock).not.toHaveBeenCalled();
});

test("browser unload with unsaved changes registers a beforeunload guard (kanban 26.18)", async () => {
// SAFETY: the test stubs the global with a mock before exercising the component.
  (window as { confirm?: unknown }).confirm = mock((): boolean => true);

  function WithGuard(): React.JSX.Element {
    useUnsavedChangesWarning(true);
    return <p>Form</p>;
  }

  const view = renderWithBrowserRouter({
    form: <WithGuard />,
    elsewhere: <p>X</p>,
  });

  // A cancelable beforeunload event must be prevented while the form is dirty.
  const blocked = new Event("beforeunload", { cancelable: true });
  expect(window.dispatchEvent(blocked)).toBe(false);
  expect(blocked.defaultPrevented).toBeTrue();

  view.unmount();
  // After unmount the guard is removed: the same event is no longer cancelled.
  const unblocked = new Event("beforeunload", { cancelable: true });
  expect(window.dispatchEvent(unblocked)).toBe(true);
});

test("confirmed navigation proceeds to the destination (kanban 26.18)", async () => {
  const confirmMock = mock((): boolean => true);
// SAFETY: the test stubs the global with a mock before exercising the component.
  (window as { confirm?: unknown }).confirm = confirmMock;

  function DirtyForm(): React.JSX.Element {
    useUnsavedChangesWarning(true, "You have unsaved changes.");
    return (
      <div>
        <Link to="/elsewhere">Leave</Link>
      </div>
    );
  }

  const view = renderWithBrowserRouter({
    form: <DirtyForm />,
    elsewhere: <p>Destination</p>,
  });

  fireEvent.click(view.getByRole("link", { name: "Leave" }));
  await waitFor((): void => {
    expect(view.getByText("Destination")).toBeTruthy();
  });
  expect(confirmMock).toHaveBeenCalledWith("You have unsaved changes.");
});
