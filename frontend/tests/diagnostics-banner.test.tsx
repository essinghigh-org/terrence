import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { DiagnosticsBanner } from "../src/components/DiagnosticsBanner";

describe("DiagnosticsBanner", () => {
  it("opens compact diagnostics by default and preserves manual collapse on updates", () => {
    const diagnostics = [{ severity: "warning" as const, title: "Deprecated", body: "\n\non main.tf line 5\n\n\n  5: old = true\n\n" }];
    const { container, rerender } = render(<DiagnosticsBanner severity="warning" diagnostics={diagnostics} collapsible />);
    const disclosure = container.querySelector("details");
    expect(disclosure?.open).toBe(true);
    expect(container.querySelector("pre")?.textContent).toBe("on main.tf line 5\n  5: old = true");
    if (disclosure === null) throw new Error("Missing diagnostics disclosure");
    disclosure.open = false;
    rerender(<DiagnosticsBanner severity="warning" diagnostics={[...diagnostics]} collapsible />);
    expect(disclosure.open).toBe(false);
  });

  it("renders warnings with title and body", () => {
    const { getByText, container } = render(
      <DiagnosticsBanner
        severity="warning"
        diagnostics={[
          {
            severity: "warning",
            title: "Deprecated Parameter",
            body: "on main.tf line 5\n42: lifecycle {",
          },
        ]}
      />,
    );
    expect(getByText("Warnings")).toBeDefined();
    expect(getByText("Deprecated Parameter")).toBeDefined();
    expect(container.querySelector("pre")?.textContent).toBe("on main.tf line 5\n42: lifecycle {");
  });

  it("renders the error palette label for error severity", () => {
    const { getByText } = render(
      <DiagnosticsBanner
        severity="error"
        diagnostics={[{ severity: "error", title: "No value for required variable", body: "" }]}
      />,
    );
    expect(getByText("Diagnostics")).toBeDefined();
    expect(getByText("No value for required variable")).toBeDefined();
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<DiagnosticsBanner severity="warning" diagnostics={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders all diagnostics in order", () => {
    const { getAllByText } = render(
      <DiagnosticsBanner
        severity="warning"
        diagnostics={[
          { severity: "warning", title: "First", body: "" },
          { severity: "warning", title: "Second", body: "" },
        ]}
      />,
    );
    const items = getAllByText(/First|Second/);
    expect(items).toHaveLength(2);
  });
});
