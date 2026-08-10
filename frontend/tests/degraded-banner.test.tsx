import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { DegradedBanner } from "../src/components/DegradedBanner";

describe("DegradedBanner (kanban 14.13)", () => {
  it("renders the title with an alert role", () => {
    const { getByRole, getByText } = render(<DegradedBanner title="Run history may be out of date." />);
    expect(getByRole("alert")).toBeDefined();
    expect(getByText("Run history may be out of date.")).toBeDefined();
  });

  it("omits the action button when no action is provided", () => {
    const { queryByRole } = render(<DegradedBanner title="Stale data" />);
    expect(queryByRole("button")).toBeNull();
  });

  it("fires onAction from the action button", () => {
    let clicked = 0;
    const { getByRole } = render(
      <DegradedBanner
        title="Stale data"
        actionLabel="Try again"
        onAction={(): void => { clicked += 1; }}
      />,
    );
    const button = getByRole("button");
    expect(button.textContent).toBe("Try again");
    button.click();
    expect(clicked).toBe(1);
  });
});