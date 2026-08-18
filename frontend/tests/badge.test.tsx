import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { Badge } from "../src/components/ui/badge";

const classNameOf = (ui: ReactElement): string => {
  const { container } = render(ui);
  const el = container.querySelector("span[class]");
  return el?.className ?? "";
};

describe("Badge", (): void => {
  it("renders the child content", (): void => {
    const { container } = render(<Badge>Hello</Badge>);
    expect(container.textContent).toBe("Hello");
  });

  it("applies the default variant classes", (): void => {
    const className = classNameOf(<Badge>default</Badge>);
    expect(className).toContain("bg-primary");
    expect(className).toContain("text-primary-foreground");
  });

  it("applies the secondary variant classes", (): void => {
    const className = classNameOf(<Badge variant="secondary">secondary</Badge>);
    expect(className).toContain("bg-secondary");
    expect(className).toContain("text-secondary-foreground");
  });

  it("applies the destructive variant classes", (): void => {
    const className = classNameOf(<Badge variant="destructive">destructive</Badge>);
    expect(className).toContain("text-destructive");
    expect(className).toContain("bg-destructive/10");
    expect(className).toContain("border-destructive/20");
  });

  it("applies the outline variant classes", (): void => {
    const className = classNameOf(<Badge variant="outline">outline</Badge>);
    expect(className).toContain("border-border");
    expect(className).toContain("bg-background");
    expect(className).toContain("text-foreground");
  });

  it("merges a custom className through", (): void => {
    const className = classNameOf(<Badge className="my-custom-class">x</Badge>);
    expect(className).toContain("my-custom-class");
  });

  it("forwards extra span attributes", (): void => {
    const { container } = render(<Badge data-testid="badge" aria-label="label">x</Badge>);
    const el = container.querySelector('[data-testid="badge"]');
    expect(el?.getAttribute("aria-label")).toBe("label");
  });
});