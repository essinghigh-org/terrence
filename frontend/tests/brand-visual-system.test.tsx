import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Terrence } from "../src/components/brand/Terrence";

const poses = ["welcome", "empty", "healthy", "failed", "lost", "maintenance", "guide"] as const;

test("Terrence exposes one explicit small detail tier for every canonical pose", (): void => {
  for (const pose of poses) {
    const full = render(<Terrence pose={pose} />);
    const fullSvg = full.container.querySelector("svg");
    expect(fullSvg?.getAttribute("data-pose")).toBe(pose);
    expect(fullSvg?.getAttribute("data-detail")).toBe("full");
    expect(fullSvg?.querySelector(".terrence-secondary-detail")).not.toBeNull();

    const small = render(<Terrence pose={pose} detail="small" />);
    const smallSvg = small.container.querySelector("svg");
    expect(smallSvg?.getAttribute("data-pose")).toBe(pose);
    expect(smallSvg?.getAttribute("data-detail")).toBe("small");
    expect(smallSvg?.querySelector(".terrence-secondary-detail")).toBeNull();
    expect(smallSvg?.getAttribute("viewBox")).toBe("0 0 320 280");
  }
});

test("the small tier keeps essential prop geometry", (): void => {
  const requiredProps = new Map([
    ["empty", "box"],
    ["healthy", undefined],
    ["failed", undefined],
    ["lost", "map"],
    ["maintenance", "wrench"],
    ["guide", "book"],
  ] as const);

  for (const [pose, prop] of requiredProps) {
    const view = render(<Terrence pose={pose} detail="small" />);
    const svg = view.container.querySelector("svg");
    if (prop !== undefined) expect(svg?.querySelector(`[data-prop="${prop}"]`)).not.toBeNull();
    if (pose === "healthy") expect(svg?.querySelector("path[d^=\"m209 213\"]")).not.toBeNull();
    if (pose === "failed") expect(svg?.querySelector("path[d^=\"m151 211\"]")).not.toBeNull();
  }
});
