import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { WorkspaceHealth } from "../src/components/WorkspaceConnections";

const originalFetch = globalThis.fetch;
const workspace = { id: "ws-health", attributes: { name: "production", "assessments-enabled": true, permissions: { "can-update": false } } };
afterEach((): void => { cleanup(); globalThis.fetch = originalFetch; });

test("health art distinguishes verified health, uncertain checks, and unavailable data", async (): Promise<void> => {
  const attributes = { status: "completed", drifted: false, "all-checks-succeeded": true, "checks-passed": 2, "checks-failed": 0, "checks-errored": 0, "checks-unknown": 0 };
  const response = mock(async (): Promise<Response> => Response.json({ data: [{ id: "assessment-1", attributes }] }));
  // SAFETY: the mock implements the assessment-results response consumed here.
  globalThis.fetch = response as unknown as typeof fetch;
  const view = render(<WorkspaceHealth workspace={workspace} onSaved={(): undefined => undefined} />);
  await waitFor((): void => { expect(view.getByText("Everything healthy")).toBeTruthy(); });
  expect(view.container.querySelector('[data-pose="healthy"]')).not.toBeNull();
  cleanup();

  attributes["checks-unknown"] = 1;
  const uncertain = render(<WorkspaceHealth workspace={workspace} onSaved={(): undefined => undefined} />);
  await waitFor((): void => { expect(uncertain.getByText("completed")).toBeTruthy(); });
  expect(uncertain.queryByText("Everything healthy")).toBeNull();
  cleanup();

  response.mockImplementation(async (): Promise<Response> => new Response("Unavailable", { status: 503 }));
  const unavailable = render(<WorkspaceHealth workspace={workspace} onSaved={(): undefined => undefined} />);
  await waitFor((): void => { expect(unavailable.getByRole("alert").textContent).toContain("could not be loaded"); });
  expect(unavailable.queryByText("No health assessment has run yet.")).toBeNull();
  expect(unavailable.container.querySelector('[data-pose]')).toBeNull();
});
