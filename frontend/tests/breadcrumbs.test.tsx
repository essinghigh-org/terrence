import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Breadcrumbs } from "../src/components/Breadcrumbs";

describe("Breadcrumbs (kanban 14.19)", () => {
  const items = [
    { label: "org-a", to: "/app/org-a" },
    { label: "ws-1", to: "/app/org-a/workspaces/ws-1" },
    { label: "Runs", to: "/app/org-a/workspaces/ws-1/runs" },
    { label: "run-abc" },
  ];

  it("renders all items with the last marked as the current page", () => {
    const { getByText, getByLabelText } = render(<MemoryRouter><Breadcrumbs items={items} /></MemoryRouter>);
    expect(getByLabelText("Breadcrumb")).toBeDefined();
    for (const item of items) {
      expect(getByText(item.label)).toBeDefined();
    }
    expect(getByText("run-abc").getAttribute("aria-current")).toBe("page");
  });

  it("renders ancestors as links and the current item as plain text", () => {
    const { getByText } = render(<MemoryRouter><Breadcrumbs items={items} /></MemoryRouter>);
    const orgLink = getByText("org-a").closest("a");
    expect(orgLink?.getAttribute("href")).toBe("/app/org-a");
    const runsLink = getByText("Runs").closest("a");
    expect(runsLink?.getAttribute("href")).toBe("/app/org-a/workspaces/ws-1/runs");
    expect(getByText("run-abc").closest("a")).toBeNull();
  });

  it("handles a single-item trail", () => {
    const { getByText } = render(<MemoryRouter><Breadcrumbs items={[{ label: "Home" }]} /></MemoryRouter>);
    expect(getByText("Home").getAttribute("aria-current")).toBe("page");
    expect(getByText("Home").closest("a")).toBeNull();
  });
});