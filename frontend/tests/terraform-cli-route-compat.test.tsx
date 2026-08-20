import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
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

test("existing static org route wins over the legacy compatibility route", async () => {
  // /app/acme/projects resolves to the Projects view, not the legacy
  // /app/:org/:workspace/... redirect space.
  const view = renderRoutes("/app/acme/projects");
  await waitFor((): void => {
    expect(view.getByLabelText("Current location").textContent).toBe("/app/acme/projects");
  });
});
