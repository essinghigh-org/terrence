import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { StatusBadge } from "../src/components/ui/status-badge";

const classNameOf = (status: string): string => {
  const { container } = render(<StatusBadge status={status} />);
  const el = container.querySelector("span[class]");
  const elEl = el as unknown as { className: string } | null;
  return elEl?.className ?? "";
};

describe("StatusBadge", (): void => {
  it("renders an em-dash placeholder when no status is given", (): void => {
    const { container } = render(<StatusBadge />);
    expect(container.textContent).toBe("—");
  });

  it("renders an em-dash placeholder for an empty status", (): void => {
    const { container } = render(<StatusBadge status="" />);
    expect(container.textContent).toBe("—");
  });

  it("formats an underscored status into a title-cased label", (): void => {
    const { container } = render(<StatusBadge status="planned_and_finished" />);
    expect(container.textContent).toContain("Planned And Finished");
  });

  it("keeps Needs Confirmation as a special label", (): void => {
    const { container } = render(<StatusBadge status="needs_confirmation" />);
    expect(container.textContent).toContain("Needs Confirmation");
  });

  it("styles running/planning statuses as active", (): void => {
    for (const status of ["planning", "applying", "pending", "policy_checking"]) {
      expect(classNameOf(status)).toContain("text-primary");
      expect(classNameOf(status)).toContain("bg-primary/10");
    }
  });

  it("styles finished statuses as success", (): void => {
    for (const status of ["applied", "planned_and_finished", "cost_estimated"]) {
      const className = classNameOf(status);
      expect(className).toContain("text-success");
      expect(className).toContain("bg-success/10");
    }
  });

  it("styles attention/confirmation statuses as warning", (): void => {
    for (const status of ["planned", "needs_confirmation", "policy_soft_failed"]) {
      expect(classNameOf(status)).toContain("text-warning");
    }
  });

  it("styles errored / hard-failed / canceled as destructive", (): void => {
    for (const status of ["errored", "policy_hard_failed", "canceled"]) {
      expect(classNameOf(status)).toContain("text-destructive");
    }
  });

  it("styles discarded as muted", (): void => {
    expect(classNameOf("discarded")).toContain("text-muted-foreground");
  });
});