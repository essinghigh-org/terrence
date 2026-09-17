import { expect, spyOn, test } from "bun:test";
import { render } from "@testing-library/react";

import { ErrorBoundary } from "../src/components/ErrorBoundary";

function BrokenView(): React.JSX.Element {
  throw new Error("render failed");
}

test("shows a recoverable fallback when a view crashes", () => {
  const consoleError = spyOn(console, "error").mockImplementation((): void => {
    // React reports the captured render error in development.
  });

  try {
    const view = render(
      <ErrorBoundary>
        <BrokenView />
      </ErrorBoundary>,
    );

    expect(view.getByRole("alert").textContent).toContain("Something went wrong");
    expect(view.getByRole("button", { name: "Reload page" })).toBeTruthy();
  } finally {
    consoleError.mockRestore();
  }
});
