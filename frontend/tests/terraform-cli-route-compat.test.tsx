import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { AppRoutes } from "../src/App";
import { setAuthToken } from "../src/lib/api";

function CurrentLocation(): React.JSX.Element {
  const location = useLocation();
  return (
    <output aria-label="Current location">
      {location.pathname}{location.search}{location.hash}
    </output>
  );
}

// Render the real application route tree under a MemoryRouter so we exercise the
// actual legacy-compatibility aliases and canonical-route precedence defined in App.tsx.
function renderRoutes(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Suspense fallback={null}>
        <AppRoutes />
      </Suspense>
      <CurrentLocation />
    </MemoryRouter>,
  );
}

beforeEach((): void => {
  // The /app/* subtree requires an authenticated session; supply an in-memory token.
  setAuthToken("test-token", null, false);
});

afterEach((): void => {
  cleanup();
  if (localStorage !== undefined) localStorage.clear();
});

test("redirects Terraform CLI legacy run URL to canonical workspace run URL", async () => {
  const view = renderRoutes("/app/acme/production/runs/run-123");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe(
      "/app/acme/workspaces/production/runs/run-123",
    );
  });
});

test("redirects legacy workspace runs list URL to canonical runs list", async () => {
  const view = renderRoutes("/app/acme/production/runs");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe(
      "/app/acme/workspaces/production/runs",
    );
  });
});

test("redirects legacy workspace variables URL to canonical variables page", async () => {
  const view = renderRoutes("/app/acme/production/variables");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe(
      "/app/acme/workspaces/production/variables",
    );
  });
});

test("preserves query string and fragment on legacy run URL redirect", async () => {
  const view = renderRoutes("/app/acme/production/runs/run-123?foo=bar#plan");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe(
      "/app/acme/workspaces/production/runs/run-123?foo=bar#plan",
    );
  });
});

test("encodes workspace and run id route parameters in the redirect", async () => {
  const view = renderRoutes("/app/acme/my%20workspace/runs/run-%40123");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe(
      "/app/acme/workspaces/my%20workspace/runs/run-%40123",
    );
  });
});

test("canonical URLs are unaffected by the legacy aliases", async () => {
  const view = renderRoutes("/app/acme/workspaces/production/runs/run-123");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe(
      "/app/acme/workspaces/production/runs/run-123",
    );
  });
});

test("static-segment ranking protects canonical route from legacy alias collision", async () => {
  // /app/acme/projects/runs collides with BOTH route patterns:
  //   :orgName/projects/:projectId       (canonical — static "projects" segment)
  //   :orgName/:workspaceName/runs        (legacy CLI alias — dynamic :workspaceName)
  // React Router ranks the static "projects" segment above the dynamic
  // :workspaceName, so the canonical project route wins and no <Navigate>
  // redirect fires. If the legacy alias had won, the location would have
  // been rewritten to /app/acme/workspaces/projects/runs.
  const view = renderRoutes("/app/acme/projects/runs");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe(
      "/app/acme/projects/runs",
    );
  });
});

test("a legacy redirect shows a one-time dismissible notice (issue #641)", async () => {
  sessionStorage.clear();
  const view = renderRoutes("/app/acme/production/runs/run-123");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe(
      "/app/acme/workspaces/production/runs/run-123",
    );
  });
  // The notice names the legacy path that was replaced.
  const notice = await view.findByText(/You followed a Terraform CLI link/);
  expect(notice.textContent).toContain("/app/acme/production/runs/run-123");
  // Dismissing removes it, and the consumed flag does not come back.
  fireEvent.click(view.getByRole("button", { name: "Dismiss redirect notice" }));
  expect(view.queryByText(/You followed a Terraform CLI link/)).toBeNull();
  expect(sessionStorage.getItem("terrence:legacy-url-redirect")).toBeNull();
});

test("canonical navigation shows no redirect notice (issue #641)", async () => {
  sessionStorage.clear();
  const view = renderRoutes("/app/acme/workspaces/production/runs/run-123");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe(
      "/app/acme/workspaces/production/runs/run-123",
    );
  });
  expect(view.queryByText(/You followed a Terraform CLI link/)).toBeNull();
});
