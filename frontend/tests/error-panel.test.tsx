import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ErrorPanel } from "../src/components/ui/error-panel";

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