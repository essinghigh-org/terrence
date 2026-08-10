import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { EmptyState } from "../src/components/EmptyState";

describe("EmptyState (kanban 14.11)", () => {
  it("renders title and description", () => {
    const { getByText } = render(
      <EmptyState title="No runs yet" description="There is no run history for this workspace." />,
    );
    expect(getByText("No runs yet")).toBeDefined();
    expect(getByText("There is no run history for this workspace.")).toBeDefined();
  });

  it("omits action and docs link when absent", () => {
    const { queryByRole, queryByText } = render(<EmptyState title="No results" />);
    expect(queryByRole("button")).toBeNull();
    expect(queryByText("Read the docs")).toBeNull();
  });

  it("fires onAction from the action button", () => {
    let clicked = 0;
    const { getByRole, getByText } = render(
      <EmptyState
        title="No runs yet"
        actionLabel="Start new run"
        onAction={(): void => { clicked += 1; }}
      />,
    );
    const button = getByRole("button");
    expect(button.textContent).toBe("Start new run");
    button.click();
    expect(clicked).toBe(1);
    expect(getByText("No runs yet")).toBeDefined();
  });

  it("renders a docs link when provided", () => {
    const { getByText } = render(
      <EmptyState title="No runs yet" docsHref="https://example.com/docs/runs" />,
    );
    const link = getByText("Read the docs");
    expect(link.getAttribute("href")).toBe("https://example.com/docs/runs");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});