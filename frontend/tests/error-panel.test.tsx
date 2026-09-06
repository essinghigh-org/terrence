import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ErrorPanel } from "../src/components/ui/error-panel";
import { ApiError } from "../src/lib/api";

afterEach((): void => {
  cleanup();
});

test("renders the message inside a role=alert container (kanban 14.12)", () => {
  const view = render(<ErrorPanel message="Failed to load workspaces." />);
  const alert = view.getByRole("alert");
  expect(alert.textContent).toContain("Failed to load workspaces.");
  // No retry affordance when onRetry is absent.
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("fires the retry handler when provided", () => {
  let retried = 0;
  const view = render(
    <ErrorPanel
      title="Could not load runs"
      message="The server timed out."
      onRetry={(): void => { retried += 1; }}
    />,
  );
  expect(view.getByText("Could not load runs")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(retried).toBe(1);
});

test("shows a stable code and request reference for actionable diagnostics", () => {
  const view = render(
    <ErrorPanel
      title="Could not promote state"
      error={new ApiError(409, "State changed before promotion", {}, null, "STATE_SERIAL_CONFLICT", "req-state-123")}
    />,
  );
  expect(view.getByTestId("error-code").textContent).toContain("STATE_SERIAL_CONFLICT");
  expect(view.getByTestId("error-reference").textContent).toContain("req-state-123");
  expect(view.getByRole("button", { name: "Copy diagnostic details" })).toBeTruthy();
});
